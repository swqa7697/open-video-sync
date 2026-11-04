package storage

import (
	"context"
	"crypto/rand"
	"sync/atomic"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/rooms"
)

// Every application persistence entry point is instrumented, including startup loads.
type countedStorage struct {
	*Store
	operations atomic.Int64
}

func (c *countedStorage) LoadRooms(ctx context.Context) ([]rooms.Room, error) {
	c.operations.Add(1)
	return c.Store.LoadRooms(ctx)
}
func (c *countedStorage) LoadSessions(ctx context.Context, now int64) ([]identity.Session, error) {
	c.operations.Add(1)
	return c.Store.LoadSessions(ctx, now)
}
func (c *countedStorage) Transact(ctx context.Context, run func(rooms.Tx) error) error {
	c.operations.Add(1)
	return c.Store.Transact(ctx, run)
}
func (c *countedStorage) CreateSession(ctx context.Context, p identity.Session) error {
	c.operations.Add(1)
	return c.Store.CreateSession(ctx, p)
}
func (c *countedStorage) RenewSession(ctx context.Context, h string, n, e int64) error {
	c.operations.Add(1)
	return c.Store.RenewSession(ctx, h, n, e)
}
func (c *countedStorage) Rename(ctx context.Context, h, n string, now int64) error {
	c.operations.Add(1)
	return c.Store.Rename(ctx, h, n, now)
}
func (c *countedStorage) Revoke(ctx context.Context, h string, now int64) error {
	c.operations.Add(1)
	return c.Store.Revoke(ctx, h, now)
}

func TestInitializedReadsAuthorizationPlaybackReadinessAndTicksPerformZeroStorageOperations(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	counted := &countedStorage{Store: store}
	var wall, mono atomic.Int64
	wall.Store(time.Now().UnixMilli())
	clock := func() time.Time { return time.UnixMilli(wall.Load()) }
	identities := &identity.Service{Repository: counted, Now: clock, Random: rand.Reader}
	host, token, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	service, err := rooms.NewService(counted, clock, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	service.Monotonic = mono.Load
	service.SessionValid = identities.Validate
	identities.OnRevoked = service.RevokeSession
	created, err := service.Create(ctx, host, recoveryKey(t), "Memory runtime", contracts.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	conn, err := service.Connect(ctx, host, created.Snapshot.RoomID, &recoverySink{})
	if err != nil {
		t.Fatal(err)
	}
	snap := created.Snapshot
	send := func(action string) {
		t.Helper()
		f := contracts.ClientFrame{Type: "playback.command", Action: action, CommandID: recoveryKey(t), Epoch: snap.Epoch, ExpectedRevision: snap.Revision, MediaGeneration: snap.MediaGeneration}
		if err := service.Handle(ctx, conn, f); err != nil {
			t.Fatal(err)
		}
		snap, err = service.Snapshot(ctx, host, snap.RoomID)
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := service.Handle(ctx, conn, contracts.ClientFrame{Type: "media.select", CommandID: recoveryKey(t), Epoch: snap.Epoch, ExpectedRevision: snap.Revision, Media: contracts.MediaDescriptor{Kind: "bilibili", BVID: "BV1TESTaaaaa", CID: "9000000000001", Part: 1, DurationMs: 60000}}); err != nil {
		t.Fatal(err)
	}
	snap, err = service.Snapshot(ctx, host, snap.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	baseline := counted.operations.Load()
	// Closing the actual SQL connection also catches accidental health probes or
	// reads that bypass an instrumented repository method.
	if err := store.db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := identities.Authenticate(ctx, token); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := identities.Bootstrap(ctx, token); err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.List(ctx, host, "", 20); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Invitation(ctx, host, snap.RoomID); err != nil {
		t.Fatal(err)
	}
	if err := service.CheckConnection(ctx, conn); err != nil {
		t.Fatal(err)
	}
	if err := store.Ready(ctx); err != nil {
		t.Fatal(err)
	}
	send("play")
	b := snap.Barrier
	if b == nil {
		t.Fatal("play did not wait")
	}
	position, duration := int64(0), int64(60000)
	report := contracts.Readiness{Status: "ready", MediaGeneration: 1, BarrierID: &b.BarrierID, PositionMs: &position, DurationMs: &duration, Capabilities: contracts.Capabilities{CanPlay: true, CanPause: true, CanSeek: true, CanReadPosition: true, CanDetectBuffering: true}}
	if err := service.Handle(ctx, conn, contracts.ClientFrame{Type: "member.readiness", Epoch: snap.Epoch, Report: report}); err != nil {
		t.Fatal(err)
	}
	mono.Store(1000)
	deadline := time.Now().Add(2 * time.Second)
	for {
		snap, err = service.Snapshot(ctx, host, snap.RoomID)
		if err != nil {
			t.Fatal(err)
		}
		if snap.Playback.Phase == "playing" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stable-ready timer did not play")
		}
		time.Sleep(10 * time.Millisecond)
	}
	send("pause")
	send("replay")
	mono.Store(32000)
	for {
		snap, err = service.Snapshot(ctx, host, snap.RoomID)
		if err != nil {
			t.Fatal(err)
		}
		if snap.Playback.Phase == "paused" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("waiting deadline did not pause")
		}
		time.Sleep(10 * time.Millisecond)
	}
	wall.Add(366 * 86400000)
	if _, err := identities.Authenticate(ctx, token); err != contracts.Failure("session_required") {
		t.Fatal("expired memory session accepted", err)
	}
	if err := service.CheckConnection(ctx, conn); err != contracts.Failure("session_required") {
		t.Fatal("expired socket retained authority", err)
	}
	if got := counted.operations.Load() - baseline; got != 0 {
		t.Fatalf("initialized runtime performed %d persistence operations", got)
	}
}

func (c *countedStorage) CleanupSessions(ctx context.Context, now int64) error {
	c.operations.Add(1)
	return c.Store.CleanupSessions(ctx, now)
}
