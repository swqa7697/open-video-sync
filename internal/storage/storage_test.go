package storage

import (
	"context"
	"testing"
	"testing/fstest"

	"github.com/swqa7697/open-video-sync/migrations"
)

func TestOpenOwnershipAndReopen(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	store, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	if second, err := Open(ctx, dir); err == nil {
		_ = second.Close()
		t.Fatal("second owner was admitted")
	}
	for name, want := range map[string]string{"foreign_keys": "1", "journal_mode": "wal", "busy_timeout": "5000", "synchronous": "2"} {
		var got string
		if err := store.db.QueryRowContext(ctx, "PRAGMA "+name).Scan(&got); err != nil || got != want {
			t.Fatalf("%s = %q, error %v; want %q", name, got, err, want)
		}
	}
	version, err := store.SQLiteVersion(ctx)
	if err != nil || version == "" {
		t.Fatalf("engine version %q: %v", version, err)
	}
	t.Logf("SQLite engine: %s", version)
	var checksum string
	if err := store.db.QueryRowContext(ctx, "SELECT checksum FROM schema_migrations WHERE version=1").Scan(&checksum); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(ctx, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	var saved string
	if err := reopened.db.QueryRowContext(ctx, "SELECT checksum FROM schema_migrations WHERE version=1").Scan(&saved); err != nil || saved != checksum {
		t.Fatalf("migration ledger did not survive reopen: %q, %v", saved, err)
	}
}

func TestMigrationsRejectChangesAndRollBack(t *testing.T) {
	ctx := context.Background()
	store, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	initial, err := migrations.Files.ReadFile("0001_schema_migrations.sql")
	if err != nil {
		t.Fatal(err)
	}
	files := fstest.MapFS{
		"0001_schema_migrations.sql": {Data: initial},
		"0002_probe.sql":             {Data: []byte("CREATE TABLE probe (id INTEGER PRIMARY KEY); INSERT INTO missing_table VALUES (1);")},
	}
	if err := migrate(ctx, store.db, files); err == nil {
		t.Fatal("invalid migration succeeded")
	}
	var count int
	if err := store.db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE name='probe'").Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed DDL was not rolled back: %d, %v", count, err)
	}
	files["0002_probe.sql"].Data = []byte("CREATE TABLE probe (id INTEGER PRIMARY KEY); INSERT INTO probe VALUES (7);")
	if err := migrate(ctx, store.db, files); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, "SELECT id FROM probe").Scan(&count); err != nil || count != 7 {
		t.Fatalf("upgrade failed: %d, %v", count, err)
	}
	if err := migrate(ctx, store.db, migrations.Files); err == nil {
		t.Fatal("newer schema was accepted")
	}
	files["0001_schema_migrations.sql"].Data = append(initial, '\n')
	if err := migrate(ctx, store.db, files); err == nil {
		t.Fatal("changed applied migration was accepted")
	}
	if err := store.db.QueryRowContext(ctx, "SELECT id FROM probe").Scan(&count); err != nil || count != 7 {
		t.Fatalf("rejected migration damaged stored data: %d, %v", count, err)
	}
}
