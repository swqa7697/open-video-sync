package storage

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/identity"
	"github.com/swqa7697/open-video-sync/internal/rooms"
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

func TestWriteFailureRollbackPauseRecoveryAndHostResume(t *testing.T) {
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
	settings.WaitMode = "none"
	settings.Controllers = "everyone"
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
	for _, query := range []string{
		`CREATE TRIGGER reject_receipt BEFORE INSERT ON command_results BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END`,
		`CREATE TRIGGER reject_recovery BEFORE UPDATE ON storage_probe BEGIN SELECT RAISE(ABORT,'synthetic unavailable storage'); END`,
	} {
		if _, err := store.db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	failed := contracts.ClientFrame{Type: "playback.command", Action: "seek", PositionMs: 12000, CommandID: recoveryKey(t), Epoch: snap.Epoch, MediaGeneration: snap.MediaGeneration, ExpectedRevision: snap.Revision}
	if err := service.Handle(ctx, g, failed); err == nil {
		t.Fatal("failed commit acknowledged")
	}
	if err := store.db.PingContext(ctx); err != nil {
		t.Fatal(err)
	}
	if store.Ready(ctx) == nil {
		t.Fatal("ping cleared write-failure latch")
	}
	var revision, position, receipts int64
	if err := store.db.QueryRow(`SELECT r.revision,p.position_ms FROM rooms r JOIN playback_checkpoints p ON p.room_id=r.id WHERE r.id=?`, snap.RoomID).Scan(&revision, &position); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT count(*) FROM command_results WHERE command_id=?`, failed.CommandID).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if revision != before.Revision || position != 0 || receipts != 0 {
		t.Fatal("partial durable transition survived rollback", revision, position, receipts)
	}
	gs.mu.Lock()
	failedSafely := gs.closed && len(gs.results) == 1 && !gs.results[0].Accepted
	gs.mu.Unlock()
	if !failedSafely {
		t.Fatal("failed connection received false success")
	}
	if err := service.Handle(ctx, h, failed); err == nil {
		t.Fatal("continued in-memory success during outage")
	}
	// A failed real write probe must retain the latch. Remove the injected cause only afterward.
	if err := probeWrite(ctx, store.db); err == nil {
		t.Fatal("injected recovery write unexpectedly succeeded")
	}
	if store.Ready(ctx) == nil {
		t.Fatal("failed write probe cleared latch")
	}
	for _, query := range []string{`DROP TRIGGER reject_receipt`, `DROP TRIGGER reject_recovery`} {
		if _, err := store.db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(3 * time.Second)
	for store.Ready(ctx) != nil {
		if time.Now().After(deadline) {
			t.Fatal("bounded write recovery did not succeed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	snap, err = service.Snapshot(ctx, host, snap.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Epoch == before.Epoch || snap.Playback.Phase != "paused" || snap.Playback.DesiredPlaying || snap.Playback.PositionMs != 0 || snap.Revision != before.Revision {
		t.Fatal("recovery retained stale running state", snap)
	}
	g, err = service.Connect(ctx, guest, snap.RoomID, &recoverySink{})
	if err != nil {
		t.Fatal(err)
	}
	if err := send(g, contracts.ClientFrame{Type: "playback.command", Action: "play"}); err != contracts.Failure("forbidden") {
		t.Fatal("guest resumed after storage recovery", err)
	}
	h, err = service.Connect(ctx, host, snap.RoomID, &recoverySink{})
	if err != nil {
		t.Fatal(err)
	}
	if err := send(h, contracts.ClientFrame{Type: "playback.command", Action: "play"}); err != nil {
		t.Fatal(err)
	}
	if snap.Playback.Phase != "playing" {
		t.Fatal("host could not resume recovered room")
	}
}
