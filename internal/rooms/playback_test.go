package rooms_test

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/identity"
	"github.com/swqa7697/open-video-sync/internal/rooms"
	"github.com/swqa7697/open-video-sync/internal/storage"
)

type sink struct {
	mu     sync.Mutex
	frames map[string][]json.RawMessage
}

func (s *sink) Offer(kind, epoch string, payload any) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.frames == nil {
		s.frames = make(map[string][]json.RawMessage)
	}
	b, _ := json.Marshal(payload)
	s.frames[kind] = append(s.frames[kind], b)
	return true
}
func (s *sink) Close() {}

type rollbackRepository struct {
	rooms.Repository
	reject     atomic.Bool
	rejections atomic.Int64
}

type recordingTx struct {
	rooms.Tx
	playbackWrite bool
}

func (t *recordingTx) SavePlayback(r rooms.Room, now int64) error {
	t.playbackWrite = true
	return t.Tx.SavePlayback(r, now)
}
func (r *rollbackRepository) Transact(ctx context.Context, run func(rooms.Tx) error) error {
	return r.Repository.Transact(ctx, func(tx rooms.Tx) error {
		observed := &recordingTx{Tx: tx}
		if err := run(observed); err != nil {
			return err
		}
		if observed.playbackWrite && r.reject.Load() {
			r.rejections.Add(1)
			return contracts.Failure("busy")
		}
		return nil
	})
}
func TestTimelineRollbackCheckpointAndRevokedLease(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	repository := &rollbackRepository{Repository: store}
	service, err := rooms.NewService(repository, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	var monotonic atomic.Int64
	service.Monotonic = monotonic.Load
	host := participant(t, store, time.Now)
	settings := contracts.DefaultSettings()
	settings.WaitMode = "none"
	created, err := service.Create(ctx, host, key(t), "Rollback", settings)
	if err != nil {
		t.Fatal(err)
	}
	bound, err := service.Connect(ctx, host, created.Snapshot.RoomID, &sink{})
	if err != nil {
		t.Fatal(err)
	}
	command := contracts.ClientFrame{Type: "media.select", CommandID: key(t), Epoch: created.Snapshot.Epoch, ExpectedRevision: created.Snapshot.Revision, Media: contracts.MediaDescriptor{Kind: "local", FingerprintVersion: 1, Digest: strings.Repeat("a", 64), SizeBytes: 100, DurationMs: 60000}}
	repository.reject.Store(true)
	err = service.Handle(ctx, bound, command)
	expectCode(t, err, "busy")
	repository.reject.Store(false)
	snap, err := service.Snapshot(ctx, host, created.Snapshot.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Media != nil || snap.Revision != 1 {
		t.Fatal("uncommitted media published")
	}
	// The receipt rolled back with the media; retry must now perform the transition.
	if err := service.Handle(ctx, bound, command); err != nil {
		t.Fatal(err)
	}
	snap, err = service.Snapshot(ctx, host, snap.RoomID)
	if err != nil || snap.MediaGeneration != 1 || snap.Revision != 2 {
		t.Fatal("retry lost atomic outcome", err)
	}
	play := contracts.ClientFrame{Type: "playback.command", CommandID: key(t), Epoch: snap.Epoch, ExpectedRevision: snap.Revision, MediaGeneration: snap.MediaGeneration, Action: "play"}
	if err := service.Handle(ctx, bound, play); err != nil {
		t.Fatal(err)
	}
	monotonic.Store(5000)
	replacement, err := service.Connect(ctx, host, snap.RoomID, &sink{})
	if err != nil {
		t.Fatal(err)
	}
	if err := service.Handle(ctx, replacement, contracts.ClientFrame{Type: "member.activate", Epoch: snap.Epoch, RequestID: key(t)}); err != nil {
		t.Fatal(err)
	}
	err = service.Handle(ctx, bound, play)
	expectCode(t, err, "session_required")
	service.Close()
	fresh, err := rooms.NewService(store, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	restored, err := fresh.Snapshot(ctx, host, snap.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Playback.Phase != "paused" || restored.Playback.PositionMs != 5000 || restored.Epoch == snap.Epoch || restored.Revision != 3 {
		t.Fatal("checkpoint did not restore paused", restored)
	}
}

func TestWaitingSeekExclusionSettingsAndSessionRevocation(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	service, err := rooms.NewService(store, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	host, guest := participant(t, store, time.Now), participant(t, store, time.Now)
	created, err := service.Create(ctx, host, key(t), "Waiting", contracts.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	joined, err := service.Redeem(ctx, guest, key(t), "code", created.Invitation.Code)
	if err != nil {
		t.Fatal(err)
	}
	snap := joined.Snapshot
	hs, gs := &sink{}, &sink{}
	h, err := service.Connect(ctx, host, snap.RoomID, hs)
	if err != nil {
		t.Fatal(err)
	}
	g, err := service.Connect(ctx, guest, snap.RoomID, gs)
	if err != nil {
		t.Fatal(err)
	}
	refresh := func() {
		t.Helper()
		snap, err = service.Snapshot(ctx, host, snap.RoomID)
		if err != nil {
			t.Fatal(err)
		}
	}
	send := func(c *rooms.Connection, f contracts.ClientFrame) error {
		t.Helper()
		refresh()
		f.CommandID = key(t)
		f.Epoch = snap.Epoch
		f.ExpectedRevision = snap.Revision
		f.MediaGeneration = snap.MediaGeneration
		err := service.Handle(ctx, c, f)
		if err == nil {
			refresh()
		}
		return err
	}
	if err := send(h, contracts.ClientFrame{Type: "media.select", Media: contracts.MediaDescriptor{Kind: "local", FingerprintVersion: 1, Digest: strings.Repeat("a", 64), SizeBytes: 1, DurationMs: 60000}}); err != nil {
		t.Fatal(err)
	}
	if err := send(h, contracts.ClientFrame{Type: "playback.command", Action: "play"}); err != nil {
		t.Fatal(err)
	}
	if snap.Barrier == nil || len(snap.Barrier.RequiredMemberIDs) != 2 {
		t.Fatal("play did not freeze cohort")
	}
	oldBarrier := snap.Barrier.BarrierID
	if err := send(h, contracts.ClientFrame{Type: "playback.command", Action: "seek", PositionMs: 10000}); err != nil {
		t.Fatal(err)
	}
	if snap.Playback.Phase != "waiting" || !snap.Playback.DesiredPlaying || snap.Barrier.BarrierID == oldBarrier || snap.Barrier.TargetPositionMs != 10000 {
		t.Fatal("waiting seek lost play intent")
	}
	position, duration := int64(10000), int64(60000)
	report := contracts.Readiness{Status: "ready", MediaGeneration: snap.MediaGeneration, BarrierID: &oldBarrier, PositionMs: &position, DurationMs: &duration, Capabilities: contracts.Capabilities{CanPlay: true, CanPause: true, CanSeek: true, CanReadPosition: true, CanDetectBuffering: true}}
	err = service.Handle(ctx, g, contracts.ClientFrame{Type: "member.readiness", Epoch: snap.Epoch, Report: report})
	expectCode(t, err, "stale_state")
	if err := send(g, contracts.ClientFrame{Type: "waiting.exclude", MemberID: g.MemberID, Excluded: true}); err != contracts.Failure("forbidden") {
		t.Fatal("guest excluded itself", err)
	}
	if err := send(h, contracts.ClientFrame{Type: "waiting.exclude", MemberID: h.MemberID, Excluded: true}); err != contracts.Failure("forbidden") {
		t.Fatal("host excluded itself", err)
	}
	if err := send(h, contracts.ClientFrame{Type: "waiting.exclude", MemberID: g.MemberID, Excluded: true}); err != nil {
		t.Fatal(err)
	}
	if len(snap.Barrier.RequiredMemberIDs) != 1 {
		t.Fatal("exclusion did not update barrier")
	}
	id := snap.Barrier.BarrierID
	report.BarrierID = &id
	if err := service.Handle(ctx, h, contracts.ClientFrame{Type: "member.readiness", Epoch: snap.Epoch, Report: report}); err != nil {
		t.Fatal(err)
	}
	refresh()
	if snap.Playback.Phase != "playing" {
		t.Fatal("remaining cohort did not play")
	}
	change := mutation(snap, "settings")
	change.Settings = snap.Settings
	change.Settings.Controllers = "everyone"
	change.Settings.SyncMode = "seek"
	updated, _, err := service.Mutate(ctx, host, snap.RoomID, change)
	if err != nil {
		t.Fatal(err)
	}
	snap = updated.Snapshot
	if snap.Playback.Phase != "playing" {
		t.Fatal("non-waiting settings paused playback")
	}
	change = mutation(snap, "settings")
	change.Settings = snap.Settings
	change.Settings.WaitMode = "none"
	updated, _, err = service.Mutate(ctx, host, snap.RoomID, change)
	if err != nil {
		t.Fatal(err)
	}
	snap = updated.Snapshot
	if snap.Playback.Phase != "paused" || snap.Playback.DesiredPlaying || snap.Barrier != nil {
		t.Fatal("waiting settings retained auto resume")
	}
	identities := &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader, OnRevoked: service.RevokeSession}
	if err := identities.Forget(ctx, guest); err != nil {
		t.Fatal(err)
	}
	gs.mu.Lock()
	revoked := len(gs.frames["session.replaced"]) > 0
	gs.mu.Unlock()
	if !revoked {
		t.Fatal("revoked session was not notified immediately")
	}
	if err := send(h, contracts.ClientFrame{Type: "media.select", Media: contracts.MediaDescriptor{Kind: "local", FingerprintVersion: 1, Digest: strings.Repeat("b", 64), SizeBytes: 1, DurationMs: 60000}}); err != nil {
		t.Fatal(err)
	}
	for _, m := range snap.Members {
		if m.ExcludedFromWaiting {
			t.Fatal("exclusion leaked to new generation")
		}
	}
	// Removing a required member must revoke its socket and return a coherent barrier snapshot.
	newGuest := participant(t, store, time.Now)
	if _, err := service.Redeem(ctx, newGuest, key(t), "code", created.Invitation.Code); err != nil {
		t.Fatal(err)
	}
	newSink := &sink{}
	newConn, err := service.Connect(ctx, newGuest, snap.RoomID, newSink)
	if err != nil {
		t.Fatal(err)
	}
	refresh()
	change = mutation(snap, "settings")
	change.Settings = snap.Settings
	change.Settings.WaitMode = "all"
	if _, _, err := service.Mutate(ctx, host, snap.RoomID, change); err != nil {
		t.Fatal(err)
	}
	if err := send(h, contracts.ClientFrame{Type: "playback.command", Action: "play"}); err != nil {
		t.Fatal(err)
	}
	remove := mutation(snap, "remove")
	remove.MemberID = newConn.MemberID
	removed, _, err := service.Mutate(ctx, host, snap.RoomID, remove)
	if err != nil {
		t.Fatal(err)
	}
	if removed.Snapshot.Barrier == nil {
		t.Fatal("removal discarded remaining barrier")
	}
	for _, mid := range removed.Snapshot.Barrier.RequiredMemberIDs {
		if mid == newConn.MemberID {
			t.Fatal("removed member remained required")
		}
	}
	newSink.mu.Lock()
	revoked = len(newSink.frames["session.replaced"]) > 0
	newSink.mu.Unlock()
	if !revoked {
		t.Fatal("removed membership retained its socket")
	}
}

func TestEmptyCoordinatorEvictionSavesPausedAndReactivatesFresh(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	limits := rooms.DefaultLimits()
	limits.CoordinatorIdle = 20 * time.Millisecond
	repository := &rollbackRepository{Repository: store}
	service, err := rooms.NewService(repository, time.Now, rand.Reader, limits)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	var clock atomic.Int64
	service.Monotonic = clock.Load
	host := participant(t, store, time.Now)
	settings := contracts.DefaultSettings()
	settings.WaitMode = "none"
	created, err := service.Create(ctx, host, key(t), "Eviction", settings)
	if err != nil {
		t.Fatal(err)
	}
	snap := created.Snapshot
	conn, err := service.Connect(ctx, host, snap.RoomID, &sink{})
	if err != nil {
		t.Fatal(err)
	}
	for _, frame := range []contracts.ClientFrame{{Type: "media.select", Media: contracts.MediaDescriptor{Kind: "local", FingerprintVersion: 1, Digest: strings.Repeat("a", 64), SizeBytes: 1, DurationMs: 60000}}, {Type: "playback.command", Action: "play"}} {
		frame.CommandID = key(t)
		frame.Epoch = snap.Epoch
		frame.ExpectedRevision = snap.Revision
		frame.MediaGeneration = snap.MediaGeneration
		if err := service.Handle(ctx, conn, frame); err != nil {
			t.Fatal(err)
		}
		snap, err = service.Snapshot(ctx, host, snap.RoomID)
		if err != nil {
			t.Fatal(err)
		}
	}
	clock.Store(5000)
	repository.reject.Store(true)
	service.Disconnect(conn)
	deadline := time.Now().Add(time.Second)
	for repository.rejections.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("idle checkpoint was not attempted")
		}
		time.Sleep(5 * time.Millisecond)
	}
	var failedSave rooms.Room
	if err := store.Transact(ctx, func(tx rooms.Tx) error {
		var err error
		failedSave, err = tx.LoadRoom(snap.RoomID)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if failedSave.Playback.Phase != "playing" {
		t.Fatal("failed idle checkpoint was published")
	}
	repository.reject.Store(false)
	for {
		var saved rooms.Room
		if err := store.Transact(ctx, func(tx rooms.Tx) error { var err error; saved, err = tx.LoadRoom(snap.RoomID); return err }); err != nil {
			t.Fatal(err)
		}
		if saved.Playback.Phase == "paused" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("empty coordinator did not save paused before eviction")
		}
		time.Sleep(5 * time.Millisecond)
	}
	restored, err := service.Snapshot(ctx, host, snap.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Epoch == snap.Epoch || restored.Playback.Phase != "paused" || restored.Playback.PositionMs != 5000 || restored.Revision != snap.Revision || restored.Barrier != nil {
		t.Fatal("reactivation reused stale runtime state", restored)
	}
	for _, m := range restored.Members {
		if m.PlaybackActive || m.PlaybackEligible || m.Readiness != nil {
			t.Fatal("ephemeral playback state survived eviction")
		}
	}
}
