package storage

import (
	"context"
	"crypto/rand"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/identity"
	"github.com/swqa7697/open-video-sync/internal/rooms"
)

func TestBoundedRetentionAndActiveRoomProtection(t *testing.T) {
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
	active, err := service.Create(ctx, host, recoveryKey(t), "Active", contracts.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	inactive, err := service.Create(ctx, host, recoveryKey(t), "Inactive", contracts.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Connect(ctx, host, active.Snapshot.RoomID, &recoverySink{}); err != nil {
		t.Fatal(err)
	}
	// More than one batch proves retention is bounded and later calls make progress.
	for i := 0; i < 105; i++ {
		if _, err := store.db.Exec(`INSERT INTO http_idempotency VALUES(?,?,?,?,?,?)`, host.IdentityID, "rooms.create", recoveryKey(t), strings.Repeat("a", 64), inactive.Snapshot.RoomID, wall.Load()-1); err != nil {
			t.Fatal(err)
		}
	}
	wall.Add(int64(31 * 24 * time.Hour / time.Millisecond))
	if err := service.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := store.db.QueryRow(`SELECT count(*) FROM http_idempotency WHERE expires_at_ms<=?`, wall.Load()).Scan(&count); err != nil || count != 7 {
		t.Fatal("cleanup did not respect batch budget", count, err)
	}
	if _, err := service.Snapshot(ctx, host, active.Snapshot.RoomID); err != nil {
		t.Fatal("active room expired", err)
	}
	if _, err := service.Snapshot(ctx, host, inactive.Snapshot.RoomID); err != contracts.Failure("not_found") {
		t.Fatal("inactive room survived TTL", err)
	}
	snap, err := service.Snapshot(ctx, host, active.Snapshot.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	// Expired invitation deletion cannot prevent loading or rotating an otherwise live room.
	if _, _, err := service.Mutate(ctx, host, snap.RoomID, rooms.Mutation{Operation: "rotate", Epoch: snap.Epoch, ExpectedRevision: snap.Revision}); err != nil {
		t.Fatal("expired invitation prevented rotation", err)
	}
	if err := service.Maintain(ctx); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT count(*) FROM http_idempotency WHERE expires_at_ms<=?`, wall.Load()).Scan(&count); err != nil || count != 0 {
		t.Fatal("cleanup did not make progress", count, err)
	}
	// Membership/ownership retain identities after their sessions expire; isolated identities are removed.
	orphan, _, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE sessions SET expires_at_ms=created_at_ms+1 WHERE identity_id=?`, orphan.IdentityID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`UPDATE identities SET last_seen_at_ms=? WHERE id IN (?,?)`, wall.Load()-366*86400000, host.IdentityID, orphan.IdentityID); err != nil {
		t.Fatal(err)
	}
	wall.Add(2)
	if err := store.CleanupRetention(ctx, wall.Load()); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT count(*) FROM identities WHERE id=?`, orphan.IdentityID).Scan(&count); err != nil || count != 0 {
		t.Fatal("eligible identity survived cleanup", err)
	}
	if err := store.db.QueryRow(`SELECT count(*) FROM identities WHERE id=?`, host.IdentityID).Scan(&count); err != nil || count != 1 {
		t.Fatal("owned identity was deleted", err)
	}
}
