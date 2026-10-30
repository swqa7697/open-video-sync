package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestEmbeddedShellAndAssetCaching(t *testing.T) {
	handler, err := Handler()
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"/", "/join", "/rooms/example"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, route, nil))
		if w.Code != 200 || !strings.Contains(w.Body.String(), `<div id="app">`) || w.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("embedded route %s: %d %q", route, w.Code, w.Body.String())
		}
	}
	bootstrap := httptest.NewRecorder()
	handler.ServeHTTP(bootstrap, httptest.NewRequest(http.MethodGet, "/appearance.js", nil))
	if bootstrap.Code != 200 || !strings.Contains(bootstrap.Header().Get("Content-Type"), "javascript") || bootstrap.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("appearance bootstrap unavailable or cached without revalidation: %d %v", bootstrap.Code, bootstrap.Header())
	}
	entries, err := assets.ReadDir("dist/assets")
	if err != nil || len(entries) == 0 {
		t.Fatalf("production assets missing: %v", err)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/assets/"+entries[0].Name(), nil))
	if w.Code != 200 || !strings.Contains(w.Header().Get("Cache-Control"), "immutable") {
		t.Fatal("hashed asset caching failed")
	}
	for _, route := range []string{"/assets/missing.js", "/assets/", "/missing.js"} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, route, nil))
		if w.Code != 404 {
			t.Fatalf("missing asset %s fell through to HTML", route)
		}
	}
}
