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
		settings.EveryoneCanControl = true
		settings.EveryoneCanSelectMedia = true
		if err := tx.UpdateSettings(created.Snapshot.RoomID, settings); err != nil {
			return err
		}
		return failure
	})
	if err != failure {
		t.Fatal("rollback failure", err)
	}
	fresh, err := service.Snapshot(ctx, host, created.Snapshot.RoomID)
	if err != nil || fresh.Revision != 1 || fresh.Settings.EveryoneCanControl || fresh.Settings.EveryoneCanSelectMedia {
		t.Fatal("partial mutation survived rollback", err)
	}
	records, err := store.LoadRooms(ctx)
	if err != nil || len(records) != 1 || records[0].Settings.EveryoneCanControl || records[0].Settings.EveryoneCanSelectMedia {
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

// The persisted settings format can advance without changing SQLite tables or
// weakening the complete public settings contract.
func TestStoredRoomSettingsVersions(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = store.Close() }()
	identities := &identity.Service{Repository: store, Now: time.Now, Random: rand.Reader}
	host, _, _, err := identities.Bootstrap(ctx, "")
	if err != nil {
		t.Fatal(err)
	}
	service, err := rooms.NewService(store, time.Now, rand.Reader, rooms.DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	created, err := service.Create(ctx, host, recoveryKey(t), "Settings compatibility", contracts.DefaultSettings())
	service.Close()
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, raw string
		want      contracts.RoomSettings
		valid     bool
	}{
		{"v2 shared playback restricted media", `{"v":2,"value":{"controllers":"everyone","waitForAll":false}}`, contracts.RoomSettings{EveryoneCanControl: true}, true},
		{"v2 host defaults", `{"v":2,"value":{"controllers":"host","waitForAll":true}}`, contracts.DefaultSettings(), true},
		{"v3 independent media permission", `{"v":3,"value":{"controllers":"host","mediaControllers":"everyone","waitForAll":true}}`, contracts.RoomSettings{EveryoneCanSelectMedia: true, WaitForAll: true}, true},
		{"v3 independent playback permission", `{"v":3,"value":{"controllers":"everyone","mediaControllers":"host","waitForAll":false}}`, contracts.RoomSettings{EveryoneCanControl: true}, true},
		{"v4 shared permissions", `{"v":4,"value":{"everyoneCanControl":true,"everyoneCanSelectMedia":true,"waitForAll":false}}`, contracts.RoomSettings{EveryoneCanControl: true, EveryoneCanSelectMedia: true}, true},
		{"current missing permission", `{"v":4,"value":{"everyoneCanControl":false,"waitForAll":true}}`, contracts.RoomSettings{}, false},
		{"legacy missing permission", `{"v":3,"value":{"controllers":"host","waitForAll":true}}`, contracts.RoomSettings{}, false},
		{"legacy extra permission", `{"v":2,"value":{"controllers":"host","mediaControllers":"everyone","waitForAll":true}}`, contracts.RoomSettings{}, false},
		{"unknown version", `{"v":5,"value":{"everyoneCanControl":false,"everyoneCanSelectMedia":false,"waitForAll":true}}`, contracts.RoomSettings{}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := store.db.ExecContext(ctx, `UPDATE rooms SET settings=? WHERE id=?`, tc.raw, created.Snapshot.RoomID); err != nil {
				t.Fatal(err)
			}
			if err := store.Close(); err != nil {
				t.Fatal(err)
			}
			store, err = Open(ctx, dir)
			if err != nil {
				t.Fatal(err)
			}
			records, err := store.LoadRooms(ctx)
			if !tc.valid {
				if err == nil {
					t.Fatal("invalid stored settings were accepted")
				}
				return
			}
			if err != nil || len(records) != 1 || records[0].Settings != tc.want {
				t.Fatal("stored settings did not survive reopening", records, err)
			}
			var raw string
			if err := store.db.QueryRowContext(ctx, `SELECT settings FROM rooms WHERE id=?`, created.Snapshot.RoomID).Scan(&raw); err != nil || raw != tc.raw {
				t.Fatal("loading settings rewrote stored data", err)
			}
		})
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
