package storage

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/swqa7697/open-video-sync/modules/sync/sql"
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
	const id = "0123456789abcdef0123456789abcdef"
	if _, err := store.db.ExecContext(ctx, "INSERT INTO identities VALUES (?, ?, ?)", id, "Saved name", 1); err != nil {
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
	if err := reopened.db.QueryRowContext(ctx, "SELECT display_name FROM identities WHERE id=?", id).Scan(&saved); err != nil || saved != "Saved name" {
		t.Fatalf("identity did not survive reopen: %q, %v", saved, err)
	}
}

func TestSchemaInitializationRollsBackAndRejectsUnsupportedDatabases(t *testing.T) {
	ctx := context.Background()
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "ovs.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := initializeSchema(ctx, db, schema.Definition+"\nINSERT INTO missing_table VALUES (1);"); err == nil {
		t.Fatal("invalid schema succeeded")
	}
	var count, version int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_schema").Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed DDL was not rolled back: %d, %v", count, err)
	}
	if err := db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil || version != 0 {
		t.Fatalf("failed initialization recorded a version: %d, %v", version, err)
	}
	if err := initializeSchema(ctx, db, schema.Definition); err != nil {
		t.Fatal(err)
	}
	const id = "0123456789abcdef0123456789abcdef"
	if _, err := db.ExecContext(ctx, "INSERT INTO identities VALUES (?, ?, ?)", id, "Saved name", 1); err != nil {
		t.Fatal(err)
	}
	if err := initializeSchema(ctx, db, schema.Definition); err != nil {
		t.Fatal("initialized schema could not be reopened", err)
	}
	for _, next := range []string{"PRAGMA user_version = 2", "PRAGMA user_version = 0"} {
		if _, err := db.ExecContext(ctx, next); err != nil {
			t.Fatal(err)
		}
		if err := initializeSchema(ctx, db, schema.Definition); err == nil {
			t.Fatal("unsupported database was accepted", next)
		}
		var name string
		if err := db.QueryRowContext(ctx, "SELECT display_name FROM identities WHERE id=?", id).Scan(&name); err != nil || name != "Saved name" {
			t.Fatalf("rejected initialization damaged stored data: %q, %v", name, err)
		}
	}
}
