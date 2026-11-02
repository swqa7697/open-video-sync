package ws

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func TestExactOriginUpgrade(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := Accept(w, r, "http://watch.example.com")
		if err != nil {
			return
		}
		defer conn.CloseNow()
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := conn.Write(ctx, websocket.MessageText, []byte("transport ready")); err != nil {
			return
		}
		_ = conn.Close(websocket.StatusNormalClosure, "done")
	}))
	defer server.Close()
	for _, origin := range []string{"", "https://watch.example.com", "http://watch.example.com.evil", "http://watch.example.com"} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		conn, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}}})
		if origin != "http://watch.example.com" {
			if err == nil {
				_ = conn.CloseNow()
				t.Fatal("foreign or missing origin accepted")
			}
			if response == nil || response.StatusCode != http.StatusForbidden {
				t.Fatalf("unexpected rejection: %v", err)
			}
		} else {
			if err != nil {
				t.Fatal(err)
			}
			kind, payload, err := conn.Read(ctx)
			if err != nil || kind != websocket.MessageText || string(payload) != "transport ready" {
				t.Fatalf("upgrade/read failed: %v", err)
			}
			_ = conn.Close(websocket.StatusNormalClosure, "done")
			if response.Header.Get("Sec-WebSocket-Extensions") != "" {
				t.Fatal("compression enabled")
			}
		}
		cancel()
	}
}
