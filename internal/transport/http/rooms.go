package http

import (
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"

	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/identity"
	"github.com/swqa7697/open-video-sync/internal/rooms"
)

// WithRooms registers the management API using the shared room mutation service.
func (a *API) WithRooms(service *rooms.Service) *API {
	a.mux.HandleFunc("GET /api/v1/rooms", func(w http.ResponseWriter, r *http.Request) {
		p, err := a.auth(r)
		if err != nil {
			fail(w, err)
			return
		}
		query, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil {
			fail(w, contracts.Failure("invalid_input"))
			return
		}
		limit := 20
		for key, values := range query {
			if (key != "cursor" && key != "limit") || len(values) != 1 {
				fail(w, contracts.Failure("invalid_input"))
				return
			}
		}
		if raw := query.Get("limit"); raw != "" {
			limit, err = strconv.Atoi(raw)
		}
		if err != nil {
			fail(w, contracts.Failure("invalid_input"))
			return
		}
		list, next, err := service.List(r.Context(), p, query.Get("cursor"), limit)
		if err != nil {
			fail(w, err)
			return
		}
		respond(w, map[string]any{"rooms": list, "nextCursor": next})
	})
	a.mux.HandleFunc("POST /api/v1/rooms", func(w http.ResponseWriter, r *http.Request) {
		p, err := a.roomAuth(r)
		if err != nil {
			fail(w, err)
			return
		}
		if !a.limits.allow("create-id:"+p.IdentityID, 5, 5) || !a.limits.allow("create-address:"+address(r), 5, 5) {
			fail(w, contracts.Failure("rate_limited"))
			return
		}
		o, err := requestObject(w, r)
		if err != nil {
			fail(w, err)
			return
		}
		title, ok := o["title"].(string)
		settings, err := decodeSettings(o["settings"])
		if !exact(o, "title", "settings") || !ok || !contracts.ValidTitle(title) || err != nil {
			fail(w, contracts.Failure("invalid_input"))
			return
		}
		result, err := service.Create(r.Context(), p, r.Header.Get("Idempotency-Key"), title, settings)
		if err != nil {
			fail(w, err)
			return
		}
		respond(w, result)
	})
	a.mux.HandleFunc("POST /api/v1/invitations/redeem", func(w http.ResponseWriter, r *http.Request) {
		p, err := a.roomAuth(r)
		if err != nil {
			fail(w, err)
			return
		}
		if !a.limits.allow("redeem-id:"+p.IdentityID, 10, 10) || !a.limits.allow("redeem-address:"+address(r), 10, 10) {
			fail(w, contracts.Failure("rate_limited"))
			return
		}
		o, err := requestObject(w, r)
		if err != nil {
			fail(w, err)
			return
		}
		kind := "link"
		secret, ok := o["linkSecret"].(string)
		if !exact(o, "linkSecret") {
			kind = "code"
			secret, ok = o["code"].(string)
			if !exact(o, "code") {
				ok = false
			}
		}
		if !ok {
			fail(w, contracts.Failure("invalid_input"))
			return
		}
		result, err := service.Redeem(r.Context(), p, r.Header.Get("Idempotency-Key"), kind, secret)
		if err != nil {
			fail(w, err)
			return
		}
		respond(w, map[string]any{"snapshot": result.Snapshot, "replayed": result.Replayed})
	})
	a.mux.HandleFunc("GET /api/v1/rooms/{roomId}", func(w http.ResponseWriter, r *http.Request) {
		p, err := a.auth(r)
		if err != nil {
			fail(w, err)
			return
		}
		snapshot, err := service.Snapshot(r.Context(), p, r.PathValue("roomId"))
		if err != nil {
			fail(w, err)
			return
		}
		respond(w, snapshot)
	})
	for pattern, operation := range map[string]string{"PATCH /api/v1/rooms/{roomId}/settings": "settings", "POST /api/v1/rooms/{roomId}/invitations": "rotate", "DELETE /api/v1/rooms/{roomId}/members/{memberId}": "remove", "DELETE /api/v1/rooms/{roomId}": "close"} {
		a.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			p, err := a.roomAuth(r)
			if err != nil {
				fail(w, err)
				return
			}
			o, err := requestObject(w, r)
			if err != nil {
				fail(w, err)
				return
			}
			fields := []string{"epoch", "expectedRevision"}
			m := rooms.Mutation{Operation: operation, MemberID: r.PathValue("memberId")}
			if operation == "settings" {
				fields = append(fields, "settings")
				m.Settings, err = decodeSettings(o["settings"])
			}
			var ok bool
			m.Epoch, ok = o["epoch"].(string)
			revision, num := o["expectedRevision"].(json.Number)
			m.ExpectedRevision, _ = revision.Int64()
			if !exact(o, fields...) || err != nil || !ok || !num || !contracts.ValidID(m.Epoch) || m.ExpectedRevision < 1 || m.ExpectedRevision > contracts.MaxSafeInteger || (operation == "remove" && !contracts.ValidID(m.MemberID)) {
				fail(w, contracts.Failure("invalid_input"))
				return
			}
			result, receipt, err := service.Mutate(r.Context(), p, r.PathValue("roomId"), m)
			if err != nil {
				fail(w, err)
				return
			}
			switch operation {
			case "remove", "close":
				respond(w, receipt)
			case "rotate":
				respond(w, map[string]any{"snapshot": result.Snapshot, "invitation": result.Invitation})
			default:
				respond(w, map[string]any{"snapshot": result.Snapshot})
			}
		})
	}
	return a
}
func (a *API) roomAuth(r *http.Request) (identity.Session, error) {
	p, err := a.auth(r)
	if err == nil && !a.limits.allow("manage:"+p.IdentityID, 60, 20) {
		err = contracts.Failure("rate_limited")
	}
	return p, err
}
func requestObject(w http.ResponseWriter, r *http.Request) (map[string]any, error) {
	b, err := body(w, r)
	if err != nil {
		return nil, err
	}
	o, err := contracts.DecodeObject(b)
	if err != nil {
		return nil, contracts.Failure("invalid_input")
	}
	return o, nil
}
func exact(o map[string]any, fields ...string) bool {
	if len(o) != len(fields) {
		return false
	}
	for _, field := range fields {
		if _, exists := o[field]; !exists {
			return false
		}
	}
	return true
}
func decodeSettings(value any) (contracts.RoomSettings, error) {
	b, err := json.Marshal(value)
	if err != nil {
		return contracts.RoomSettings{}, err
	}
	return contracts.DecodeRoomSettings(b)
}
