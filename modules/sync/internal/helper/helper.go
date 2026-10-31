// Package helper distributes the reviewed, instance-scoped Bilibili helper.
package helper

import (
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Build the helper before compiling this package: make helper-build.
//
//go:embed dist/helper.user.js dist/release.json
var source embed.FS

// Version returns the release version of the embedded helper script.
func Version() (string, error) {
	data, err := source.ReadFile("dist/release.json")
	if err != nil {
		return "", fmt.Errorf("read helper release: %w", err)
	}
	var release struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &release); err != nil || release.Version == "" {
		return "", fmt.Errorf("invalid helper release metadata")
	}
	return release.Version, nil
}

// Handler generates installable code using only the validated deployment origin.
// Host and forwarding headers never select the helper's authority.
func Handler(origin string) (http.Handler, error) {
	u, err := url.Parse(origin)
	if err != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.ContainsAny(origin, "*\\\"'<>\r\n") || u.Scheme+"://"+u.Host != origin {
		return nil, fmt.Errorf("invalid helper origin")
	}
	code, err := source.ReadFile("dist/helper.user.js")
	if err != nil {
		return nil, fmt.Errorf("read helper: %w", err)
	}
	host := u.Hostname()
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	encoded, _ := json.Marshal(origin)
	release, err := source.ReadFile("dist/release.json")
	if err != nil {
		return nil, err
	}
	body := strings.NewReplacer("'{{ORIGIN}}'", string(encoded), "{{ORIGIN}}", origin, "{{MATCH}}", u.Scheme+"://"+host+"/*").Replace(string(code))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/userscripts/ovs-bilibili.version.json" {
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			if r.Method == http.MethodGet {
				_, _ = w.Write(release)
			} else if r.Method != http.MethodHead {
				w.WriteHeader(http.StatusMethodNotAllowed)
			}
			return
		}
		w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if r.Method == http.MethodGet {
			_, _ = w.Write([]byte(body))
		}
	}), nil
}
