// Package http provides OVS HTTP routing and transport policies.
package http

import (
	"context"
	"net/http"
	"time"
)

// NewHandler serves health and the web shell. Application routes remain absent.
// ready must return an error after shutdown admission closes or storage fails.
func NewHandler(publicHost string, ready func(context.Context) error, frontend http.Handler) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if ready(ctx) != nil {
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	// Reserve all service namespaces so absent routes never receive SPA HTML.
	for _, prefix := range []string{"/api", "/health", "/ws"} {
		mux.HandleFunc(prefix, http.NotFound)
		mux.HandleFunc(prefix+"/", http.NotFound)
	}
	mux.Handle("/", frontend)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		// Container probes may use loopback rather than the public host.
		if r.URL.Path != "/health/live" && r.URL.Path != "/health/ready" && r.Host != publicHost {
			http.Error(w, "host denied", http.StatusMisdirectedRequest)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
