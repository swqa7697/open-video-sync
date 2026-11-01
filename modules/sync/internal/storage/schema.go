package storage

import (
	"context"
	"database/sql"
	"fmt"
)

const schemaVersion = 1

func initializeSchema(ctx context.Context, db *sql.DB, definition string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin schema initialization: %w", err)
	}
	defer tx.Rollback()
	var version int
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if version == schemaVersion {
		return nil
	}
	if version != 0 {
		return fmt.Errorf("unsupported database schema version: %d", version)
	}
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
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", schemaVersion)); err != nil {
		return fmt.Errorf("record schema version: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit schema initialization: %w", err)
	}
	return nil
}
