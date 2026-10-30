// Package smoke holds container smoke-check helpers for the version-2 API and room socket.
// Clients carry isolated test credentials only; callers must not print them.
package smoke

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/rooms"
)

// Run executes name with args and extra environment entries and returns trimmed combined output.
func Run(ctx context.Context, env []string, name string, args ...string) (string, error) {
	command := exec.CommandContext(ctx, name, args...)
	if len(env) > 0 {
		command.Env = append(os.Environ(), env...)
	}
	output, err := command.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s %s: %w: %s", name, strings.Join(args[:min(len(args), 2)], " "), err, output)
	}
	return strings.TrimSpace(string(output)), nil
}

// Docker runs one docker command.
func Docker(ctx context.Context, args ...string) (string, error) {
	return Run(ctx, nil, "docker", args...)
}

// StatusError reports a non-200 API response and its bounded public error code.
type StatusError struct {
	Method, Path string
	Status       int
	Code         string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("application %s %s returned %d %s", e.Method, e.Path, e.Status, e.Code)
}

// Client calls the version-2 API as one browser profile. Base selects the dialed scheme
// and address; Host and Origin carry the public origin that the server validates.
type Client struct {
	HTTP         *http.Client
	Base         string
	Host, Origin string
	Token, CSRF  string
	// Cookie is the latest ovs_session cookie set by the server, for attribute checks.
	Cookie *http.Cookie
}

// Call sends a JSON request with the session cookie, CSRF token, and a fresh Idempotency-Key.
func (c *Client) Call(ctx context.Context, method, path string, payload any) (map[string]json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var body io.Reader
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		body = strings.NewReader(string(b))
	}
	r, err := http.NewRequestWithContext(ctx, method, c.Base+"/api/v2"+path, body)
	if err != nil {
		return nil, err
	}
	r.Host = c.Host
	r.Header.Set("Origin", c.Origin)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-OVS-CSRF", c.CSRF)
	if c.Token != "" {
		r.AddCookie(&http.Cookie{Name: "ovs_session", Value: c.Token})
	}
	key := make([]byte, 16)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	r.Header.Set("Idempotency-Key", hex.EncodeToString(key))
	response, err := c.HTTP.Do(r)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	for _, cookie := range response.Cookies() {
		if cookie.Name == "ovs_session" {
			c.Token, c.Cookie = cookie.Value, cookie
		}
	}
	var value map[string]json.RawMessage
	decodeErr := json.NewDecoder(io.LimitReader(response.Body, contracts.MaxMessageBytes)).Decode(&value)
	if response.StatusCode != 200 {
		failure := &StatusError{Method: method, Path: path, Status: response.StatusCode}
		_ = json.Unmarshal(value["code"], &failure.Code)
		return nil, failure
	}
	return value, decodeErr
}

// Bootstrap creates or restores the identity and stores its CSRF token.
func (c *Client) Bootstrap(ctx context.Context) (string, error) {
	value, err := c.Call(ctx, "POST", "/session", struct{}{})
	if err != nil {
		return "", err
	}
	return c.acceptProfile(value)
}

// Me reads the current identity and refreshes the CSRF token.
func (c *Client) Me(ctx context.Context) (id, name string, err error) {
	value, err := c.Call(ctx, "GET", "/me", nil)
	if err != nil {
		return "", "", err
	}
	var profile struct{ IdentityID, DisplayName string }
	if err := json.Unmarshal(value["identity"], &profile); err != nil {
		return "", "", err
	}
	if _, err := c.acceptProfile(value); err != nil {
		return "", "", err
	}
	return profile.IdentityID, profile.DisplayName, nil
}

func (c *Client) acceptProfile(value map[string]json.RawMessage) (string, error) {
	var profile struct{ IdentityID string }
	if err := json.Unmarshal(value["identity"], &profile); err != nil {
		return "", err
	}
	if err := json.Unmarshal(value["csrfToken"], &c.CSRF); err != nil {
		return "", err
	}
	if profile.IdentityID == "" || c.Token == "" {
		return "", errors.New("session response lacked identity or cookie")
	}
	return profile.IdentityID, nil
}

