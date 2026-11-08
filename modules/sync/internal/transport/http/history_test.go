package http

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/history"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/storage"
)

func TestPrivateHistoryHTTPJourneyAndStrictBoundary(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	identities := &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader}
	if err := identities.Initialize(ctx); err != nil {
		t.Fatal(err)
	}
	service, err := history.New(ctx, store, time.Now, identities.Validate)
	if err != nil {
		t.Fatal(err)
	}
	a := NewAPI("http://watch.example", identities).WithHistory(service)
	p, q := bootstrapPeer(t, a), bootstrapPeer(t, a)
	const path = "/api/v1/me/history"
	const video = `{"kind":"bilibili","bvid":"BV1TESTaaaaa","cid":"12345","part":2,"title":"Synthetic <video>","episodeTitle":"Part 2"}`
	read := func(p apiPeer, method, path, body string) history.State {
		t.Helper()
		w := call(t, a, p, method, path, body)
		if w.Code != 200 {
			t.Fatalf("history %s %s: %d %s", method, path, w.Code, w.Body)
		}
		var result history.State
		if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	state := read(p, "POST", path, video)
	if len(state.Entries) != 1 || state.Entries[0].Video.Part != 2 {
		t.Fatal("history lost exact part")
	}
	if len(read(q, "GET", path, "").Entries) != 0 {
		t.Fatal("history leaked across identities")
	}
	read(q, "DELETE", path+"/"+state.Entries[0].EntryID, "{}")
	if len(read(p, "GET", path, "").Entries) != 1 {
		t.Fatal("another identity deleted history")
	}
	for _, bad := range []string{
		strings.Replace(video, `"kind":"bilibili"`, `"kind":"local"`, 1),
		strings.Replace(video, `"part":2`, `"part":0`, 1),
		strings.Replace(video, `"part":2`, `"part":2,"episodeId":"123"`, 1),
		strings.Replace(video, `"part":2`, `"part":2,"part":3`, 1),
		strings.Replace(video, `"part":2`, `"part":2,"roomId":"synthetic-secret"`, 1),
		strings.Replace(video, `"part":2`, `"part":2,"positionMs":100`, 1),
		strings.Replace(video, `"part":2`, `"part":2,"url":"https://cdn.example/?token=synthetic-secret"`, 1),
		strings.Replace(video, `"title":"Synthetic <video>"`, `"title":"\ud800"`, 1),
	} {
		if w := call(t, a, p, "POST", path, bad); w.Code != 400 {
			t.Fatalf("invalid history accepted: %d %s", w.Code, w.Body)
		}
	}
	if w := call(t, a, apiPeer{}, "GET", path, ""); w.Code != 401 {
		t.Fatal("anonymous history access")
	}
	wrong := p
	wrong.csrf = "wrong"
	for _, operation := range []struct{ method, path, body string }{{"POST", path, video}, {"DELETE", path, "{}"}, {"PATCH", path + "/preferences", `{"recordingEnabled":false}`}} {
		if w := call(t, a, wrong, operation.method, operation.path, operation.body); w.Code != 403 {
			t.Fatal("history mutation ignored CSRF")
		}
	}
	r := httptest.NewRequest("POST", "http://watch.example"+path, strings.NewReader(video))
	r.AddCookie(&http.Cookie{Name: "ovs_session", Value: p.token})
	r.Header.Set("Origin", "http://attacker.example")
	r.Header.Set("X-OVS-CSRF", p.csrf)
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	a.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("cross-origin history mutation")
	}
	read(p, "PATCH", path+"/preferences", `{"recordingEnabled":false}`)
	read(p, "DELETE", path, "{}")
	if state := read(p, "POST", path, video); state.RecordingEnabled || len(state.Entries) != 0 {
		t.Fatal("paused history accepted recording")
	}
	read(p, "PATCH", path+"/preferences", `{"recordingEnabled":true}`)
	state = read(p, "POST", path, video)
	if len(read(p, "DELETE", path+"/"+state.Entries[0].EntryID, "{}").Entries) != 0 {
		t.Fatal("single deletion failed")
	}
	if w := call(t, a, p, "POST", path+"?identityId="+q.id, video); w.Code != 400 {
		t.Fatal("history accepted extra query fields")
	}
}
