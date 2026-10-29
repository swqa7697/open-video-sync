package rooms_test

import (
	"context"
	"crypto/rand"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/identity"
	"github.com/swqa7697/open-video-sync/internal/rooms"
	"github.com/swqa7697/open-video-sync/internal/storage"
)

func key(t *testing.T) string {
	t.Helper()
	v, err := contracts.RandomID(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func participant(t *testing.T, store *storage.Store, now func() time.Time) identity.Session {
	t.Helper()
	s, _, _, err := (&identity.Service{Repository: store, Now: now, Random: rand.Reader}).Bootstrap(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	return s
}
func expectCode(t *testing.T, err error, code string) {
	t.Helper()
	if err != contracts.Failure(code) {
		t.Fatalf("error=%v, want %s", err, code)
	}
}
func mutation(snapshot rooms.Snapshot, operation string) rooms.Mutation {
	return rooms.Mutation{Epoch: snapshot.Epoch, ExpectedRevision: snapshot.Revision, Operation: operation}
}
func TestPrivateRoomLifecycleRetriesAndRestart(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store, err := storage.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	now := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	service, err := rooms.NewService(store, clock, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { service.Close() }()
	host := participant(t, store, clock)
	guest := participant(t, store, clock)
	outsider := participant(t, store, clock)
	createKey := key(t)
	created, err := service.Create(ctx, host, createKey, "Private <room>", contracts.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	id := created.Snapshot.RoomID
	if created.Snapshot.Revision != 1 || len(created.Snapshot.Members) != 1 || created.Invitation == nil {
		t.Fatal("incomplete atomic creation")
	}
	replay, err := service.Create(ctx, host, createKey, "Private <room>", contracts.DefaultSettings())
	if err != nil || !replay.Replayed || replay.Invitation == nil {
		t.Fatal("create retry lost current host invitation", err)
	}
	_, err = service.Create(ctx, host, createKey, "Different", contracts.DefaultSettings())
	expectCode(t, err, "idempotency_conflict")
	_, err = service.Snapshot(ctx, outsider, id)
	expectCode(t, err, "not_found")
	list, _, err := service.List(ctx, outsider, "", 20)
	if err != nil || len(list) != 0 {
		t.Fatal("private listing leaked")
	}
	redeemKey := key(t)
	joined, err := service.Redeem(ctx, guest, redeemKey, "code", strings.ToLower(created.Invitation.Code[:4])+"-"+created.Invitation.Code[4:])
	if err != nil {
		t.Fatal(err)
	}
	if len(joined.Snapshot.Members) != 2 || joined.Snapshot.Revision != 2 {
		t.Fatal("incorrect join")
	}
	repeated, err := service.Redeem(ctx, guest, key(t), "link", created.Invitation.LinkSecret)
	if err != nil || repeated.Snapshot.Revision != 2 {
		t.Fatal("repeat membership changed revision", err)
	}
	_, _, err = service.Mutate(ctx, guest, id, mutation(joined.Snapshot, "rotate"))
	expectCode(t, err, "forbidden")
	// A stale request is disclosed only after membership/authority checks.
	stale := mutation(created.Snapshot, "settings")
	stale.Settings = contracts.DefaultSettings()
	_, _, err = service.Mutate(ctx, host, id, stale)
	expectCode(t, err, "stale_state")
	_, _, err = service.Mutate(ctx, outsider, id, stale)
	expectCode(t, err, "not_found")
	settings := mutation(joined.Snapshot, "settings")
	settings.Settings = contracts.DefaultSettings()
	settings.Settings.Controllers = "everyone"
	updated, _, err := service.Mutate(ctx, host, id, settings)
	if err != nil {
		t.Fatal(err)
	}
	rotated, _, err := service.Mutate(ctx, host, id, mutation(updated.Snapshot, "rotate"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Redeem(ctx, outsider, key(t), "code", created.Invitation.Code)
	expectCode(t, err, "invalid_invitation")
	recovered, err := service.Redeem(ctx, guest, redeemKey, "code", created.Invitation.Code)
	if err != nil || !recovered.Replayed {
		t.Fatal("retry lost after rotation", err)
	}
	// A second room has independent revision and membership.
	other, err := service.Create(ctx, outsider, key(t), "Other", contracts.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	otherSnapshot, err := service.Snapshot(ctx, outsider, other.Snapshot.RoomID)
	if err != nil || otherSnapshot.Revision != 1 || len(otherSnapshot.Members) != 1 {
		t.Fatal("cross-room mutation")
	}

	_, err = service.Create(ctx, outsider, key(t), "Another private room", contracts.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	page, next, err := service.List(ctx, outsider, "", 1)
	if err != nil || len(page) != 1 || next == nil {
		t.Fatal("first page invalid", err)
	}
	tail, last, err := service.List(ctx, outsider, *next, 1)
	if err != nil || len(tail) != 1 || last != nil || tail[0].RoomID <= page[0].RoomID {
		t.Fatal("cursor pagination invalid", err)
	}

	oldEpoch := rotated.Snapshot.Epoch
	service.Close()
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	store, err = storage.Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	service, err = rooms.NewService(store, clock, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := service.Snapshot(ctx, host, id)
	if err != nil || fresh.Epoch == oldEpoch || fresh.Revision != 1 || fresh.Settings.Controllers != "everyone" {
		t.Fatal("restart lost state", err)
	}
	_, err = service.RecoverCreate(ctx, host, createKey, "Private <room>", contracts.DefaultSettings())
	expectCode(t, err, "request_outcome_unknown")
	removeHost := mutation(fresh, "remove")
	removeHost.MemberID = fresh.HostMemberID
	_, _, err = service.Mutate(ctx, host, id, removeHost)
	expectCode(t, err, "forbidden")
	var guestID string
	for _, m := range fresh.Members {
		if m.Role == "participant" {
			guestID = m.MemberID
		}
	}
	removedHook := false
	service.OnRemoved = func(room, member string) { removedHook = room == id && member == guestID }
	remove := mutation(fresh, "remove")
	remove.MemberID = guestID
	_, receipt, err := service.Mutate(ctx, host, id, remove)
	if err != nil || receipt.RemovedMemberID != guestID || !removedHook {
		t.Fatal("removal failed", err)
	}
	_, err = service.Snapshot(ctx, guest, id)
	expectCode(t, err, "not_found")
	_, err = service.Redeem(ctx, guest, redeemKey, "code", created.Invitation.Code)
	expectCode(t, err, "invalid_invitation")
	_, err = service.Redeem(ctx, guest, key(t), "code", rotated.Invitation.Code)
	expectCode(t, err, "invalid_invitation")
	fresh, err = service.Snapshot(ctx, host, id)
	if err != nil {
		t.Fatal(err)
	}
	latest, _, err := service.Mutate(ctx, host, id, mutation(fresh, "rotate"))
	if err != nil {
		t.Fatal(err)
	}
	closedHook := false
	service.OnClosed = func(string) { closedHook = true }
	_, receipt, err = service.Mutate(ctx, host, id, mutation(latest.Snapshot, "close"))
	if err != nil || !receipt.Closed || !closedHook {
		t.Fatal("close failed", err)
	}
	_, err = service.Redeem(ctx, guest, key(t), "code", latest.Invitation.Code)
	expectCode(t, err, "invalid_invitation")

	list, _, err = service.List(ctx, host, "", 20)
	if err != nil || len(list) != 0 {
		t.Fatal("closed room still listed")
	}
}
func TestCapacityExpiryLeaveAndSerializedSettings(t *testing.T) {
	ctx := context.Background()
	store, err := storage.Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	now := time.Date(2026, 10, 27, 0, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	limits := rooms.DefaultLimits()
	limits.MaxMembers = 2
	service, err := rooms.NewService(store, clock, rand.Reader, limits)
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	host := participant(t, store, clock)
	peers := []identity.Session{participant(t, store, clock), participant(t, store, clock)}
	created, err := service.Create(ctx, host, key(t), "Capacity", contracts.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	keys := []string{key(t), key(t)}
	results := make([]rooms.Result, 2)
	errs := make([]error, 2)
	var wg sync.WaitGroup
	for i := range peers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i], errs[i] = service.Redeem(ctx, peers[i], keys[i], "code", created.Invitation.Code)
		}()
	}
	wg.Wait()
	winner := -1
	for i, err := range errs {
		if err == nil {
			if winner != -1 {
				t.Fatal("capacity race admitted both")
			}
			winner = i
		} else {
			expectCode(t, err, "capacity_reached")
		}
	}
	if winner == -1 {
		t.Fatal("no admission")
	}
	snap := results[winner].Snapshot
	// HTTP settings and a service-level coordinator command race from the same revision.
	m := mutation(snap, "settings")
	m.Settings = contracts.DefaultSettings()
	m.Settings.Controllers = "everyone"
	errs = make([]error, 2)
	for i := range errs {
		wg.Add(1)
		go func() { defer wg.Done(); _, _, errs[i] = service.Mutate(ctx, host, snap.RoomID, m) }()
	}
	wg.Wait()
	accepted := 0
	for _, err := range errs {
		if err == nil {
			accepted++
		} else {
			expectCode(t, err, "stale_state")
		}
	}
	if accepted != 1 {
		t.Fatal("serialized requests both accepted")
	}
	snap, err = service.Snapshot(ctx, host, snap.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	leave := mutation(snap, "remove")
	for _, member := range snap.Members {
		if member.Role == "participant" {
			leave.MemberID = member.MemberID
		}
	}
	_, _, err = service.Mutate(ctx, peers[winner], snap.RoomID, leave)
	if err != nil {
		t.Fatal("self-leave failed", err)
	}
	snap, err = service.Snapshot(ctx, host, snap.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	rotated, _, err := service.Mutate(ctx, host, snap.RoomID, mutation(snap, "rotate"))
	if err != nil {
		t.Fatal(err)
	}
	now = now.Add(7 * 24 * time.Hour)
	_, err = service.Redeem(ctx, peers[1-winner], key(t), "link", rotated.Invitation.LinkSecret)
	if err != nil {
		t.Fatal("reusable invitation expired", err)
	}
	// Session revocation is enforced again inside room transactions.
	if err := (&identity.Service{Repository: store, Now: clock, Random: rand.Reader, OnRevoked: service.RevokeSession}).Forget(ctx, host); err != nil {
		t.Fatal(err)
	}
	_, err = service.Snapshot(ctx, host, snap.RoomID)
	expectCode(t, err, "session_required")
}
