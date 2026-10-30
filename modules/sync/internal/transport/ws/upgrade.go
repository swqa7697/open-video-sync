// Package ws provides authenticated room sockets and bounded WebSocket transport.
package ws

import (
	"errors"
	"net/http"

	"github.com/coder/websocket"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
)

// Accept upgrades a browser connection after exact-origin validation.
// The caller MUST authorize the session, membership, and admission limits first.
// The caller owns reads, writes, cancellation, and closing the connection.
func Accept(w http.ResponseWriter, r *http.Request, publicOrigin string) (*websocket.Conn, error) {
	if publicOrigin == "" || r.Header.Get("Origin") != publicOrigin {
		http.Error(w, "origin denied", http.StatusForbidden)
		return nil, errors.New("WebSocket origin denied")
	}
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The library's host-pattern check cannot enforce scheme equality.
		// Exact scheme and host were checked above against validated config.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return nil, err
	}
	conn.SetReadLimit(contracts.MaxMessageBytes)
	return conn, nil
}
