package storage

import (
	"context"
	"crypto/rand"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/history"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
)

func watchedPart(part int64) contracts.HistoryVideo {
	return contracts.HistoryVideo{Kind: "bilibili", BVID: "BV1TESTaaaaa", CID: strconv.FormatInt(part, 10), Part: part, Title: "Synthetic video", EpisodeTitle: "Part " + strconv.FormatInt(part, 10)}
}

func TestHistoryRetentionIdentityIsolationAndRestart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	identities := &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader}
	p, token, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	q, _, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	service, err := history.New(ctx, store, time.Now, identities.Validate)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for part := int64(1); part <= 101; part++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := service.Record(ctx, p, watchedPart(part)); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	state, err := service.List(p)
	if err != nil || len(state.Entries) != 100 {
		t.Fatal("bounded concurrent history", len(state.Entries), err)
	}
	for i := 1; i < len(state.Entries); i++ {
		if state.Entries[i-1].LastPlayedAtMs <= state.Entries[i].LastPlayedAtMs {
			t.Fatal("history not most recent first")
		}
	}
	video := state.Entries[len(state.Entries)-1].Video
	video.Title = "Updated <title> 😀"
	state, err = service.Record(ctx, p, video)
	if err != nil || len(state.Entries) != 100 || state.Entries[0].Video.Title != video.Title {
		t.Fatal("repeat did not update and move to top", err)
	}
	if _, err := service.Record(ctx, q, video); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Delete(ctx, q, state.Entries[0].EntryID); err != nil {
		t.Fatal(err)
	}
	other, err := service.List(q)
	if err != nil || len(other.Entries) != 0 {
		t.Fatal("identity deletion", err)
	}
	state, err = service.List(p)
	if err != nil || len(state.Entries) != 100 {
		t.Fatal("another identity changed history", err)
	}
	episode := watchedPart(1)
	episode.EpisodeID = "12345"
	first, err := service.Record(ctx, p, episode)
	if err != nil {
		t.Fatal(err)
	}
	episode.BVID = "BV1TESTaaaab"
	episode.CID = "999"
	second, err := service.Record(ctx, p, episode)
	if err != nil || first.Entries[0].EntryID != second.Entries[0].EntryID || second.Entries[0].Video.BVID != episode.BVID {
		t.Fatal("EP identity not preserved", err)
	}
	state, err = service.SetRecording(ctx, p, false)
	if err != nil {
		t.Fatal(err)
	}
	paused, err := service.Record(ctx, p, watchedPart(999))
	if err != nil || !reflect.DeepEqual(state, paused) {
		t.Fatal("disabled recording changed history", err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	identities = &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader}
	p, err = identities.Authenticate(ctx, token)
	if err != nil {
		t.Fatal(err)
	}
	service, err = history.New(ctx, store, time.Now, identities.Validate)
	if err != nil {
		t.Fatal(err)
	}
	restored, err := service.List(p)
	if err != nil || !reflect.DeepEqual(state, restored) {
		t.Fatal("restart changed history or preference", err)
	}
	cleared, err := service.Clear(ctx, p)
	if err != nil || len(cleared.Entries) != 0 || cleared.RecordingEnabled {
		t.Fatal("clear changed preference", err)
	}
	if err := identities.Forget(ctx, p); err != nil {
		t.Fatal(err)
	}
	if _, err := service.List(p); err != contracts.Failure("session_required") {
		t.Fatal("revoked identity read history", err)
	}
}

func TestHistoryFailedWriteLeavesMemoryAndInitializedReadsNeedNoSQL(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	identities := &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader}
	p, _, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	service, err := history.New(ctx, store, time.Now, identities.Validate)
	if err != nil {
		t.Fatal(err)
	}
	before, err := service.Record(ctx, p, watchedPart(1))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`CREATE TRIGGER reject_history BEFORE INSERT ON watch_history BEGIN SELECT RAISE(ABORT,'synthetic history failure'); END`); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Record(ctx, p, watchedPart(2)); err == nil {
		t.Fatal("failed history write acknowledged")
	}
	after, err := service.List(p)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("failed write changed memory", err)
	}
	durable, err := store.LoadHistory(ctx)
	if err != nil || len(durable) != 1 || !reflect.DeepEqual(before, durable[0]) {
		t.Fatal("failed write changed database", err)
	}
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}
	after, err = service.List(p)
	if err != nil || !reflect.DeepEqual(before, after) {
		t.Fatal("initialized history read accessed SQL", err)
	}
	after.Entries[0].Video.Title = "Mutated response"
	detached, err := service.List(p)
	if err != nil || !reflect.DeepEqual(before, detached) {
		t.Fatal("caller mutated shared memory", err)
	}
}
