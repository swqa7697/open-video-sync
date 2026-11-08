package storage

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/swqa7697/open-video-sync/modules/sync/sql"
)

func TestDeploymentMigrationPreservesStateAndMatchesFreshSchema(t *testing.T) {
	ctx := context.Background()
	directory := t.TempDir()
	db := legacyDatabase(t, directory)
	const identity = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const room = "dddddddddddddddddddddddddddddddd"
	for _, statement := range []string{
		`INSERT INTO identities VALUES('` + identity + `','Existing viewer',1)`,
		`INSERT INTO sessions VALUES('` + strings.Repeat("b", 64) + `','` + identity + `','` + strings.Repeat("c", 43) + `',1,2,1000)`,
		`INSERT INTO rooms VALUES('` + room + `','` + identity + `','Existing room','{"v":4,"value":{"everyoneCanControl":false,"everyoneCanSelectMedia":false,"waitForAll":true}}',1)`,
		`INSERT INTO room_members VALUES('` + room + `','` + identity + `','` + strings.Repeat("e", 32) + `',2)`,
		`INSERT INTO room_invitations VALUES('` + room + `',1,'` + strings.Repeat("f", 64) + `','` + strings.Repeat("a", 64) + `','` + strings.Repeat("b", 22) + `','` + strings.Repeat("c", 16) + `')`,
		`INSERT INTO room_media VALUES('` + room + `','{"v":1,"value":{"kind":"bilibili","bvid":"BV1TESTaaaaa","cid":"1","part":2,"durationMs":1000}}')`,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	before := applicationRows(t, db)
	if store, err := Open(ctx, directory); err == nil {
		_ = store.Close()
		t.Fatal("server startup migrated the old schema")
	} else if !strings.Contains(err.Error(), "ovs migrate") {
		t.Fatal("old schema rejection did not explain the deployment step", err)
	}
	assertVersion(t, db, 1)
	if !reflect.DeepEqual(applicationRows(t, db), before) {
		t.Fatal("rejected server startup changed application data")
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, directory); err != nil {
		t.Fatal(err)
	}
	upgraded, err := Open(ctx, directory)
	if err != nil {
		t.Fatal("migrated database could not start", err)
	}
	if !reflect.DeepEqual(applicationRows(t, upgraded.db), before) {
		t.Fatal("deployment migration changed existing application data")
	}
	assertVersion(t, upgraded.db, schemaVersion)
	if _, err := upgraded.db.ExecContext(ctx, `INSERT INTO watch_history VALUES(?,?,'{"kind":"bilibili","bvid":"BV1TESTaaaaa","cid":"1","part":2}',10)`, identity, strings.Repeat("d", 32)); err != nil {
		t.Fatal("upgraded database does not support history", err)
	}
	fresh, err := Open(ctx, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	const schemaQuery = "SELECT name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name"
	if !reflect.DeepEqual(databaseRows(t, upgraded.db, schemaQuery), databaseRows(t, fresh.db, schemaQuery)) {
		t.Fatal("fresh and upgraded schemas differ")
	}
	ledger := databaseRows(t, upgraded.db, "SELECT * FROM schema_migrations ORDER BY migration_id")
	if err := upgraded.Close(); err != nil {
		t.Fatal(err)
	}
	if err := Migrate(ctx, directory); err != nil {
		t.Fatal("repeated deployment migration failed", err)
	}
	reopened, err := Open(ctx, directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if !reflect.DeepEqual(databaseRows(t, reopened.db, "SELECT * FROM schema_migrations ORDER BY migration_id"), ledger) {
		t.Fatal("reopening or repeated deployment rewrote the ledger")
	}
	if rows := databaseRows(t, reopened.db, "SELECT * FROM watch_history"); len(rows) != 1 {
		t.Fatal("history did not survive reopen")
	}
}

func TestMigrationAtomicityAndLedgerValidation(t *testing.T) {
	ctx := context.Background()
	t.Run("failed upgrade rolls back and can retry", func(t *testing.T) {
		directory := t.TempDir()
		db := legacyDatabase(t, directory)
		defer db.Close()
		const query = "SELECT name,sql FROM sqlite_schema ORDER BY name"
		before := databaseRows(t, db, query)
		migrations := schema.Migrations()
		migrations[0].SQL += "\nINSERT INTO missing_table VALUES(1);"
		if err := prepareSchema(ctx, db, schema.Definition, migrations, true); err == nil {
			t.Fatal("broken upgrade succeeded")
		}
		assertVersion(t, db, 1)
		if !reflect.DeepEqual(databaseRows(t, db, query), before) {
			t.Fatal("failed migration retained partial DDL or ledger changes")
		}
		if _, err := db.ExecContext(ctx, "CREATE TABLE watch_history(conflict TEXT)"); err != nil {
			t.Fatal(err)
		}
		if err := Migrate(ctx, directory); err == nil {
			t.Fatal("conflicting deployment migration succeeded")
		}
		assertVersion(t, db, 1)
		if _, err := db.ExecContext(ctx, "DROP TABLE watch_history"); err != nil {
			t.Fatal(err)
		}
		if err := Migrate(ctx, directory); err != nil {
			t.Fatal("failed deployment retained its connection or ownership lock", err)
		}
		assertVersion(t, db, schemaVersion)
	})
	t.Run("fresh schema skips historical SQL", func(t *testing.T) {
		db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "ovs.sqlite"))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		migrations := schema.Migrations()
		migrations[0].SQL = "INSERT INTO missing_table VALUES(1);"
		if err := prepareSchema(ctx, db, schema.Definition, migrations, true); err != nil {
			t.Fatal("fresh initialization executed historical SQL", err)
		}
		if err := prepareSchema(ctx, db, schema.Definition, migrations, false); err != nil {
			t.Fatal("fresh initialization did not record included migrations", err)
		}
		assertVersion(t, db, schemaVersion)
	})
	for _, change := range []struct{ name, statement string }{
		{"missing entry", "DELETE FROM schema_migrations"},
		{"changed checksum", "UPDATE schema_migrations SET checksum='" + strings.Repeat("0", 64) + "'"},
		{"unknown entry", "INSERT INTO schema_migrations VALUES(999,'" + strings.Repeat("0", 64) + "',0)"},
	} {
		t.Run(change.name, func(t *testing.T) {
			store, err := Open(ctx, t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			if _, err := store.db.ExecContext(ctx, change.statement); err != nil {
				t.Fatal(err)
			}
			before := databaseRows(t, store.db, "SELECT * FROM schema_migrations ORDER BY migration_id")
			for _, upgrade := range []bool{false, true} {
				if err := prepareSchema(ctx, store.db, schema.Definition, schema.Migrations(), upgrade); err == nil {
					t.Fatal("invalid ledger was accepted")
				}
			}
			assertVersion(t, store.db, schemaVersion)
			if !reflect.DeepEqual(databaseRows(t, store.db, "SELECT * FROM schema_migrations ORDER BY migration_id"), before) {
				t.Fatal("rejection modified the migration ledger")
			}
		})
	}
	t.Run("missing migration registry", func(t *testing.T) {
		db := legacyDatabase(t, t.TempDir())
		defer db.Close()
		if err := prepareSchema(ctx, db, schema.Definition, nil, true); err == nil {
			t.Fatal("migration with no path was accepted")
		}
		assertVersion(t, db, 1)
	})
}

func TestSchemaReleaseUsesIndependentMigrationLedger(t *testing.T) {
	ctx := context.Background()
	db := legacyDatabase(t, t.TempDir())
	defer db.Close()
	const probe = "CREATE TABLE deployment_probe (value TEXT NOT NULL)"
	const index = "CREATE INDEX deployment_probe_value ON deployment_probe(value)"
	migrations := append(schema.Migrations(), schema.Migration{ID: 2, SQL: probe})
	definition := schema.Definition + ";\n" + probe + ";"
	const schemaQuery = "SELECT name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name"
	const ledgerQuery = "SELECT migration_id,checksum,applied_at_ms FROM schema_migrations ORDER BY migration_id"
	before := databaseRows(t, db, schemaQuery)
	broken := append([]schema.Migration{}, migrations...)
	broken[1].SQL += "; INSERT INTO missing_table VALUES(1);"
	if err := prepareSchema(ctx, db, definition, broken, true); err == nil {
		t.Fatal("failed second migration did not stop the release")
	}
	assertVersion(t, db, 1)
	if !reflect.DeepEqual(databaseRows(t, db, schemaQuery), before) {
		t.Fatal("failed release retained an earlier migration or ledger bootstrap")
	}
	if err := prepareSchema(ctx, db, definition, migrations, true); err != nil {
		t.Fatal("one schema release could not apply two migrations", err)
	}
	assertVersion(t, db, schemaVersion)
	if _, err := db.ExecContext(ctx, "INSERT INTO deployment_probe VALUES('preserved')"); err != nil {
		t.Fatal("second migration was not applied", err)
	}
	ledger := databaseRows(t, db, ledgerQuery)
	if len(ledger) != 2 {
		t.Fatal("release did not register both independent migration IDs", ledger)
	}

	// An unchanged release marker must not hide newly pending ledger entries.
	migrations = append(migrations, schema.Migration{ID: 3, SQL: index})
	definition += "\n" + index + ";"
	before = databaseRows(t, db, schemaQuery)
	if err := prepareSchema(ctx, db, definition, migrations, false); err == nil || !strings.Contains(err.Error(), "ovs migrate") {
		t.Fatal("ordinary startup accepted pending migration at current schema release", err)
	}
	if !reflect.DeepEqual(databaseRows(t, db, schemaQuery), before) || !reflect.DeepEqual(databaseRows(t, db, ledgerQuery), ledger) {
		t.Fatal("ordinary startup changed a database with pending migrations")
	}
	if err := prepareSchema(ctx, db, definition, migrations, true); err != nil {
		t.Fatal("release marker was incorrectly used to skip pending migrations", err)
	}
	assertVersion(t, db, schemaVersion)
	complete := databaseRows(t, db, ledgerQuery)
	if len(complete) != 3 || !reflect.DeepEqual(complete[:2], ledger) {
		t.Fatal("pending migration rewrote prior ledger entries", complete)
	}
	for _, upgrade := range []bool{false, true} {
		if err := prepareSchema(ctx, db, definition, migrations, upgrade); err != nil {
			t.Fatal("complete independent ledger could not be reopened", err)
		}
	}
	if !reflect.DeepEqual(databaseRows(t, db, ledgerQuery), complete) {
		t.Fatal("complete ledger was rewritten")
	}
	if got := databaseRows(t, db, "SELECT value FROM deployment_probe"); !reflect.DeepEqual(got, [][]any{{"preserved"}}) {
		t.Fatal("release migration changed existing data", got)
	}
	fresh, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "ovs.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	if err := prepareSchema(ctx, fresh, definition, migrations, false); err != nil {
		t.Fatal("fresh release with multiple included migrations failed", err)
	}
	if !reflect.DeepEqual(databaseRows(t, db, schemaQuery), databaseRows(t, fresh, schemaQuery)) {
		t.Fatal("multi-migration release differs from the complete fresh schema")
	}
	if len(databaseRows(t, fresh, ledgerQuery)) != 3 {
		t.Fatal("fresh release did not register all included migration IDs")
	}
}

func legacyDatabase(t *testing.T, directory string) *sql.DB {
	t.Helper()
	definition, err := os.ReadFile("../../sql/testdata/schema-v1.sql")
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(directory, "ovs.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.ExecContext(context.Background(), string(definition)); err != nil {
		t.Fatal(err)
	}
	return db
}

func assertVersion(t *testing.T, db *sql.DB, want int) {
	t.Helper()
	var got int
	if err := db.QueryRowContext(context.Background(), "PRAGMA user_version").Scan(&got); err != nil || got != want {
		t.Fatalf("schema version=%d, want %d: %v", got, want, err)
	}
}

func applicationRows(t *testing.T, db *sql.DB) map[string][][]any {
	t.Helper()
	result := make(map[string][][]any)
	for _, table := range []string{"identities", "sessions", "rooms", "room_members", "room_invitations", "room_media"} {
		result[table] = databaseRows(t, db, "SELECT * FROM "+table)
	}
	return result
}

func databaseRows(t *testing.T, db *sql.DB, query string) [][]any {
	t.Helper()
	rows, err := db.QueryContext(context.Background(), query)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	var result [][]any
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			t.Fatal(err)
		}
		result = append(result, values)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}