// Snapshot reads one authorized room snapshot.
func (c *Client) Snapshot(ctx context.Context, roomID string) (rooms.Snapshot, error) {
	var snap rooms.Snapshot
	value, err := c.Call(ctx, "GET", "/rooms/"+roomID, nil)
	if err != nil {
		return snap, err
	}
	raw, err := json.Marshal(value)
	if err == nil {
		err = json.Unmarshal(raw, &snap)
	}
	return snap, err
}

// Dial opens the room socket with the session cookie and exact Origin.
func (c *Client) Dial(ctx context.Context, roomID string) (*websocket.Conn, error) {
	address := strings.Replace(c.Base, "http", "ws", 1) + "/ws/v2/rooms/" + roomID
	conn, _, err := websocket.Dial(ctx, address, &websocket.DialOptions{HTTPClient: c.HTTP, Host: c.Host, HTTPHeader: http.Header{"Origin": {c.Origin}, "Cookie": {"ovs_session=" + c.Token}}})
	return conn, err
}

// Frame is a server room envelope.
type Frame struct {
	Type    string
	Epoch   string
	Payload json.RawMessage
}

// Next reads the next room frame and answers server heartbeats so liveness never expires.
func Next(ctx context.Context, conn *websocket.Conn) (Frame, error) {
	for {
		_, b, err := conn.Read(ctx)
		if err != nil {
			return Frame{}, err
		}
		var f struct {
			Type, Epoch, RequestID string
			Payload                json.RawMessage
		}
		if json.Unmarshal(b, &f) != nil {
			return Frame{}, errors.New("invalid socket frame")
		}
		if f.Type == "heartbeat" {
			reply, _ := json.Marshal(map[string]any{"v": 2, "type": "heartbeat", "requestId": f.RequestID, "payload": map[string]bool{"reply": true}})
			if err := conn.Write(ctx, websocket.MessageText, reply); err != nil {
				return Frame{}, err
			}
			continue
		}
		return Frame{Type: f.Type, Epoch: f.Epoch, Payload: f.Payload}, nil
	}
}

// Welcome reads the session.welcome snapshot that starts every admitted connection.
func Welcome(ctx context.Context, conn *websocket.Conn) (rooms.Snapshot, error) {
	f, err := Next(ctx, conn)
	if err != nil {
		return rooms.Snapshot{}, err
	}
	var welcome struct{ Snapshot rooms.Snapshot }
	if f.Type != "session.welcome" || json.Unmarshal(f.Payload, &welcome) != nil {
		return rooms.Snapshot{}, fmt.Errorf("first room frame was %q, want session.welcome", f.Type)
	}
	return welcome.Snapshot, nil
}

// Command sends a mutation envelope against snap and waits for its command.result.
func Command(ctx context.Context, conn *websocket.Conn, snap rooms.Snapshot, kind string, payload any) (rooms.CommandResult, error) {
	var result rooms.CommandResult
	id, err := contracts.RandomID(rand.Reader)
	if err != nil {
		return result, err
	}
	frame, _ := json.Marshal(map[string]any{"v": 2, "type": kind, "commandId": id, "epoch": snap.Epoch, "expectedRevision": snap.Revision, "mediaGeneration": snap.MediaGeneration, "payload": payload})
	if err := conn.Write(ctx, websocket.MessageText, frame); err != nil {
		return result, err
	}
	for {
		f, err := Next(ctx, conn)
		if err != nil {
			return result, err
		}
		if f.Type != "command.result" {
			continue
		}
		if err := json.Unmarshal(f.Payload, &result); err != nil {
			return result, err
		}
		if result.CommandID == id {
			return result, nil
		}
	}
}
