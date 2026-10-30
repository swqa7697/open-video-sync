package http

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"

	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/identity"
)

// API serves authenticated application routes with bounded, safe transport errors.
type API struct {
	Origin   string
	Identity *identity.Service
	// TrustedProxies lists direct peers whose X-Forwarded-For header selects the client address
	// for address rate limits. Set it before serving; empty trusts no forwarding headers.
	TrustedProxies []netip.Prefix
	mux            *http.ServeMux
	limits         *limiter
}

// NewAPI constructs the identity routes. Room routes are installed by WithRooms.
func NewAPI(origin string, service *identity.Service) *API {
	a := &API{Origin: origin, Identity: service, mux: http.NewServeMux(), limits: &limiter{buckets: make(map[string]bucket), now: service.Now}}
	a.mux.HandleFunc("POST /api/v2/session", a.bootstrap)
	a.mux.HandleFunc("GET /api/v2/me", a.me)
	a.mux.HandleFunc("PATCH /api/v2/me", a.profile)
	a.mux.HandleFunc("DELETE /api/v2/session", a.forget)
	a.mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) { fail(w, contracts.Failure("not_found")) })
	return a
}

func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	a.mux.ServeHTTP(w, r.WithContext(ctx))
}
func respond(w http.ResponseWriter, value any) { _ = json.NewEncoder(w).Encode(value) }
func fail(w http.ResponseWriter, err error) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	code := "storage_unavailable"
	var failure contracts.Failure
	if errors.As(err, &failure) {
		code = string(failure)
	} else if errors.Is(err, context.DeadlineExceeded) {
		code = "busy"
	}
	status := 503
	message := "Storage unavailable."
	retry := true
	switch code {
	case "invalid_input":
		status = 400
		message = "Invalid request."
		retry = false
	case "session_required":
		status = 401
		message = "Session required."
		retry = false
	case "forbidden":
		status = 403
		message = "Action denied."
		retry = false
	case "not_found":
		status = 404
		message = "Room unavailable."
		retry = false
	case "invalid_invitation":
		status = 404
		message = "Invitation unavailable."
		retry = false
	case "upgrade_required":
		status = 409
		message = "Reload to use the updated application."
		retry = false
	case "request_outcome_unknown":
		status = 409
		message = "Request recovery expired. Refresh your rooms before choosing a new action."
		retry = false
	case "invitation_reset_required":
		status = 409
		message = "Replace the legacy invitation before sharing."
		retry = false
	case "stale_state":
		status = 409
		message = "Room changed. Refresh before trying again."
		retry = false
	case "idempotency_conflict":
		status = 409
		message = "Request key already used."
		retry = false
	case "message_too_large":
		status = 413
		message = "Request too large."
		retry = false
	case "unsupported_content_type":
		status = 415
		message = "JSON required."
		retry = false
	case "rate_limited":
		status = 429
		message = "Too many requests. Try later."
	case "capacity_reached":
		status = 429
		message = "Capacity reached. Try later."
	case "busy":
		status = 503
		message = "Server busy. Try later."
	}
	id, _ := contracts.RandomID(rand.Reader)
	if retry {
		w.Header().Set("Retry-After", "5")
	}
	w.WriteHeader(status)
	respond(w, contracts.PublicError{Code: code, Message: message, RequestID: id, Retryable: retry})
}
func body(w http.ResponseWriter, r *http.Request) ([]byte, error) {
	media, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" || len(params) > 1 || (len(params) == 1 && !strings.EqualFold(params["charset"], "utf-8")) {
		return nil, contracts.Failure("unsupported_content_type")
	}
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, contracts.MaxMessageBytes))
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return nil, contracts.Failure("message_too_large")
		}
		return nil, contracts.Failure("invalid_input")
	}
	return b, nil
}
func emptyBody(w http.ResponseWriter, r *http.Request) error {
	b, err := body(w, r)
	if err != nil {
		return err
	}
	o, err := contracts.DecodeObject(b)
	if err != nil || len(o) != 0 {
		return contracts.Failure("invalid_input")
	}
	return nil
}
func cookieToken(r *http.Request) string {
	c, err := r.Cookie("ovs_session")
	if err != nil {
		return ""
	}
	return c.Value
}
func (a *API) cookie(w http.ResponseWriter, token string, expires int64) {
	maxAge := int((expires - a.Identity.Now().UnixMilli()) / 1000)
	if token == "" {
		maxAge = -1
	}
	http.SetCookie(w, &http.Cookie{Name: "ovs_session", Value: token, Path: "/", HttpOnly: true, Secure: strings.HasPrefix(a.Origin, "https://"), SameSite: http.SameSiteLaxMode, Expires: time.UnixMilli(expires), MaxAge: maxAge})
}
func sessionResponse(s identity.Session) any {
	return struct {
		Identity struct {
			IdentityID  string `json:"identityId"`
			DisplayName string `json:"displayName"`
		} `json:"identity"`
		CSRF    string `json:"csrfToken"`
		Expires int64  `json:"expiresAtMs"`
	}{Identity: struct {
		IdentityID  string `json:"identityId"`
		DisplayName string `json:"displayName"`
	}{s.IdentityID, s.DisplayName}, CSRF: s.CSRF, Expires: s.ExpiresAtMs}
}

