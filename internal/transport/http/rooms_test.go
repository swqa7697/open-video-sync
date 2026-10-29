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

	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/identity"
	"github.com/swqa7697/open-video-sync/internal/rooms"
	"github.com/swqa7697/open-video-sync/internal/storage"
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
	createBody, _ := json.Marshal(map[string]any{"title": "Room", "settings": contracts.DefaultSettings()})
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
	var created rooms.Result
	if err := json.Unmarshal(keyed(host, "/api/v2/rooms", string(createBody), newKey()), &created); err != nil {
		t.Fatal(err)
	}
	id := created.Snapshot.RoomID
	if w := call(t, a, third, "GET", "/api/v2/rooms/"+id, ""); w.Code != 404 {
		t.Fatal("third profile read room")
	}
	var joined rooms.Result
	_ = json.Unmarshal(keyed(guest, "/api/v2/invitations/redeem", fmt.Sprintf(`{"code":%q}`, created.Invitation.Code), newKey()), &joined)
	snap := joined.Snapshot
	session, err := identities.Authenticate(context.Background(), host.token)
	if err != nil {
		t.Fatal(err)
	}
	settings := contracts.DefaultSettings()
	settings.Controllers = "everyone"
	patch, _ := json.Marshal(map[string]any{"epoch": snap.Epoch, "expectedRevision": snap.Revision, "settings": settings})
	var wg sync.WaitGroup
	wg.Add(2)
	httpCode := 0
	var commandErr error
	go func() {
		defer wg.Done()
		httpCode = call(t, a, host, "PATCH", "/api/v2/rooms/"+id+"/settings", string(patch)).Code
	}()
	go func() {
		defer wg.Done()
		_, _, commandErr = service.Mutate(context.Background(), session, id, rooms.Mutation{Operation: "settings", Epoch: snap.Epoch, ExpectedRevision: snap.Revision, Settings: settings})
	}()
	wg.Wait()
	if !((httpCode == 200 && commandErr == contracts.Failure("stale_state")) || (httpCode == 409 && commandErr == nil)) {
		t.Fatalf("HTTP and command did not serialize: %d %v", httpCode, commandErr)
	}
	if w := call(t, a, guest, "GET", "/api/v2/rooms?limit=1", ""); w.Code != 200 {
		t.Fatal(w.Body)
	}
	for _, query := range []string{"?other=1", "?limit=101", "?cursor=wrong", "?limit=1&limit=2"} {
		if w := call(t, a, host, "GET", "/api/v2/rooms"+query, ""); w.Code != 400 {
			t.Fatal("bad pagination accepted", w.Code)
		}
	}
	w := call(t, a, host, "GET", "/api/v2/rooms/"+id, "")
	_ = json.Unmarshal(w.Body.Bytes(), &snap)
	preconditions := fmt.Sprintf(`{"epoch":%q,"expectedRevision":%d}`, snap.Epoch, snap.Revision)
	if w := call(t, a, host, "DELETE", "/api/v2/rooms/"+id, preconditions); w.Code != 200 {
		t.Fatal("close failed", w.Body)
	}
	if w := call(t, a, guest, "GET", "/api/v2/rooms/"+id, ""); w.Code != 404 {
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
