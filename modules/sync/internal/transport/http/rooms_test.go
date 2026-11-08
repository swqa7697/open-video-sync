package http

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/rooms"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/storage"
)

func TestRoomHTTPJourneyAndSharedMutationPath(t *testing.T) {
	store, err := storage.Open(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	identities := &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader}
	service, err := rooms.NewService(store, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	a := NewAPI("http://watch.example", identities).WithRooms(service)
	host, guest, third := bootstrapPeer(t, a), bootstrapPeer(t, a), bootstrapPeer(t, a)
	newKey := func() string { k, _ := contracts.RandomID(rand.Reader); return k }
	// Use explicit requests for create/redeem headers while keeping the common transport helper.
	createBody, _ := json.Marshal(map[string]any{"title": "Room", "settings": contracts.DefaultSettings(), "media": contracts.MediaDescriptor{Kind: "bilibili", BVID: "BV1TESTaaaaa", CID: "1", Part: 1, DurationMs: 100000}})
	keyed := func(p apiPeer, path, body, key string) []byte {
		t.Helper()
		r := newRequest(p, path, body, key)
		w := httptest.NewRecorder()
		a.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("%s: %d %s", path, w.Code, w.Body)
		}
		return w.Body.Bytes()
	}
	invalid, _ := json.Marshal(map[string]any{"title": "Missing media", "settings": contracts.DefaultSettings()})
	bad := httptest.NewRecorder()
	a.ServeHTTP(bad, newRequest(host, "/api/v1/rooms", string(invalid), newKey()))
	if bad.Code != 400 {
		t.Fatal("room creation accepted missing initial media")
	}
	var created rooms.Result
	if err := json.Unmarshal(keyed(host, "/api/v1/rooms", string(createBody), newKey()), &created); err != nil {
		t.Fatal(err)
	}
	id := created.Snapshot.RoomID
	if created.Snapshot.Media == nil || created.Snapshot.Playback.Phase != "paused" {
		t.Fatal("creation did not include paused initial media")
	}
	durable, err := store.LoadRooms(context.Background())
	if err != nil || len(durable) != 1 || durable[0].Media == nil {
		t.Fatal("initial selection was not durable", err)
	}
	if w := call(t, a, third, "GET", "/api/v1/rooms/"+id, ""); w.Code != 404 {
		t.Fatal("third profile read room")
	}
	var joined rooms.Result
	_ = json.Unmarshal(keyed(guest, "/api/v1/invitations/redeem", fmt.Sprintf(`{"code":%q}`, created.Invitation.Code), newKey()), &joined)
	snap := joined.Snapshot
	session, err := identities.Authenticate(context.Background(), host.token)
	if err != nil {
		t.Fatal(err)
	}
	settings := contracts.DefaultSettings()
	settings.EveryoneCanControl = true
	patch, _ := json.Marshal(map[string]any{"epoch": snap.Epoch, "expectedRevision": snap.Revision, "settings": settings})
	var wg sync.WaitGroup
	wg.Add(2)
	httpCode := 0
	var commandErr error
	go func() {
		defer wg.Done()
		httpCode = call(t, a, host, "PATCH", "/api/v1/rooms/"+id+"/settings", string(patch)).Code
	}()
	go func() {
		defer wg.Done()
		_, _, commandErr = service.Mutate(context.Background(), session, id, rooms.Mutation{Operation: "settings", Epoch: snap.Epoch, ExpectedRevision: snap.Revision, Settings: settings})
	}()
	wg.Wait()
	if !((httpCode == 200 && commandErr == contracts.Failure("stale_state")) || (httpCode == 409 && commandErr == nil)) {
		t.Fatalf("HTTP and command did not serialize: %d %v", httpCode, commandErr)
	}
	if w := call(t, a, guest, "GET", "/api/v1/rooms?limit=1", ""); w.Code != 200 {
		t.Fatal(w.Body)
	}
	for _, query := range []string{"?other=1", "?limit=101", "?cursor=wrong", "?limit=1&limit=2"} {
		if w := call(t, a, host, "GET", "/api/v1/rooms"+query, ""); w.Code != 400 {
			t.Fatal("bad pagination accepted", w.Code)
		}
	}
	w := call(t, a, host, "GET", "/api/v1/rooms/"+id, "")
	_ = json.Unmarshal(w.Body.Bytes(), &snap)
	preconditions := fmt.Sprintf(`{"epoch":%q,"expectedRevision":%d}`, snap.Epoch, snap.Revision)
	// A request that times out is retryable busy work, not a storage failure, and has no effect.
	expired, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	patch, _ = json.Marshal(map[string]any{"epoch": snap.Epoch, "expectedRevision": snap.Revision, "settings": contracts.DefaultSettings()})
	r := httptest.NewRequestWithContext(expired, "PATCH", "http://watch.example/api/v1/rooms/"+id+"/settings", strings.NewReader(string(patch)))
	r.Header.Set("Origin", "http://watch.example")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-OVS-CSRF", host.csrf)
	r.AddCookie(&http.Cookie{Name: "ovs_session", Value: host.token})
	timedOut := httptest.NewRecorder()
	a.ServeHTTP(timedOut, r)
	if timedOut.Code != 503 || !strings.Contains(timedOut.Body.String(), `"code":"busy"`) {
		t.Fatalf("timed-out request: %d %s", timedOut.Code, timedOut.Body)
	}
	if w := call(t, a, host, "DELETE", "/api/v1/rooms/"+id, preconditions); w.Code != 200 {
		t.Fatal("close failed", w.Body)
	}
	if w := call(t, a, guest, "GET", "/api/v1/rooms/"+id, ""); w.Code != 404 {
		t.Fatal("closed room available")
	}
}

func newRequest(p apiPeer, path, body, key string) *http.Request {
	r := httptest.NewRequest("POST", "http://watch.example"+path, strings.NewReader(body))
	r.Header.Set("Origin", "http://watch.example")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-OVS-CSRF", p.csrf)
	r.Header.Set("Idempotency-Key", key)
	r.AddCookie(&http.Cookie{Name: "ovs_session", Value: p.token})
	return r
}
