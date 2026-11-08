package ws_test

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/rooms"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/storage"
	transport "github.com/swqa7697/open-video-sync/modules/sync/internal/transport/http"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/transport/ws"
)

type peer struct {
	conn *websocket.Conn
	seq  int64
}

func (p *peer) read(t *testing.T, kind string) json.RawMessage {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	for {
		typ, b, err := p.conn.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if typ != websocket.MessageText {
			t.Fatal("binary server frame")
		}
		var f struct {
			Type     string
			EventSeq int64
			Payload  json.RawMessage
		}
		if err := json.Unmarshal(b, &f); err != nil {
			t.Fatal(err)
		}
		// Liveness and clock frames are unsequenced.
		if f.Type == "heartbeat" || f.Type == "clock.pong" {
			if f.Type == kind {
				return f.Payload
			}
			continue
		}
		if f.EventSeq != p.seq+1 {
			t.Fatal("sequence gap", f.EventSeq, p.seq)
		}
		p.seq = f.EventSeq
		if f.Type == kind {
			return f.Payload
		}
	}
}
func (p *peer) send(t *testing.T, value any) {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := p.conn.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatal(err)
	}
}
func testKey() string { k, _ := contracts.RandomID(rand.Reader); return k }
func TestAuthenticatedTimelineNetworkRetriesTakeoverAndRestart(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	identities := &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader}
	service, err := rooms.NewService(store, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { service.Close() }()
	host, hostToken, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	guest, guestToken, _, _ := identities.Bootstrap(ctx, "")
	_, outsiderToken, _, _ := identities.Bootstrap(ctx, "")
	settings := contracts.DefaultSettings()
	settings.WaitForAll = false
	created, err := service.Create(ctx, host, testKey(), "Network", settings)
	if err != nil {
		t.Fatal(err)
	}
	joined, err := service.Redeem(ctx, guest, testKey(), "code", created.Invitation.Code)
	if err != nil {
		t.Fatal(err)
	}
	snap := joined.Snapshot
	var handler http.Handler
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(w, r) }))
	defer server.Close()
	sockets := ws.NewHandler(server.URL, identities, service)
	handler = transport.NewHandler(strings.TrimPrefix(server.URL, "http://"), store.Ready, http.NotFoundHandler(), transport.NewAPI(server.URL, identities).WithRooms(service), sockets)
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/v1/rooms/" + snap.RoomID
	dial := func(token, origin string) (*websocket.Conn, *http.Response, error) {
		t.Helper()
		return websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}, "Cookie": {"ovs_session=" + token}}})
	}
	for _, bad := range []struct {
		token, origin string
		status        int
	}{{"", server.URL, 401}, {outsiderToken, server.URL, 404}, {hostToken, "https://wrong.example", 403}} {
		conn, response, err := dial(bad.token, bad.origin)
		if err == nil {
			conn.CloseNow()
			t.Fatal("unauthorized socket admitted")
		}
		if response == nil || response.StatusCode != bad.status {
			t.Fatal("wrong admission error", response, err)
		}
	}
	connect := func(token string) *peer {
		t.Helper()
		conn, _, err := dial(token, server.URL)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { conn.CloseNow() })
		p := &peer{conn: conn}
		p.read(t, "session.welcome")
		return p
	}
	hp, gp := connect(hostToken), connect(guestToken)
	makeCommand := func(typ string, payload any) map[string]any {
		return map[string]any{"v": 1, "type": typ, "commandId": testKey(), "epoch": snap.Epoch, "mediaGeneration": snap.MediaGeneration, "expectedRevision": snap.Revision, "payload": payload}
	}
	media := contracts.MediaDescriptor{Kind: "local", FingerprintVersion: 1, Digest: strings.Repeat("a", 64), SizeBytes: 100, DurationMs: 60000}
	selected := makeCommand("media.select", map[string]any{"media": media})
	hp.send(t, selected)
	var accepted rooms.CommandResult
	json.Unmarshal(hp.read(t, "command.result"), &accepted)
	if !accepted.Accepted {
		t.Fatal("selection rejected", accepted)
	}
	json.Unmarshal(hp.read(t, "room.snapshot"), &snap)
	if snap.MediaGeneration != 1 || snap.Playback.Phase != "paused" {
		t.Fatal("missing authoritative media")
	}
	// An accepted retry carries old revision and generation, and returns the original committed receipt.
	hp.send(t, selected)
	var replay rooms.CommandResult
	json.Unmarshal(hp.read(t, "command.result"), &replay)
	if !replay.Accepted || *replay.Revision != *accepted.Revision {
		t.Fatal("lost-ACK retry committed twice")
	}
	selected["payload"] = map[string]any{"media": contracts.MediaDescriptor{Kind: "local", FingerprintVersion: 1, Digest: strings.Repeat("b", 64), SizeBytes: 100, DurationMs: 60000}}
	hp.send(t, selected)
	json.Unmarshal(hp.read(t, "command.result"), &replay)
	if replay.Accepted || replay.Error.Code != "invalid_command" {
		t.Fatal("changed retry accepted")
	}
	gp.send(t, makeCommand("playback.command", map[string]any{"action": "play"}))
	json.Unmarshal(gp.read(t, "command.result"), &replay)
	if replay.Accepted || replay.Error.Code != "forbidden" {
		t.Fatal("guest controlled host-only timeline")
	}
	// A real HTTP settings mutation races a real WS control from the same revision.
	cmd := makeCommand("playback.command", map[string]any{"action": "seek", "positionMs": 12000})
	body, _ := json.Marshal(map[string]any{"epoch": snap.Epoch, "expectedRevision": snap.Revision, "settings": settings})
	var wg sync.WaitGroup
	wg.Add(1)
	httpStatus := 0
	go func() {
		defer wg.Done()
		req, _ := http.NewRequest("PATCH", server.URL+"/api/v1/rooms/"+snap.RoomID+"/settings", strings.NewReader(string(body)))
		req.Header.Set("Origin", server.URL)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-OVS-CSRF", host.CSRF)
		req.AddCookie(&http.Cookie{Name: "ovs_session", Value: hostToken})
		response, err := http.DefaultClient.Do(req)
		if err == nil {
			httpStatus = response.StatusCode
			response.Body.Close()
		}
	}()
	hp.send(t, cmd)
	json.Unmarshal(hp.read(t, "command.result"), &replay)
	wg.Wait()
	if !((replay.Accepted && httpStatus == 409) || (!replay.Accepted && replay.Error.Code == "stale_state" && httpStatus == 200)) {
		t.Fatal("HTTP/WS race did not serialize", replay, httpStatus)
	}
	snap, err = service.Snapshot(ctx, host, snap.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	// The second page automatically replaces the old connection.
	second := connect(hostToken)
	hp.read(t, "session.replaced")
	second.send(t, makeCommand("playback.command", map[string]any{"action": "play"}))
	json.Unmarshal(second.read(t, "command.result"), &replay)
	if !replay.Accepted {
		t.Fatal("new connection rejected", replay)
	}
	snap, err = service.Snapshot(ctx, host, snap.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Playback.Phase != "playing" {
		t.Fatal("play not applied")
	}
	// Recreate runtime from the same SQLite metadata with a fresh epoch.
	oldEpoch := snap.Epoch
	service.Close()
	second.read(t, "server.stopping")
	shutdown, cancelShutdown := context.WithTimeout(ctx, 2*time.Second)
	defer cancelShutdown()
	if err := sockets.Shutdown(shutdown); err != nil {
		t.Fatal("socket workers survived shutdown", err)
	}
	service, err = rooms.NewService(store, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	restored, err := service.Snapshot(ctx, host, snap.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Epoch == oldEpoch || restored.Playback.Phase != "paused" || restored.Playback.DesiredPlaying || restored.MediaGeneration != 1 || restored.Revision != 1 {
		t.Fatal("restart extrapolated or lost accepted state", restored)
	}
}

func TestHeartbeatsArriveWellInsideTheClientLivenessWindow(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	identities := &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader}
	service, err := rooms.NewService(store, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { service.Close() }()
	var clock atomic.Int64
	service.Monotonic = clock.Load
	host, token, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	created, err := service.Create(ctx, host, testKey(), "Liveness", contracts.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	var handler http.Handler
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { handler.ServeHTTP(w, r) }))
	defer server.Close()
	handler = transport.NewHandler(strings.TrimPrefix(server.URL, "http://"), store.Ready, http.NotFoundHandler(), transport.NewAPI(server.URL, identities).WithRooms(service), ws.NewHandler(server.URL, identities, service))
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws/v1/rooms/" + created.Snapshot.RoomID
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {server.URL}, "Cookie": {"ovs_session=" + token}}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	p := &peer{conn: conn}
	p.read(t, "session.welcome")
	// A client pauses after five seconds without server messages; two heartbeats must fit inside.
	for range 2 {
		clock.Add(2000)
		var hb struct{ Reply bool }
		if err := json.Unmarshal(p.read(t, "heartbeat"), &hb); err != nil || hb.Reply {
			t.Fatal("expected a server-initiated heartbeat", err)
		}
	}
}
