package storage

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/rooms"
)

type recoverySink struct {
	mu      sync.Mutex
	results []rooms.CommandResult
	closed  bool
}

func (s *recoverySink) Offer(kind, _ string, payload any) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if kind == "command.result" {
		b, _ := json.Marshal(payload)
		var result rooms.CommandResult
		_ = json.Unmarshal(b, &result)
		s.results = append(s.results, result)
	}
	return true
}
func (s *recoverySink) Close() { s.mu.Lock(); s.closed = true; s.mu.Unlock() }
func recoveryKey(t *testing.T) string {
	t.Helper()
	id, err := contracts.RandomID(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestPersistentFailureLeavesMemoryAndExistingPlaybackAvailable(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	identities := &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader}
	host, _, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	guest, _, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	service, err := rooms.NewService(store, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	settings := contracts.DefaultSettings()
	settings.WaitForAll = false
	settings.EveryoneCanControl = true
	created, err := service.Create(ctx, host, recoveryKey(t), "Write recovery", settings)
	if err != nil {
		t.Fatal(err)
	}
	joined, err := service.Redeem(ctx, guest, recoveryKey(t), "code", created.Invitation.Code)
	if err != nil {
		t.Fatal(err)
	}
	snap := joined.Snapshot
	hs, gs := &recoverySink{}, &recoverySink{}
	h, err := service.Connect(ctx, host, snap.RoomID, hs)
	if err != nil {
		t.Fatal(err)
	}
	g, err := service.Connect(ctx, guest, snap.RoomID, gs)
	if err != nil {
		t.Fatal(err)
	}
	send := func(c *rooms.Connection, f contracts.ClientFrame) error {
		t.Helper()
		f.CommandID = recoveryKey(t)
		f.Epoch = snap.Epoch
		f.MediaGeneration = snap.MediaGeneration
		f.ExpectedRevision = snap.Revision
		if err := service.Handle(ctx, c, f); err != nil {
			return err
		}
		snap, err = service.Snapshot(ctx, host, snap.RoomID)
		return err
	}
	if err := send(h, contracts.ClientFrame{Type: "media.select", Media: contracts.MediaDescriptor{Kind: "local", FingerprintVersion: 1, Digest: strings.Repeat("a", 64), SizeBytes: 1, DurationMs: 60000}}); err != nil {
		t.Fatal(err)
	}
	if err := send(h, contracts.ClientFrame{Type: "playback.command", Action: "play"}); err != nil {
		t.Fatal(err)
	}

	before := snap
	other, err := service.Create(ctx, host, recoveryKey(t), "Independent room", settings)
	if err != nil {
		t.Fatal(err)
	}
	otherConn, err := service.Connect(ctx, host, other.Snapshot.RoomID, &recoverySink{})
	if err != nil {
		t.Fatal(err)
	}
	ownOther := other.Snapshot
	for _, f := range []contracts.ClientFrame{{Type: "media.select", Media: contracts.MediaDescriptor{Kind: "bilibili", BVID: "BV1TESTaaaaa", CID: "9000000000001", Part: 1, DurationMs: 60000}}, {Type: "playback.command", Action: "play"}} {
		f.CommandID = recoveryKey(t)
		f.Epoch = ownOther.Epoch
		f.ExpectedRevision = ownOther.Revision
		f.MediaGeneration = ownOther.MediaGeneration
		if err := service.Handle(ctx, otherConn, f); err != nil {
			t.Fatal(err)
		}
		ownOther, err = service.Snapshot(ctx, host, ownOther.RoomID)
		if err != nil {
			t.Fatal(err)
		}
	}
	var beforeStored string
	if err := store.db.QueryRow(`SELECT settings FROM rooms WHERE id=?`, snap.RoomID).Scan(&beforeStored); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`CREATE TRIGGER reject_settings BEFORE UPDATE ON rooms BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END`); err != nil {
		t.Fatal(err)
	}
	changed := settings
	changed.EveryoneCanControl = false
	_, _, err = service.Mutate(ctx, host, snap.RoomID, rooms.Mutation{Operation: "settings", Epoch: snap.Epoch, ExpectedRevision: snap.Revision, Settings: changed})
	if err == nil {
		t.Fatal("failed durable settings acknowledged")
	}
	snap, err = service.Snapshot(ctx, host, snap.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Revision != before.Revision || snap.Epoch != before.Epoch || snap.Settings != before.Settings || snap.Playback.Phase != "playing" {
		t.Fatal("failed persistent operation changed memory")
	}
	if store.Ready(ctx) == nil {
		t.Fatal("failed writes remained ready")
	}
	hs.mu.Lock()
	closed := hs.closed
	hs.mu.Unlock()
	gs.mu.Lock()
	closed = closed || gs.closed
	gs.mu.Unlock()
	if closed {
		t.Fatal("storage failure closed healthy playback")
	}
	var stored string
	if err := store.db.QueryRow(`SELECT settings FROM rooms WHERE id=?`, snap.RoomID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != beforeStored {
		t.Fatal("failed settings persisted")
	}
	if err := send(g, contracts.ClientFrame{Type: "playback.command", Action: "seek", PositionMs: 12000}); err != nil {
		t.Fatal("memory playback stopped during outage", err)
	}
	if snap.Playback.PositionMs != 12000 {
		t.Fatal("seek was not applied during outage")
	}
	if _, err := service.Redeem(ctx, guest, recoveryKey(t), "code", other.Invitation.Code); err != contracts.Failure("storage_unavailable") {
		t.Fatal("durable operation ignored failure latch", err)
	}
	otherSnap, err := service.Snapshot(ctx, host, other.Snapshot.RoomID)
	if err != nil || len(otherSnap.Members) != 1 || otherSnap.Playback.Phase != "playing" {
		t.Fatal("failed membership changed authorization", err)
	}
	if err := service.Handle(ctx, otherConn, contracts.ClientFrame{Type: "media.select", CommandID: recoveryKey(t), Epoch: otherSnap.Epoch, ExpectedRevision: otherSnap.Revision, MediaGeneration: otherSnap.MediaGeneration, Media: contracts.MediaDescriptor{Kind: "local", FingerprintVersion: 1, Digest: strings.Repeat("a", 64), SizeBytes: 1, DurationMs: 60000}}); err != contracts.Failure("storage_unavailable") {
		t.Fatal("media persistence ignored failure latch", err)
	}
	if err := service.Handle(ctx, otherConn, contracts.ClientFrame{Type: "playback.command", Action: "seek", PositionMs: 5000, CommandID: recoveryKey(t), Epoch: otherSnap.Epoch, ExpectedRevision: otherSnap.Revision, MediaGeneration: otherSnap.MediaGeneration}); err != nil {
		t.Fatal("unrelated playback lost controls", err)
	}
	// Removing the cause does not automatically recover writes or replace runtime epochs.
	if _, err := store.db.Exec(`DROP TRIGGER reject_settings`); err != nil {
		t.Fatal(err)
	}
	if store.Ready(ctx) == nil {
		t.Fatal("storage recovered without operator restart")
	}
	if err := send(h, contracts.ClientFrame{Type: "playback.command", Action: "pause"}); err != nil {
		t.Fatal(err)
	}
	if snap.Playback.Phase != "paused" || snap.Epoch != before.Epoch {
		t.Fatal("unrelated storage recovery altered runtime")
	}
}
