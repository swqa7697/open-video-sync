package http

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/storage"
)

type apiPeer struct{ token, csrf, id string }

func call(t *testing.T, a http.Handler, p apiPeer, method, path, payload string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, "http://watch.example"+path, strings.NewReader(payload))
	r.Header.Set("Origin", "http://watch.example")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-OVS-CSRF", p.csrf)
	if p.token != "" {
		r.AddCookie(&http.Cookie{Name: "ovs_session", Value: p.token})
	}
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	return w
}
func bootstrapPeer(t *testing.T, a http.Handler) apiPeer {
	t.Helper()
	w := call(t, a, apiPeer{}, "POST", "/api/v2/session", "{}")
	if w.Code != 200 {
		t.Fatalf("bootstrap: %d %s", w.Code, w.Body)
	}
	var response struct {
		Identity  struct{ IdentityID string }
		CSRFToken string
	}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	return apiPeer{w.Result().Cookies()[0].Value, response.CSRFToken, response.Identity.IdentityID}
}
func TestIdentityLifecycleAndBoundary(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store, err := storage.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	now := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
	service := &identity.Service{Repository: store, Now: func() time.Time { return now }, Random: rand.Reader}
	a := NewAPI("http://watch.example", service)
	wantVersions := Versions{Sync: "1.2.3", Web: "2.3.4", Helper: "3.4.5", Commit: strings.Repeat("a", 40), Dirty: true, Tag: "v1.2.3"}
	a.WithVersions(wantVersions)
	release := call(t, a, apiPeer{}, "GET", "/api/v2/version", "")
	var versions Versions
	if err := json.Unmarshal(release.Body.Bytes(), &versions); err != nil {
		t.Fatal(err)
	}
	if release.Code != 200 || versions != wantVersions || release.Header().Get("Cache-Control") != "no-store" || len(release.Result().Cookies()) != 0 {
		t.Fatalf("public release metadata: %d %s", release.Code, release.Body)
	}
	p := bootstrapPeer(t, a)
	q := bootstrapPeer(t, a)
	if p.id == q.id {
		t.Fatal("profiles share identity")
	}
	w := call(t, a, p, "POST", "/api/v2/session", "{}")
	if len(w.Result().Cookies()) != 0 {
		t.Fatal("renewed within one day")
	}
	for _, body := range []string{`{"displayName":"a","displayName":"b"}`, `{"displayName":"a","cookie":"synthetic-secret"}`, `{"displayName":null}`, `{"displayName":"\ud800"}`} {
		if w := call(t, a, p, "PATCH", "/api/v2/me", body); w.Code != 400 {
			t.Fatalf("invalid profile accepted: %d %s", w.Code, w.Body)
		}
	}
	bad := p
	bad.csrf = "wrong"
	if w := call(t, a, bad, "PATCH", "/api/v2/me", `{"displayName":"wrong"}`); w.Code != 403 {
		t.Fatal("wrong CSRF accepted")
	}
	r := httptest.NewRequest("POST", "http://watch.example/api/v2/session", strings.NewReader("{}"))
	r.Header.Set("Origin", "https://attacker.example")
	r.Header.Set("Content-Type", "application/json")
	w = httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-origin bootstrap accepted")
	}
	w = call(t, a, p, "PATCH", "/api/v2/me", `{"displayName":"<b>😀</b>"}`)
	if w.Code != 200 {
		t.Fatal(w.Body)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = storage.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	service.Repository = store
	w = call(t, a, p, "GET", "/api/v2/me", "")
	if w.Code != 200 || !strings.Contains(w.Body.String(), p.id) || !strings.Contains(w.Body.String(), "😀") {
		t.Fatal("restart lost identity", w.Body)
	}
	now = now.Add(25 * time.Hour)
	w = call(t, a, p, "POST", "/api/v2/session", "{}")
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || cookies[0].Secure || cookies[0].Domain != "" || cookies[0].SameSite != http.SameSiteLaxMode {
		t.Fatal("invalid HTTP cookie")
	}
	a.Origin = "https://watch.example"
	w = httptest.NewRecorder()
	a.cookie(w, p.token, now.Add(365*24*time.Hour).UnixMilli())
	if !w.Result().Cookies()[0].Secure {
		t.Fatal("HTTPS cookie is insecure")
	}
	a.Origin = "http://watch.example"

	// Exercise a real TLS connection and cookie jar, not only the header attributes.
	secureAPI := NewAPI("", service)
	tlsServer := httptest.NewTLSServer(secureAPI)
	secureAPI.Origin = tlsServer.URL
	client := tlsServer.Client()
	client.Jar, _ = cookiejar.New(nil)
	req, _ := http.NewRequest("POST", tlsServer.URL+"/api/v2/session", strings.NewReader("{}"))
	req.Header.Set("Origin", tlsServer.URL)
	req.Header.Set("Content-Type", "application/json")
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || !response.Cookies()[0].Secure {
		t.Fatal("TLS bootstrap failed")
	}
	_ = response.Body.Close()
	response, err = client.Get(tlsServer.URL + "/api/v2/me")
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 {
		t.Fatal("HTTPS session cookie not retained")
	}
	_ = response.Body.Close()
	tlsServer.Close()

	revoked := false
	service.OnRevoked = func(string) { revoked = true }
	w = call(t, a, p, "DELETE", "/api/v2/session", "{}")
	if w.Code != 200 || !revoked {
		t.Fatal("revocation failed", w.Body)
	}
	if w := call(t, a, p, "GET", "/api/v2/me", ""); w.Code != 401 {
		t.Fatal("revoked token accepted")
	}
	now = now.Add(366 * 24 * time.Hour)
	if w := call(t, a, q, "GET", "/api/v2/me", ""); w.Code != 401 {
		t.Fatal("expired token accepted")
	}
	w = call(t, a, q, "POST", "/api/v2/session", "{}")
	if w.Code != 200 || strings.Contains(w.Body.String(), q.id) {
		t.Fatal("expired bootstrap reused identity")
	}
}

