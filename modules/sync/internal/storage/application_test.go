package storage

import (
	"context"
	"crypto/rand"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/rooms"
)

func TestApplicationRollbackAndSecretExclusion(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
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
