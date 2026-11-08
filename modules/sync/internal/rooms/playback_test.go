package rooms_test

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/rooms"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/storage"
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

func (r *rollbackRepository) Transact(ctx context.Context, run func(rooms.Tx) error) error {
	r.rejections.Add(1)
	return r.Repository.Transact(ctx, func(tx rooms.Tx) error {
		if err := run(tx); err != nil {
			return err
		}
		if r.reject.Load() {
			return contracts.Failure("busy")
		}
		return nil
	})
}
func TestTimelineDurableRollbackMemoryControlsAndReplacedConnection(t *testing.T) {
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
	settings.WaitForAll = false
	created, err := service.Create(ctx, host, key(t), "Rollback", settings)
	if err != nil {
		t.Fatal(err)
	}
	bound, err := service.Connect(ctx, host, created.Snapshot.RoomID, &sink{})
	if err != nil {
		t.Fatal(err)
	}
	command := contracts.ClientFrame{Type: "media.select", CommandID: key(t), Epoch: created.Snapshot.Epoch, ExpectedRevision: created.Snapshot.Revision, AutoPlay: true, Media: contracts.MediaDescriptor{Kind: "bilibili", BVID: "BV1TESTaaaaa", CID: "9000000000001", Part: 1, DurationMs: 60000, EpisodeID: "9000000000011"}}
	repository.reject.Store(true)
	err = service.Handle(ctx, bound, command)
	expectCode(t, err, "busy")
	repository.reject.Store(false)
	snap, err := service.Snapshot(ctx, host, created.Snapshot.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Media != nil || snap.Revision != 1 || snap.Playback.DesiredPlaying {
		t.Fatal("uncommitted media published")
	}
	// The receipt rolled back with the media; retry must now perform the transition.
	if err := service.Handle(ctx, bound, command); err != nil {
		t.Fatal(err)
	}
	snap, err = service.Snapshot(ctx, host, snap.RoomID)
	if err != nil || snap.MediaGeneration != 1 || snap.Revision != 2 || snap.Playback.Phase != "playing" || !snap.Playback.DesiredPlaying || snap.Playback.PositionMs != 0 {
		t.Fatal("retry lost atomic outcome", err)
	}
	if err := service.Handle(ctx, bound, command); err != nil {
		t.Fatal("identical media retry was rejected", err)
	}
	retried, err := service.Snapshot(ctx, host, snap.RoomID)
	if err != nil || retried.Revision != snap.Revision || retried.MediaGeneration != snap.MediaGeneration {
		t.Fatal("media retry repeated the transition", err)
	}
	changedIntent := command
	changedIntent.AutoPlay = false
	expectCode(t, service.Handle(ctx, bound, changedIntent), "invalid_command")
	changedEpisode := command
	changedEpisode.Media.EpisodeID = "9000000000012"
	if err := service.Handle(ctx, bound, changedEpisode); err == nil {
		t.Fatal("changed episode reused the original command receipt")
	}
	play := contracts.ClientFrame{Type: "playback.command", CommandID: key(t), Epoch: snap.Epoch, ExpectedRevision: snap.Revision, MediaGeneration: snap.MediaGeneration, Action: "play"}
	if err := service.Handle(ctx, bound, play); err != nil {
		t.Fatal(err)
	}
	refresh := func() {
		t.Helper()
		snap, err = service.Snapshot(ctx, host, snap.RoomID)
		if err != nil {
			t.Fatal(err)
		}
	}
	send := func(frame contracts.ClientFrame) contracts.ClientFrame {
		t.Helper()
		refresh()
		frame.Type = "playback.command"
		frame.CommandID = key(t)
		frame.Epoch = snap.Epoch
		frame.ExpectedRevision = snap.Revision
		frame.MediaGeneration = snap.MediaGeneration
		if err := service.Handle(ctx, bound, frame); err != nil {
			t.Fatal(err)
		}
		refresh()
		return frame
	}
	durableWrites := repository.rejections.Load()
	monotonic.Store(1000)
	rate := send(contracts.ClientFrame{Action: "rate", Rate: 1.5})
	if snap.Playback.Rate != 1.5 || snap.Playback.PositionMs != 1000 || snap.Playback.AnchorServerMs != 1000 || snap.Playback.Phase != "playing" || !snap.Playback.DesiredPlaying {
		t.Fatal("speed change lost the playing timeline", snap.Playback)
	}
	if err := service.Handle(ctx, bound, rate); err != nil {
		t.Fatal("identical speed retry failed", err)
	}
	revision := snap.Revision
	refresh()
	if snap.Revision != revision {
		t.Fatal("speed retry changed the room twice")
	}
	changedRate := rate
	changedRate.Rate = 2
	expectCode(t, service.Handle(ctx, bound, changedRate), "invalid_command")
	for _, invalid := range []float64{0, 1.1, 2.25, math.NaN(), math.Inf(1)} {
		frame := rate
		frame.CommandID = key(t)
		frame.ExpectedRevision = snap.Revision
		frame.Rate = invalid
		expectCode(t, service.Handle(ctx, bound, frame), "invalid_command")
	}
	monotonic.Store(3000)
	send(contracts.ClientFrame{Action: "pause"})
	if snap.Playback.PositionMs != 4000 || snap.Playback.Rate != 1.5 {
		t.Fatal("pause did not project the selected speed", snap.Playback)
	}
	monotonic.Store(4000)
	send(contracts.ClientFrame{Action: "rate", Rate: 0.5})
	if snap.Playback.PositionMs != 4000 || snap.Playback.Phase != "paused" || snap.Playback.DesiredPlaying {
		t.Fatal("paused speed change moved or resumed playback", snap.Playback)
	}
	send(contracts.ClientFrame{Action: "replay"})
	if snap.Playback.PositionMs != 0 || snap.Playback.Rate != 0.5 || snap.Playback.Phase != "playing" {
		t.Fatal("replay did not preserve the selected speed", snap.Playback)
	}
	if repository.rejections.Load() != durableWrites {
		t.Fatal("playback speed crossed the persistence boundary")
	}
	monotonic.Store(5000)
	replacement, err := service.Connect(ctx, host, snap.RoomID, &sink{})
	if err != nil {
		t.Fatal(err)
	}
	_ = replacement
	refresh()
	if snap.Playback.Rate != 0.5 {
		t.Fatal("reconnected member did not receive the selected speed")
	}

	err = service.Handle(ctx, bound, play)
	expectCode(t, err, "forbidden")
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
	if restored.Playback.Phase != "paused" || restored.Playback.PositionMs != 0 || restored.Playback.Rate != 1 || restored.Epoch == snap.Epoch || restored.Revision != 1 || restored.Media == nil || *restored.Media != command.Media {
		t.Fatal("selected media did not restart paused at zero", restored)
	}
}

func TestWaitingSeekSettingsAndSessionRevocation(t *testing.T) {
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
	selection := contracts.ClientFrame{Type: "media.select", AutoPlay: true, Media: contracts.MediaDescriptor{Kind: "bilibili", BVID: "BV1TESTaaaaa", CID: "9000000000001", Part: 1, DurationMs: 60000, EpisodeID: "9000000000011"}}
	expectCode(t, send(g, selection), "forbidden")
	grant := mutation(snap, "settings")
	grant.Settings = snap.Settings
	grant.Settings.EveryoneCanControl = true
	granted, _, err := service.Mutate(ctx, host, snap.RoomID, grant)
	if err != nil {
		t.Fatal(err)
	}
	snap = granted.Snapshot
	// Playback authority alone must never grant media replacement.
	expectCode(t, send(g, selection), "forbidden")
	grant = mutation(snap, "settings")
	grant.Settings = snap.Settings
	grant.Settings.EveryoneCanControl = false
	grant.Settings.EveryoneCanSelectMedia = true
	granted, _, err = service.Mutate(ctx, host, snap.RoomID, grant)
	if err != nil {
		t.Fatal(err)
	}
	snap = granted.Snapshot
	// A media controller can start the selected episode through the ordinary wait
	// policy, while subsequent playback commands still require playback authority.
	if err := send(g, selection); err != nil {
		t.Fatal(err)
	}
	if snap.Media == nil || *snap.Media != selection.Media || snap.MediaGeneration != 1 || snap.Barrier == nil || len(snap.Barrier.RequiredMemberIDs) != 2 {
		t.Fatal("play did not freeze cohort")
	}
	oldBarrier := snap.Barrier.BarrierID
	expectCode(t, send(g, contracts.ClientFrame{Type: "playback.command", Action: "rate", Rate: 1.5}), "forbidden")
	if err := send(h, contracts.ClientFrame{Type: "playback.command", Action: "rate", Rate: 1.5}); err != nil {
		t.Fatal(err)
	}
	if snap.Barrier == nil || snap.Barrier.BarrierID != oldBarrier || snap.Barrier.TargetPositionMs != 0 || snap.Playback.Phase != "waiting" || !snap.Playback.DesiredPlaying || snap.Playback.Rate != 1.5 {
		t.Fatal("waiting speed change replaced the barrier or play intent")
	}
	if err := send(h, contracts.ClientFrame{Type: "playback.command", Action: "seek", PositionMs: 10000}); err != nil {
		t.Fatal(err)
	}
	if snap.Playback.Phase != "paused" || snap.Playback.DesiredPlaying || snap.Barrier != nil || snap.Playback.PositionMs != 10000 || snap.Playback.Rate != 1.5 {
		t.Fatal("waiting seek did not cancel play intent")
	}
	position, duration := int64(10000), int64(60000)
	report := contracts.Readiness{Status: "ready", MediaGeneration: snap.MediaGeneration, BarrierID: &oldBarrier, PositionMs: &position, DurationMs: &duration, Capabilities: contracts.Capabilities{CanPlay: true, CanPause: true, CanSeek: true, CanReadPosition: true, CanDetectBuffering: true}}
	err = service.Handle(ctx, g, contracts.ClientFrame{Type: "member.readiness", Epoch: snap.Epoch, Report: report})
	expectCode(t, err, "stale_state")
	if err := send(h, contracts.ClientFrame{Type: "playback.command", Action: "play"}); err != nil {
		t.Fatal(err)
	}
	if snap.Barrier == nil || snap.Barrier.TargetPositionMs != 10000 || snap.Barrier.BarrierID == oldBarrier {
		t.Fatal("explicit play did not start a new wait at the seek target")
	}
	id := snap.Barrier.BarrierID
	report.BarrierID = &id
	if err := service.Handle(ctx, h, contracts.ClientFrame{Type: "member.readiness", Epoch: snap.Epoch, Report: report}); err != nil {
		t.Fatal(err)
	}
	if err := service.Handle(ctx, g, contracts.ClientFrame{Type: "member.readiness", Epoch: snap.Epoch, Report: report}); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		refresh()
		if snap.Playback.Phase == "playing" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stable ready members did not release wait")
		}
		time.Sleep(10 * time.Millisecond)
	}
	refresh()
	if snap.Playback.Phase != "playing" {
		t.Fatal("remaining cohort did not play")
	}
	change := mutation(snap, "settings")
	change.Settings = snap.Settings
	change.Settings.EveryoneCanControl = true
	change.Settings.EveryoneCanSelectMedia = false

	updated, _, err := service.Mutate(ctx, host, snap.RoomID, change)
	if err != nil {
		t.Fatal(err)
	}
	snap = updated.Snapshot
	if snap.Playback.Phase != "playing" {
		t.Fatal("non-waiting settings paused playback")
	}
	beforeRejected := snap
	expectCode(t, send(g, selection), "forbidden")
	refresh()
	if snap.Media == nil || snap.Revision != beforeRejected.Revision || snap.MediaGeneration != beforeRejected.MediaGeneration || snap.Playback.Phase != "playing" || *snap.Media != *beforeRejected.Media {
		t.Fatal("revoked media controller changed the room")
	}
	if err := send(g, contracts.ClientFrame{Type: "playback.command", Action: "rate", Rate: 2}); err != nil {
		t.Fatal("everyone controls did not permit a speed change", err)
	}
	change = mutation(snap, "settings")
	change.Settings = snap.Settings
	change.Settings.WaitForAll = false
	updated, _, err = service.Mutate(ctx, host, snap.RoomID, change)
	if err != nil {
		t.Fatal(err)
	}
	snap = updated.Snapshot
	if snap.Playback.Phase != "paused" || snap.Playback.DesiredPlaying || snap.Barrier != nil {
		t.Fatal("waiting settings retained auto resume")
	}
	if err := send(h, contracts.ClientFrame{Type: "playback.command", Action: "play"}); err != nil {
		t.Fatal(err)
	}
	for _, position := range []int64{20000, 30000} {
		if err := send(h, contracts.ClientFrame{Type: "playback.command", Action: "seek", PositionMs: position}); err != nil {
			t.Fatal(err)
		}
		if snap.Playback.Phase != "paused" || snap.Playback.DesiredPlaying || snap.Barrier != nil || snap.Playback.PositionMs != position || snap.Playback.Rate != 2 {
			t.Fatal("playing or paused seek did not stop at the requested position", snap.Playback)
		}
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
	if snap.Playback.Rate != 1 {
		t.Fatal("new media retained the previous playback speed")
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
	change.Settings.WaitForAll = true
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

func TestDisconnectedCoordinatorPreservesRuntimeDuringDepartureGrace(t *testing.T) {
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
	settings.WaitForAll = false
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
	writes := repository.rejections.Load()
	service.Disconnect(conn)
	time.Sleep(80 * time.Millisecond)
	if repository.rejections.Load() != writes {
		t.Fatal("idle eviction accessed persistence")
	}

	restored, err := service.Snapshot(ctx, host, snap.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	if restored.Epoch != snap.Epoch || restored.MediaGeneration != snap.MediaGeneration {
		t.Fatal("short reconnect lost runtime ownership", restored)
	}
	for _, m := range restored.Members {
		if m.Presence != "offline" || m.Readiness != nil {
			t.Fatal("ephemeral playback state survived eviction")
		}
	}
	clock.Store(35001)
	deadline := time.Now().Add(2 * time.Second)
	for {
		_, err := service.Snapshot(ctx, host, snap.RoomID)
		if err == contracts.Failure("not_found") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("final disconnect did not close after grace", err)
		}
		time.Sleep(5 * time.Millisecond)
	}

}

// Departure contracts have no existing owner: these cases distinguish explicit leave,
// disconnected ownership, failed writes, and restart cleanup using real SQLite.
func TestDepartureGraceHostFallbackAndAtomicClosure(t *testing.T) {
	for _, mode := range []string{"explicit", "disconnect", "failed-write"} {
		t.Run(mode, func(t *testing.T) {
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
			var clock atomic.Int64
			service.Monotonic = clock.Load
			host, guest := participant(t, store, time.Now), participant(t, store, time.Now)
			selected := contracts.MediaDescriptor{Kind: "bilibili", BVID: "BV1TESTaaaaa", CID: "1", Part: 1, DurationMs: 60000}
			settings := contracts.DefaultSettings()
			settings.WaitForAll = false
			createKey := key(t)
			created, err := service.CreateSelected(ctx, host, createKey, "Departure", settings, selected, false)
			if err != nil {
				t.Fatal(err)
			}
			id := created.Snapshot.RoomID
			if id != createKey || created.Snapshot.Media == nil || *created.Snapshot.Media != selected || created.Snapshot.Playback.Phase != "paused" {
				t.Fatal("creation did not install initial media atomically")
			}
			_, err = service.Redeem(ctx, guest, key(t), "code", created.Invitation.Code)
			if err != nil {
				t.Fatal(err)
			}
			hostConn, err := service.Connect(ctx, host, id, &sink{})
			if err != nil {
				t.Fatal(err)
			}
			guestSink := &sink{}
			guestConn, err := service.Connect(ctx, guest, id, guestSink)
			if err != nil {
				t.Fatal(err)
			}
			snap, err := service.Snapshot(ctx, host, id)
			if err != nil {
				t.Fatal(err)
			}
			play := contracts.ClientFrame{Type: "playback.command", Action: "play", CommandID: key(t), Epoch: snap.Epoch, ExpectedRevision: snap.Revision, MediaGeneration: snap.MediaGeneration}
			if err := service.Handle(ctx, hostConn, play); err != nil {
				t.Fatal(err)
			}
			snap, _ = service.Snapshot(ctx, host, id)
			if mode == "explicit" {
				_, _, err = service.Mutate(ctx, host, id, mutation(snap, "leave"))
				if err != nil {
					t.Fatal(err)
				}
			} else {
				service.Disconnect(hostConn)
				clock.Store(29000)
				// Replacing/reconnecting the host before grace must preserve host controls.
				returned, err := service.Connect(ctx, host, id, &sink{})
				if err != nil {
					t.Fatal(err)
				}
				service.Disconnect(hostConn) // An old owner's eventual close cannot drop the replacement.
				before, _ := service.Snapshot(ctx, guest, id)
				if before.Settings.EveryoneCanControl || before.Epoch != snap.Epoch {
					t.Fatal("reconnect prematurely changed ownership")
				}
				service.Disconnect(returned)
				if mode == "failed-write" {
					repository.reject.Store(true)
				}
				clock.Store(59001)
			}
			deadline := time.Now().Add(2 * time.Second)
			for {
				snap, err = service.Snapshot(ctx, guest, id)
				if err != nil {
					t.Fatal(err)
				}
				if mode == "failed-write" {
					guestSink.mu.Lock()
					notices := len(guestSink.frames["error"])
					guestSink.mu.Unlock()
					if notices > 0 {
						break
					}
				} else if snap.Settings.EveryoneCanControl {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("departure transition did not settle")
				}
				time.Sleep(5 * time.Millisecond)
			}
			if snap.Playback.Phase != "playing" {
				t.Fatal("host departure interrupted playback")
			}
			if mode == "failed-write" {
				if snap.Settings.EveryoneCanControl {
					t.Fatal("failed write granted playback permission")
				}
				writes := repository.rejections.Load()
				clock.Store(90000)
				time.Sleep(300 * time.Millisecond)
				if repository.rejections.Load() != writes {
					t.Fatal("lifecycle write was retried automatically")
				}
				return
			}
			control := contracts.ClientFrame{Type: "playback.command", Action: "pause", CommandID: key(t), Epoch: snap.Epoch, ExpectedRevision: snap.Revision, MediaGeneration: snap.MediaGeneration}
			if err := service.Handle(ctx, guestConn, control); err != nil {
				t.Fatal("remaining member cannot control", err)
			}
			// Host-only management is retained even after the playback fallback.
			latest, _ := service.Snapshot(ctx, guest, id)
			_, _, err = service.Mutate(ctx, guest, id, mutation(latest, "rotate"))
			expectCode(t, err, "forbidden")
			if _, err := service.Connect(ctx, host, id, &sink{}); err != nil {
				t.Fatal(err)
			}
			latest, _ = service.Snapshot(ctx, host, id)
			if !latest.Settings.EveryoneCanControl {
				t.Fatal("host return revoked participant controls")
			}
			_, _, err = service.Mutate(ctx, host, id, mutation(latest, "leave"))
			if err != nil {
				t.Fatal(err)
			}
			latest, _ = service.Snapshot(ctx, guest, id)
			_, receipt, err := service.Mutate(ctx, guest, id, mutation(latest, "leave"))
			if err != nil || !receipt.Closed {
				t.Fatal("final explicit departure did not close atomically", err)
			}
			_, err = service.Redeem(ctx, host, key(t), "code", created.Invitation.Code)
			expectCode(t, err, "invalid_invitation")
			persisted, err := store.LoadRooms(ctx)
			if err != nil || len(persisted) != 0 {
				t.Fatal("closed room survived in storage", err)
			}
		})
	}
}

func TestRestoredEmptyRoomHasBoundedReconnectionWindow(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	host := participant(t, store, time.Now)
	service, err := rooms.NewService(store, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	created, err := service.CreateSelected(ctx, host, key(t), "Restart window", contracts.DefaultSettings(), contracts.MediaDescriptor{Kind: "bilibili", BVID: "BV1TESTaaaaa", CID: "1", Part: 1, DurationMs: 10000}, false)
	if err != nil {
		t.Fatal(err)
	}
	service.Close()
	restored, err := rooms.NewService(store, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	var clock atomic.Int64
	restored.Monotonic = clock.Load
	clock.Store(59000)
	snap, err := restored.Snapshot(ctx, host, created.Snapshot.RoomID)
	if err != nil || snap.Epoch == created.Snapshot.Epoch || snap.Playback.PositionMs != 0 || snap.Playback.Phase != "paused" {
		t.Fatal("restart lost reconnection window", err)
	}
	clock.Store(60001)
	deadline := time.Now().Add(2 * time.Second)
	for {
		_, err = restored.Snapshot(ctx, host, snap.RoomID)
		if err == contracts.Failure("not_found") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("unclaimed restored room did not close", err)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
