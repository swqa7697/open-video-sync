package http

import (
	"net/http"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/history"
)

// WithHistory installs private history routes before admission. History mutations
// never enter the room control path or affect its playback acknowledgements.
func (a *API) WithHistory(service *history.Service) *API {
	for _, pattern := range []string{
		"GET /api/v1/me/history", "POST /api/v1/me/history", "DELETE /api/v1/me/history",
		"DELETE /api/v1/me/history/{entryId}", "PATCH /api/v1/me/history/preferences",
	} {
		a.mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			p, err := a.auth(r)
			if err != nil {
				fail(w, err)
				return
			}
			if r.URL.RawQuery != "" {
				fail(w, contracts.Failure("invalid_input"))
				return
			}
			if r.Method != http.MethodGet && !a.limits.allow("history:"+p.IdentityID, 60, 20) {
				fail(w, contracts.Failure("rate_limited"))
				return
			}
			var state history.State
			switch r.Method {
			case http.MethodGet:
				state, err = service.List(p)
			case http.MethodPost:
				var data []byte
				data, err = body(w, r)
				if err == nil {
					var video contracts.HistoryVideo
					video, err = contracts.DecodeHistoryVideo(data)
					if err != nil {
						err = contracts.Failure("invalid_input")
					} else {
						state, err = service.Record(r.Context(), p, video)
					}
				}
			case http.MethodDelete:
				err = emptyBody(w, r)
				if err == nil {
					if id := r.PathValue("entryId"); id != "" {
						state, err = service.Delete(r.Context(), p, id)
					} else {
						state, err = service.Clear(r.Context(), p)
					}
				}
			case http.MethodPatch:
				var object map[string]any
				object, err = requestObject(w, r)
				if err == nil {
					enabled, ok := object["recordingEnabled"].(bool)
					if !ok || !exact(object, "recordingEnabled") {
						err = contracts.Failure("invalid_input")
					} else {
						state, err = service.SetRecording(r.Context(), p, enabled)
					}
				}
			}
			if err != nil {
				fail(w, err)
				return
			}
			respond(w, state)
		})
	}
	return a
}
