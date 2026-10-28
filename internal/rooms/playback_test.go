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
	reject atomic.Bool
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
