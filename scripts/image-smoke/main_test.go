package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// These HTTP boundaries must reject stale embedded versions even when the image starts.
func TestHTTPReleaseVersions(t *testing.T) {
	want := releaseVersions{Sync: "1.2.3", Web: "2.3.4", Helper: "3.4.5", Image: "ovs:v2026-11-02", Release: true, Commit: strings.Repeat("b", 40)}
	for _, tc := range []struct {
		name, path, stale string
	}{
		{"api", "/api/v1/version", ""},
		{"web", "/", ""},
		{"helper", "/userscripts/ovs-bilibili.user.js", ""},
		{"old-sync", "/api/v1/version", "1.2.3"},
		{"old-web-api", "/api/v1/version", "2.3.4"},
		{"old-helper-api", "/api/v1/version", "3.4.5"},
		{"old-image", "/api/v1/version", "ovs:v2026-11-02"},
		{"old-web-html", "/", "2.3.4"},
		{"old-userscript", "/userscripts/ovs-bilibili.user.js", "3.4.5"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body string
				switch r.URL.Path {
				case "/api/v1/version":
					raw, err := json.Marshal(want)
					if err != nil {
						t.Error(err)
					}
					body = string(raw)
					w.Header().Set("Cache-Control", "no-store")
				case "/":
					body = `<meta name="ovs-web-version" content="2.3.4"><div id="app"></div>`
				default:
					body = "// @name OVS Bilibili http://ovs.example\n// @version 3.4.5\nconst ORIGIN = \"http://ovs.example\";\n"
					w.Header().Set("Content-Type", "application/javascript")
				}
				if tc.stale != "" {
					body = strings.ReplaceAll(body, tc.stale, "0.0.0")
				}
				_, _ = w.Write([]byte(body))
			}))
			t.Cleanup(server.Close)
			err := request(context.Background(), server.Client(), server.URL, tc.path, 200, want)
			if (err != nil) != (tc.stale != "") {
				t.Fatalf("stale version %q: error = %v", tc.stale, err)
			}
		})
	}
}