func TestStrictTransportAndAddressLimits(t *testing.T) {
	store, err := storage.Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	a := NewAPI("http://watch.example", &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader})
	p := bootstrapPeer(t, a)
	for _, tc := range []struct {
		body, content, origin string
		want                  int
	}{
		{"{}", "text/plain", "http://watch.example", 415},
		{strings.Repeat("x", 65537), "application/json", "http://watch.example", 413},
		{`{"displayName":"no"}`, "application/json", "http://attacker.example", 403},
		{`{"displayName":"no"} {}`, "application/json", "http://watch.example", 400},
	} {
		r := httptest.NewRequest("PATCH", "http://watch.example/api/v2/me", strings.NewReader(tc.body))
		r.Header.Set("Content-Type", tc.content)
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("X-OVS-CSRF", p.csrf)
		r.Header.Set("X-Request-ID", "attacker-data")
		r.AddCookie(&http.Cookie{Name: "ovs_session", Value: p.token})
		w := httptest.NewRecorder()
		a.ServeHTTP(w, r)
		var e map[string]any
		_ = json.Unmarshal(w.Body.Bytes(), &e)
		if w.Code != tc.want || len(e) != 4 || len(e["requestId"].(string)) != 32 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("transport: %d %s", w.Code, w.Body)
		}
	}
	for i := 0; i < 9; i++ {
		r := httptest.NewRequest("POST", "http://watch.example/api/v2/session", strings.NewReader("{}"))
		r.Header.Set("Origin", a.Origin)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Forwarded-For", string(rune('a'+i)))
		w := httptest.NewRecorder()
		a.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatal("premature limit", w.Body)
		}
	}
	if w := call(t, a, apiPeer{}, "POST", "/api/v2/session", "{}"); w.Code != 429 {
		t.Fatal("forwarding headers bypassed address limit", w.Code)
	}

	// Only a trusted peer's header selects the client; spoofed left hops share the real client's bucket.
	fixed := time.Date(2026, 10, 29, 0, 0, 0, 0, time.UTC)
	b := NewAPI("http://watch.example", &identity.Service{Repository: store, Now: func() time.Time { return fixed }, Random: rand.Reader})
	b.TrustedProxies = []netip.Prefix{netip.MustParsePrefix("192.0.2.0/24")}
	probe := func(peer string, forwarded ...string) int {
		r := httptest.NewRequest("POST", "http://watch.example/api/v2/session", strings.NewReader("{}"))
		r.RemoteAddr = peer
		r.Header.Set("Origin", b.Origin)
		r.Header.Set("Content-Type", "text/plain")
		for _, value := range forwarded {
			r.Header.Add("X-Forwarded-For", value)
		}
		w := httptest.NewRecorder()
		b.ServeHTTP(w, r)
		return w.Code
	}
	const proxy = "192.0.2.1:1234"
	for i := range 10 {
		if code := probe(proxy, fmt.Sprintf("203.0.113.%d, 198.51.100.7", i)); code != 415 {
			t.Fatalf("forwarded probe %d = %d", i, code)
		}
	}
	malformed := make([]string, 10)
	for i := range malformed {
		malformed[i] = "198.51.100.1, not-an-address"
	}
	for _, tc := range []struct {
		name      string
		peer      string
		forwarded []string
		want      int
	}{
		{"mapped client form", proxy, []string{"::ffff:198.51.100.7"}, 429},
		{"trusted hop skipped across lines", proxy, []string{"198.51.100.7", "192.0.2.9"}, 429},
		{"untrusted peer header ignored", "198.51.100.7:1", []string{"198.51.100.99"}, 429},
		{"distinct client bucket", proxy, []string{"198.51.100.8"}, 415},
	} {
		if code := probe(tc.peer, tc.forwarded...); code != tc.want {
			t.Fatalf("%s = %d, want %d", tc.name, code, tc.want)
		}
	}
	for _, value := range malformed {
		if code := probe(proxy, value); code != 415 {
			t.Fatalf("malformed header probe = %d", code)
		}
	}
	if code := probe(proxy); code != 429 {
		t.Fatalf("absent header did not share the proxy bucket with malformed headers: %d", code)
	}
	if code := probe(proxy, "192.0.2.50"); code != 415 {
		t.Fatalf("all-trusted chain did not use its leftmost hop: %d", code)
	}
}
