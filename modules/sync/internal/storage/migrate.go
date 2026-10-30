package storage

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"io/fs"
	"regexp"
	"strconv"
	"time"
)

var migrationName = regexp.MustCompile(`^([0-9]{4})_[a-z0-9_]+\.sql$`)

type migration struct {
	version  int
	checksum string
	sql      string
}

func migrate(ctx context.Context, db *sql.DB, files fs.FS) error {
	entries, err := fs.ReadDir(files, ".")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	var pending []migration
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		match := migrationName.FindStringSubmatch(entry.Name())
		if match == nil {
			return fmt.Errorf("invalid migration name: %s", entry.Name())
		}
		version, err := strconv.Atoi(match[1])
		if err != nil || version != len(pending)+1 {
			return fmt.Errorf("nonsequential migration: %s", entry.Name())
		}
		contents, err := fs.ReadFile(files, entry.Name())
		if err != nil {
			return fmt.Errorf("read migration %d: %w", version, err)
		}
		digest := sha256.Sum256(contents)
		pending = append(pending, migration{version, hex.EncodeToString(digest[:]), string(contents)})
	}
	if len(pending) == 0 {
		return fmt.Errorf("no schema migrations found")
	}
	var exists bool
	if err := db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations')").Scan(&exists); err != nil {
		return fmt.Errorf("inspect migration ledger: %w", err)
	}
	var applied int
	if exists {
		rows, err := db.QueryContext(ctx, "SELECT version, checksum FROM schema_migrations ORDER BY version")
		if err != nil {
			return fmt.Errorf("read migration ledger: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var version int
			var checksum string
			if err := rows.Scan(&version, &checksum); err != nil {
				return fmt.Errorf("decode migration ledger: %w", err)
			}
			if version > len(pending) {
				return fmt.Errorf("database schema is newer than this binary")
			}
			if version != applied+1 || checksum != pending[applied].checksum {
				return fmt.Errorf("migration %d checksum or order mismatch", version)
			}
			applied++
		}
		if err := rows.Err(); err != nil {
			return fmt.Errorf("read migration ledger: %w", err)
		}
		if err := rows.Close(); err != nil {
			return fmt.Errorf("close migration ledger: %w", err)
		}
	}
	for _, next := range pending[applied:] {
		if err := applyMigration(ctx, db, next); err != nil {
			return fmt.Errorf("apply migration %d: %w", next.version, err)
		}
	}
	return nil
}

func applyMigration(ctx context.Context, db *sql.DB, next migration) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, next.sql); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)", next.version, next.checksum, time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		return err
	}
	return tx.Commit()
}
