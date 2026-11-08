package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/sql"
)

const schemaVersion = schema.Version

// The ledger belongs to deployment infrastructure, rather than any individual
// migration. Keep its definition aligned with the complete current schema.
const migrationLedgerDefinition = `CREATE TABLE schema_migrations (
    migration_id INTEGER PRIMARY KEY CHECK(migration_id >= 1),
    checksum TEXT NOT NULL CHECK(length(checksum) = 64),
    applied_at_ms INTEGER NOT NULL
)`

func initializeSchema(ctx context.Context, db *sql.DB, definition string) error {
	return prepareSchema(ctx, db, definition, schema.Migrations(), false)
}

func prepareSchema(ctx context.Context, db *sql.DB, definition string, migrations []schema.Migration, upgrade bool) error {
	if len(migrations) == 0 {
		return fmt.Errorf("incomplete database migration registry")
	}
	for i, migration := range migrations {
		if migration.ID != i+1 || migration.SQL == "" {
			return fmt.Errorf("invalid database migration sequence at ID %d", migration.ID)
		}
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin schema initialization: %w", err)
	}
	defer tx.Rollback()
	var version int
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if version < 0 || version > schemaVersion {
		return fmt.Errorf("unsupported database schema version: %d", version)
	}
	applied := 0
	if version == 0 {
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*')").Scan(&exists); err != nil {
			return fmt.Errorf("inspect database schema: %w", err)
		}
		if exists {
			return fmt.Errorf("cannot initialize a nonempty database without a schema version")
		}
		if _, err := tx.ExecContext(ctx, definition); err != nil {
			return fmt.Errorf("initialize database schema: %w", err)
		}
	} else {
		var hasLedger bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='schema_migrations')").Scan(&hasLedger); err != nil {
			return fmt.Errorf("inspect database migration ledger: %w", err)
		}
		if hasLedger {
			applied, err = validateMigrationLedger(ctx, tx, migrations)
			if err != nil {
				return err
			}
		} else if version != 1 {
			return fmt.Errorf("database migration ledger is missing")
		}
		if version == schemaVersion && applied == len(migrations) {
			return nil
		}
		if !upgrade {
			return fmt.Errorf("database requires deployment migration; run ovs migrate before starting OVS (schema version %d)", version)
		}
		if !hasLedger {
			if _, err := tx.ExecContext(ctx, migrationLedgerDefinition); err != nil {
				return fmt.Errorf("initialize database migration ledger: %w", err)
			}
		}
	}
	for _, migration := range migrations[applied:] {
		if version != 0 {
			if _, err := tx.ExecContext(ctx, migration.SQL); err != nil {
				return fmt.Errorf("apply database migration %d: %w", migration.ID, err)
			}
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO schema_migrations(migration_id,checksum,applied_at_ms) VALUES(?,?,?)", migration.ID, migrationChecksum(migration), time.Now().UnixMilli()); err != nil {
			return fmt.Errorf("record database migration %d: %w", migration.ID, err)
		}
	}
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", schemaVersion)); err != nil {
		return fmt.Errorf("record schema version: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit schema initialization: %w", err)
	}
	return nil
}

func validateMigrationLedger(ctx context.Context, tx *sql.Tx, migrations []schema.Migration) (int, error) {
	rows, err := tx.QueryContext(ctx, "SELECT migration_id,checksum FROM schema_migrations ORDER BY migration_id")
	if err != nil {
		return 0, fmt.Errorf("read database migration ledger: %w", err)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var applied int
		var checksum string
		if err := rows.Scan(&applied, &checksum); err != nil {
			return 0, fmt.Errorf("read database migration record: %w", err)
		}
		if count >= len(migrations) || applied != migrations[count].ID || checksum != migrationChecksum(migrations[count]) {
			return 0, fmt.Errorf("database migration ledger mismatch at ID %d", applied)
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("read database migration ledger: %w", err)
	}
	return count, nil
}

func migrationChecksum(migration schema.Migration) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(migration.SQL)))
}