// address returns the rate-limit client address. Behind a trusted proxy it is the rightmost
// untrusted X-Forwarded-For hop; an absent or malformed header falls back to the proxy itself.
func (a *API) address(r *http.Request) string {
	peer, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return "invalid"
	}
	proxy := peer.Addr().WithZone("").Unmap()
	if !a.trusted(proxy) {
		return proxy.String()
	}
	hops := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
	client := proxy
	for i := len(hops) - 1; i >= 0; i-- {
		hop, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil || hop.Zone() != "" {
			return proxy.String()
		}
		client = hop.Unmap()
		if !a.trusted(client) {
			return client.String()
		}
	}
	return client.String()
}
func (a *API) trusted(addr netip.Addr) bool {
	for _, prefix := range a.TrustedProxies {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}
func (a *API) origin(r *http.Request) error {
	if r.Header.Get("Origin") != a.Origin {
		return contracts.Failure("forbidden")
	}
	return nil
}
func (a *API) auth(r *http.Request) (identity.Session, error) {
	s, err := a.Identity.Authenticate(r.Context(), cookieToken(r))
	if err != nil {
		return s, err
	}
	if r.Method != "GET" {
		if err := a.origin(r); err != nil {
			return s, err
		}
		if !identity.CheckCSRF(s, r.Header.Get("X-OVS-CSRF")) {
			return s, contracts.Failure("forbidden")
		}
	}
	return s, nil
}
func (a *API) bootstrap(w http.ResponseWriter, r *http.Request) {
	if err := a.origin(r); err != nil {
		fail(w, err)
		return
	}
	if !a.limits.allow("bootstrap:"+a.address(r), 30, 10) {
		fail(w, contracts.Failure("rate_limited"))
		return
	}
	if err := emptyBody(w, r); err != nil {
		fail(w, err)
		return
	}
	s, token, renewed, err := a.Identity.Bootstrap(r.Context(), cookieToken(r))
	if err != nil {
		fail(w, err)
		return
	}
	if renewed {
		a.cookie(w, token, s.ExpiresAtMs)
	}
	respond(w, sessionResponse(s))
}
func (a *API) me(w http.ResponseWriter, r *http.Request) {
	s, err := a.auth(r)
	if err != nil {
		fail(w, err)
		return
	}
	respond(w, sessionResponse(s))
}
func (a *API) profile(w http.ResponseWriter, r *http.Request) {
	s, err := a.auth(r)
	if err != nil {
		fail(w, err)
		return
	}
	if !a.limits.allow("profile:"+s.IdentityID, 30, 10) {
		fail(w, contracts.Failure("rate_limited"))
		return
	}
	b, err := body(w, r)
	if err != nil {
		fail(w, err)
		return
	}
	patch, err := contracts.DecodeProfilePatch(b)
	if err != nil {
		fail(w, contracts.Failure("invalid_input"))
		return
	}
	s, err = a.Identity.Rename(r.Context(), s, patch)
	if err != nil {
		fail(w, err)
		return
	}
	respond(w, sessionResponse(s))
}
func (a *API) forget(w http.ResponseWriter, r *http.Request) {
	s, err := a.auth(r)
	if err != nil {
		fail(w, err)
		return
	}
	if err := emptyBody(w, r); err != nil {
		fail(w, err)
		return
	}
	if err := a.Identity.Forget(r.Context(), s); err != nil {
		fail(w, err)
		return
	}
	a.cookie(w, "", 0)
	respond(w, struct {
		Forgotten bool `json:"forgotten"`
	}{true})
}

type bucket struct {
	tokens       float64
	at, timeUsed time.Time
}
type limiter struct {
	mu      sync.Mutex
	buckets map[string]bucket
	now     func() time.Time
}

func (l *limiter) allow(key string, perMinute, burst float64) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b, ok := l.buckets[key]
	if !ok {
		if len(l.buckets) >= 4096 {
			for k, v := range l.buckets {
				if now.Sub(v.timeUsed) >= 10*time.Minute {
					delete(l.buckets, k)
				}
			}
		}
		if len(l.buckets) >= 4096 {
			return false
		}
		b = bucket{tokens: burst, at: now}
	}
	b.tokens = min(burst, b.tokens+max(0, now.Sub(b.at).Seconds())*perMinute/60)
	b.at = now
	b.timeUsed = now
	allowed := b.tokens >= 1
	if allowed {
		b.tokens--
	}
	l.buckets[key] = b
	return allowed
}
