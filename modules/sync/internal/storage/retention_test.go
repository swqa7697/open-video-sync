package storage

import (
	"context"
	"crypto/rand"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/rooms"
	"sync/atomic"
	"testing"
	"time"
)

func TestExpiredSessionCleanupPreservesRoomsInvitationsAndIdentities(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	var wall atomic.Int64
	wall.Store(time.Now().UnixMilli())
	clock := func() time.Time { return time.UnixMilli(wall.Load()) }
	identities := &identity.Service{Repository: store, Now: clock, Random: rand.Reader}
	host, _, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	service, err := rooms.NewService(store, clock, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	created, err := service.Create(ctx, host, recoveryKey(t), "Persistent room", contracts.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	wall.Add(31 * 86400000)
	if err := store.CleanupSessions(ctx, wall.Load()); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Snapshot(ctx, host, created.Snapshot.RoomID); err != nil {
		t.Fatal("inactive room expired", err)
	}
	guest, _, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Redeem(ctx, guest, recoveryKey(t), "code", created.Invitation.Code); err != nil {
		t.Fatal("reusable invitation expired", err)
	}
	wall.Add(400 * 86400000)
	if _, err := identities.Authenticate(ctx, "invalid"); err == nil {
		t.Fatal("invalid credential accepted")
	}
	if err := store.CleanupSessions(ctx, wall.Load()); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := store.db.QueryRow(`SELECT count(*) FROM identities`).Scan(&count); err != nil || count != 2 {
		t.Fatal("identity cleanup removed ownership", count, err)
	}
	if err := store.db.QueryRow(`SELECT count(*) FROM sessions`).Scan(&count); err != nil || count != 0 {
		t.Fatal("expired credentials survived cleanup", count, err)
	}
}
