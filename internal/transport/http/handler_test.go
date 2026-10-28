package http

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRoutingReadinessAndHostBoundary(t *testing.T) {
	var storageErr error
	frontend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "SPA") })
	handler := NewHandler("watch.example.com", func(context.Context) error { return storageErr }, frontend)
	for _, tc := range []struct {
		path string
		code int
	}{
		{"/", 200}, {"/join", 200}, {"/health/live", 204}, {"/health/ready", 204},
		{"/api", 404}, {"/api/v1/session", 404}, {"/api/v1/rooms/test/ws", 404}, {"/health/missing", 404}, {"/ws", 404}, {"/ws/missing", 404},
	} {
		r := httptest.NewRequest(http.MethodGet, "http://watch.example.com"+tc.path, nil)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != tc.code || (tc.code == 404 && strings.Contains(w.Body.String(), "SPA")) {
			t.Errorf("%s: code=%d body=%q", tc.path, w.Code, w.Body.String())
		}
		if w.Header().Get("Referrer-Policy") != "no-referrer" || w.Header().Get("Content-Security-Policy") == "" {
			t.Errorf("%s: privacy headers missing", tc.path)
		}
	}
	storageErr = errors.New("private storage failure")
	for path, want := range map[string]int{"/health/ready": 503, "/health/live": 204} {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "http://watch.example.com"+path, nil))
		if w.Code != want || strings.Contains(w.Body.String(), storageErr.Error()) {
			t.Fatalf("health boundary: code=%d body=%q", w.Code, w.Body.String())
		}
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "http://attacker.example/", nil)
	r.Header.Set("X-Forwarded-Host", "watch.example.com")
	handler.ServeHTTP(w, r)
	if w.Code != http.StatusMisdirectedRequest {
		t.Fatal("foreign Host or untrusted forwarded host accepted")
	}
}
