// Package web embeds the production frontend and serves SPA routes.
package web

import (
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// Build the frontend before compiling this package: make web-build.
//
//go:embed dist
var assets embed.FS

// Version returns the release version of the embedded frontend.
func Version() (string, error) {
	data, err := assets.ReadFile("dist/release.json")
	if err != nil {
		return "", fmt.Errorf("read frontend release: %w", err)
	}
	var release struct {
		Version string `json:"version"`
	}
	if err := json.Unmarshal(data, &release); err != nil || release.Version == "" {
		return "", fmt.Errorf("invalid frontend release metadata")
	}
	return release.Version, nil
}

// Handler serves hashed assets and HTML with separate cache policies.
// The transport router must reserve API, health, and WebSocket paths first.
func Handler() (http.Handler, error) {
	root, err := fs.Sub(assets, "dist")
	if err != nil {
		return nil, fmt.Errorf("open embedded frontend: %w", err)
	}
	if _, err := fs.Stat(root, "index.html"); err != nil {
		return nil, fmt.Errorf("frontend entry missing; run make web-build: %w", err)
	}
	files := http.FileServer(http.FS(root))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.Header().Set("Allow", "GET, HEAD")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		// The blocking appearance bootstrap must load before CSS to avoid a theme flash.
		// It has a stable URL, so revalidate it like HTML instead of caching it forever.
		if name == "appearance.js" {
			w.Header().Set("Cache-Control", "no-cache")
			files.ServeHTTP(w, r)
			return
		}
		if name == "assets" || strings.HasPrefix(name, "assets/") {
			info, err := fs.Stat(root, name)
			if err != nil || info.IsDir() {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			files.ServeHTTP(w, r)
			return
		}
		if name != "" && name != "." && name != "index.html" && path.Ext(name) != "" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		cloned := r.Clone(r.Context())
		cloned.URL.Path = "/"
		files.ServeHTTP(w, cloned)
	}), nil
}
