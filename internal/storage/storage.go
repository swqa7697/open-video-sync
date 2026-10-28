// Package storage owns SQLite setup and exclusive data-directory ownership.
package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	"github.com/gofrs/flock"
	_ "modernc.org/sqlite" // Register the database/sql driver.

	"github.com/swqa7697/open-video-sync/migrations"
)

// Store owns one database and its data-directory lock. Close it before reuse.
type Store struct {
	db   *sql.DB
	lock *flock.Flock
}

// Open acquires exclusive ownership, configures SQLite, and applies migrations.
func Open(ctx context.Context, directory string) (_ *Store, err error) {
	directory, err = filepath.Abs(directory)
	if err != nil {
		return nil, fmt.Errorf("resolve data directory: %w", err)
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create data directory: %w", err)
	}
	lock := flock.New(filepath.Join(directory, "ovs.lock"))
	locked, err := lock.TryLock()
	if err != nil {
		return nil, fmt.Errorf("lock data directory: %w", err)
	}
	if !locked {
		return nil, errors.New("data directory is already owned by another OVS process")
	}
	defer func() {
		if err != nil {
			err = errors.Join(err, lock.Unlock())
		}
	}()

	dsn := url.URL{Scheme: "file", Path: filepath.Join(directory, "ovs.sqlite")}
	query := dsn.Query()
	for _, pragma := range []string{"foreign_keys(1)", "busy_timeout(5000)", "journal_mode(WAL)", "synchronous(FULL)"} {
		query.Add("_pragma", pragma)
	}
	dsn.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return nil, fmt.Errorf("open SQLite: %w", err)
	}
	// A single connection bounds database concurrency until application queues exist.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	defer func() {
		if err != nil {
			err = errors.Join(err, db.Close())
		}
	}()
	if err := db.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("connect SQLite: %w", err)
	}
	if err := migrate(ctx, db, migrations.Files); err != nil {
		return nil, err
	}
	return &Store{db: db, lock: lock}, nil
}

// Ready checks the database connection without exposing application metadata.
func (s *Store) Ready(ctx context.Context) error {
	return s.db.PingContext(ctx)
}

// SQLiteVersion returns the actual engine version used by this database.
func (s *Store) SQLiteVersion(ctx context.Context) (string, error) {
	var version string
	err := s.db.QueryRowContext(ctx, "SELECT sqlite_version()").Scan(&version)
	return version, err
}

// Close releases SQLite before releasing exclusive ownership of the directory.
func (s *Store) Close() error {
	return errors.Join(s.db.Close(), s.lock.Unlock())
}
