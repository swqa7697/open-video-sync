// Package userscripts distributes the reviewed, instance-scoped Bilibili helper.
package userscripts

import (
	"embed"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

//go:embed helper.user.js bridge-json.js release.json
var source embed.FS

// Handler generates installable code using only the validated deployment origin.
// Host and forwarding headers never select the helper's authority.
func Handler(origin string) (http.Handler, error) {
	u, err := url.Parse(origin)
	if err != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.ContainsAny(origin, "*\\\"'<>\r\n") || u.Scheme+"://"+u.Host != origin {
		return nil, fmt.Errorf("invalid helper origin")
	}
	code, err := source.ReadFile("helper.user.js")
	if err != nil {
		return nil, fmt.Errorf("read helper: %w", err)
	}
	parser, err := source.ReadFile("bridge-json.js")
	if err != nil {
		return nil, fmt.Errorf("read bridge parser: %w", err)
	}
	host := u.Hostname()
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	encoded, _ := json.Marshal(origin)
	release, err := source.ReadFile("release.json")
	if err != nil {
		return nil, err
	}
	var metadata struct {
		Version  string `json:"version"`
		Protocol int    `json:"protocol"`
	}
	if err := json.Unmarshal(release, &metadata); err != nil {
		return nil, err
	}
	body := strings.NewReplacer("{{HELPER_VERSION}}", metadata.Version, "/* OVS_BRIDGE_JSON */", strings.TrimPrefix(string(parser), "export "), "'{{ORIGIN}}'", string(encoded), "{{ORIGIN}}", origin, "{{MATCH}}", u.Scheme+"://"+host+"/*").Replace(string(code))
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
