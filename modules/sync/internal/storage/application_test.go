package storage

import (
	"context"
	"crypto/rand"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/rooms"
	"github.com/swqa7697/open-video-sync/modules/sync/sql/migrations"
)

func TestApplicationUpgradeRollbackAndSecretExclusion(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "ovs.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	initial, err := migrations.Files.ReadFile("0001_schema_migrations.sql")
	if err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, db, fstest.MapFS{"0001_schema_migrations.sql": &fstest.MapFile{Data: initial}}); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	store, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	var versions int
	if err := store.db.QueryRow(`SELECT count(*) FROM schema_migrations`).Scan(&versions); err != nil || versions != 6 {
		t.Fatal("upgrade failed", versions, err)
	}
	identities := &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader}
	host, token, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	service, err := rooms.NewService(store, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	key, _ := contracts.RandomID(rand.Reader)
	created, err := service.Create(ctx, host, key, "Durable", contracts.DefaultSettings())
	if err != nil {
		t.Fatal(err)
	}
	failure := contracts.Failure("invalid_input")
	err = store.Transact(ctx, func(tx rooms.Tx) error {
		settings := contracts.DefaultSettings()
		settings.Controllers = "everyone"
		if err := tx.UpdateSettings(created.Snapshot.RoomID, settings); err != nil {
			return err
		}
		return failure
	})
	if err != failure {
		t.Fatal("rollback failure", err)
	}
	fresh, err := service.Snapshot(ctx, host, created.Snapshot.RoomID)
	if err != nil || fresh.Revision != 1 || fresh.Settings.Controllers != "host" {
		t.Fatal("partial mutation survived rollback", err)
	}
	records, err := store.LoadRooms(ctx)
	if err != nil || len(records) != 1 || records[0].Settings.Controllers != "host" {
		t.Fatal("partial durable change survived rollback", err)
	}

	if _, err := store.db.Exec(`INSERT INTO room_members VALUES(?,?,?,?)`, strings.Repeat("e", 32), host.IdentityID, strings.Repeat("f", 32), 0); err == nil {
		t.Fatal("foreign key violation accepted")
	}
	// Session bearer tokens remain hash-only, including the WAL. Invitations are recoverable.
	for _, name := range []string{"ovs.sqlite", "ovs.sqlite-wal"} {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		for _, secret := range []string{token} {
			if strings.Contains(string(b), secret) {
				t.Fatalf("plaintext credential persisted in %s", name)
			}
		}
	}
}
func TestWriterSaturationCancellationAndFailureReadiness(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	started, release := make(chan struct{}), make(chan struct{})
	first := make(chan error, 1)
	go func() { first <- store.write(ctx, func(*sql.Tx) error { close(started); <-release; return nil }) }()
	<-started
	// Fill the pending transaction budget while the worker is held by one admitted operation.
	jobs := make([]writeJob, 128)
	for i := range jobs {
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		jobs[i] = writeJob{cancelled, func(*sql.Tx) error { t.Error("cancelled callback executed"); return nil }, make(chan error, 1)}
		store.writer.queue <- jobs[i]
	}
	if err := store.write(ctx, func(*sql.Tx) error { return nil }); err != contracts.Failure("busy") {
		t.Fatal("saturated writer admitted work", err)
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	for _, job := range jobs {
		if err := <-job.result; err != context.Canceled {
			t.Fatal("queued cancellation ignored", err)
		}
	}
	// Cancellation can make database/sql return ErrTxDone after its rollback goroutine wins.
	// That outcome must not latch a healthy database as unavailable.
	active, cancelActive := context.WithCancel(ctx)
	err = store.write(active, func(tx *sql.Tx) error {
		cancelActive()
		_ = tx.Rollback()
		return sql.ErrTxDone
	})
	if err == nil {
		t.Fatal("cancelled active write succeeded")
	}
	if err := store.Ready(ctx); err != nil {
		t.Fatal("request cancellation failed storage readiness", err)
	}
	if err := store.write(ctx, func(tx *sql.Tx) error { _, err := tx.Exec(`INSERT INTO missing_table VALUES(1)`); return err }); err == nil {
		t.Fatal("injected storage failure succeeded")
	}
	if store.Ready(ctx) == nil {
		t.Fatal("failed storage remained ready")
	}
	if err := store.write(ctx, func(*sql.Tx) error { t.Error("mutation admitted after storage failure"); return nil }); err != contracts.Failure("storage_unavailable") {
		t.Fatal("failure latch ignored", err)
	}
}

func TestVersionFiveUpgradePreservesSessionsMetadataAndLegacyInvitations(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := sql.Open("sqlite", filepath.Join(dir, "ovs.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{}
	entries, _ := migrations.Files.ReadDir(".")
	for _, entry := range entries {
		if entry.Name() < "0006" {
			data, _ := migrations.Files.ReadFile(entry.Name())
			files[entry.Name()] = &fstest.MapFile{Data: data}
		}
	}
	if err := migrate(ctx, db, files); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UnixMilli()
	id := strings.Repeat("a", 32)
	roomID := strings.Repeat("b", 32)
	mid := strings.Repeat("c", 32)
	token, _ := contracts.RandomSecret(rand.Reader, 32)
	hash, _ := contracts.SecretHash(token, 32)
	csrf, _ := contracts.RandomSecret(rand.Reader, 32)
	link, _ := contracts.RandomSecret(rand.Reader, 16)
	linkHash, _ := contracts.SecretHash(link, 16)
	code := "0123456789ABCDEF"
	settings := `{"v":1,"value":{"controllers":"everyone","syncMode":"seek","waitMode":"all","waitOnBuffering":false,"waitTimeoutMs":5000,"lateJoin":"wait_at_next_play","softDriftMs":200,"hardDriftMs":1000}}`
	media := `{"v":1,"value":{"kind":"bilibili","bvid":"BV1hf4y1N75G","cid":"400306737","part":1,"durationMs":60000}}`
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO identities VALUES(?,?,?,?)`, []any{id, "Legacy name", now, now}},
		{`INSERT INTO sessions VALUES(?,?,?,?,?,?)`, []any{hash, id, csrf, now, now, now + 86400000}},
		{`INSERT INTO rooms VALUES(?,?,?,?,?,?,?)`, []any{roomID, id, "Preserved title", settings, 83, now, now}},
		{`INSERT INTO room_members VALUES(?,?,?,?)`, []any{roomID, id, mid, now}},
		{`INSERT INTO room_invitations VALUES(?,?,?,?,?)`, []any{roomID, 7, linkHash, contracts.Hash([]byte(code)), now + 3600000}},
		{`INSERT INTO room_media VALUES(?,?,?)`, []any{roomID, 99, media}},
		{`INSERT INTO playback_checkpoints VALUES(?,?,?,?)`, []any{roomID, 42000, "playing", now}},
	} {
		if _, err := db.ExecContext(ctx, query.sql, query.args...); err != nil {
			t.Fatal(err)
		}
	}
	expiredID := strings.Repeat("d", 32)
	expiredMember := strings.Repeat("e", 32)
	expiredLink, _ := contracts.RandomSecret(rand.Reader, 16)
	expiredHash, _ := contracts.SecretHash(expiredLink, 16)
	if _, err := db.Exec(`INSERT INTO rooms VALUES(?,?,?,?,?,?,?)`, expiredID, id, "Expired legacy", settings, 7, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO room_members VALUES(?,?,?,?)`, expiredID, id, expiredMember, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO room_invitations VALUES(?,?,?,?,?)`, expiredID, 1, expiredHash, contracts.Hash([]byte("FEDCBA9876543210")), 0); err != nil {
		t.Fatal(err)
	}
	missingID := strings.Repeat("f", 32)
	if _, err := db.Exec(`INSERT INTO rooms VALUES(?,?,?,?,?,?,?)`, missingID, id, "Removed expired invitation", settings, 9, now, now); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO room_members VALUES(?,?,?,?)`, missingID, id, strings.Repeat("1", 32), now); err != nil {
		t.Fatal(err)
	}
	migration, _ := migrations.Files.ReadFile("0006_memory_runtime.sql")
	files["0006_memory_runtime.sql"] = &fstest.MapFile{Data: append(append([]byte{}, migration...), []byte("\nINSERT INTO missing_table VALUES(1);")...)}
	if err := migrate(ctx, db, files); err == nil {
		t.Fatal("broken upgrade succeeded")
	}
	var revision int
	if err := db.QueryRow(`SELECT revision FROM rooms WHERE id=?`, roomID).Scan(&revision); err != nil || revision != 83 {
		t.Fatal("failed upgrade damaged original records", err)
	}
	db.Close()
	store, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	identities := &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader}
	p, err := identities.Authenticate(ctx, token)
	if err != nil || p.IdentityID != id || p.DisplayName != "Legacy name" || p.CSRF != csrf {
		t.Fatal("session continuity lost", err)
	}
	service, err := rooms.NewService(store, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	defer service.Close()
	snap, err := service.Snapshot(ctx, p, roomID)
	if err != nil {
		t.Fatal(err)
	}
	if snap.Title != "Preserved title" || snap.HostMemberID != mid || len(snap.Members) != 1 || snap.Settings != (contracts.RoomSettings{Controllers: "everyone", WaitForAll: true}) || snap.Media == nil || snap.Media.BVID != "BV1hf4y1N75G" || snap.MediaGeneration != 1 || snap.Revision != 1 || snap.Playback.PositionMs != 0 || snap.Playback.Phase != "paused" {
		t.Fatal("upgrade lost durable metadata or restored runtime progress")
	}
	if _, err := service.Invitation(ctx, p, roomID); err != contracts.Failure("invitation_reset_required") {
		t.Fatal("legacy invitation silently replaced", err)
	}
	missing, err := service.Snapshot(ctx, p, missingID)
	if err != nil {
		t.Fatal("old invitation cleanup made room unreadable", err)
	}
	if _, err := service.Invitation(ctx, p, missingID); err != contracts.Failure("invitation_reset_required") {
		t.Fatal("missing legacy invitation did not require explicit replacement", err)
	}
	replacement, _, err := service.Mutate(ctx, p, missingID, rooms.Mutation{Operation: "rotate", Epoch: missing.Epoch, ExpectedRevision: missing.Revision})
	if err != nil || replacement.Invitation == nil {
		t.Fatal("host could not replace missing legacy invitation", err)
	}
	guest, _, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	for kind, secret := range map[string]string{"link": expiredLink, "code": "FEDCBA9876543210"} {
		if _, err := service.Redeem(ctx, guest, recoveryKey(t), kind, secret); err != nil {
			t.Fatal("legacy invitation expired without host rotation", kind, err)
		}
	}
	if _, err := service.Redeem(ctx, guest, recoveryKey(t), "link", link); err != nil {
		t.Fatal("valid legacy invitation lost", err)
	}
	snap, err = service.Snapshot(ctx, p, roomID)
	if err != nil {
		t.Fatal(err)
	}
	reset, _, err := service.Mutate(ctx, p, roomID, rooms.Mutation{Operation: "rotate", Epoch: snap.Epoch, ExpectedRevision: snap.Revision})
	if err != nil {
		t.Fatal(err)
	}
	got, err := service.Invitation(ctx, p, roomID)
	if err != nil || got != *reset.Invitation {
		t.Fatal("new invitation is not reusable", err)
	}
	outsider, _, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Redeem(ctx, outsider, recoveryKey(t), "link", link); err != contracts.Failure("invalid_invitation") {
		t.Fatal("replaced legacy invitation remained valid", err)
	}
}
