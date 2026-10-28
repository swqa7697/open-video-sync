package storage

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"sync/atomic"
	"time"

	"github.com/swqa7697/open-video-sync/internal/contracts"
)

type writeJob struct {
	ctx    context.Context
	run    func(*sql.Tx) error
	result chan error
}

type writer struct {
	queue   chan writeJob
	stop    chan struct{}
	done    chan struct{}
	once    sync.Once
	failed  atomic.Bool
	version atomic.Uint64
}

func newWriter(db *sql.DB) *writer {
	w := &writer{queue: make(chan writeJob, 128), stop: make(chan struct{}), done: make(chan struct{})}
	go func() {
		defer close(w.done)
		retry := time.NewTimer(time.Hour)
		defer retry.Stop()
		delay := 500 * time.Millisecond
		for {
			select {
			case <-w.stop:
				return
			case <-retry.C:
				if !w.failed.Load() {
					continue
				}
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				err := probeWrite(ctx, db)
				cancel()
				if err == nil {
					w.failed.Store(false)
					delay = 500 * time.Millisecond
				} else {
					delay = min(15*time.Second, delay*2)
					retry.Reset(delay)
				}
			case job := <-w.queue:
				if err := job.ctx.Err(); err != nil {
					job.result <- err
					continue
				}
				if w.failed.Load() {
					job.result <- contracts.Failure("storage_unavailable")
					continue
				}
				tx, err := db.BeginTx(job.ctx, nil)
				if err == nil {
					err = job.run(tx)
					if err == nil {
						err = tx.Commit()
					} else {
						_ = tx.Rollback()
					}
				}
				var failure contracts.Failure
				if err != nil && job.ctx.Err() == nil && !errors.As(err, &failure) && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
					w.failed.Store(true)
					w.version.Add(1)
					retry.Reset(delay)
				}
				job.result <- err
			}
		}
	}()
	return w
}

func probeWrite(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE storage_probe SET sequence=1-sequence WHERE id=1`)
	if err != nil {
		return err
	}
	if n, err := result.RowsAffected(); err != nil || n != 1 {
		return errors.New("storage recovery probe unavailable")
	}
	return tx.Commit()
}

// RecoveryGeneration changes whenever a write failure invalidates live room state.
func (s *Store) RecoveryGeneration() uint64 { return s.writer.version.Load() }

func (s *Store) write(ctx context.Context, run func(*sql.Tx) error) error {
	if s.writer.failed.Load() {
		return contracts.Failure("storage_unavailable")
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	job := writeJob{ctx, run, make(chan error, 1)}
	select {
	case <-s.writer.stop:
		return contracts.Failure("storage_unavailable")
	default:
	}
	select {
	case s.writer.queue <- job:
	default:
		return contracts.Failure("busy")
	}
	select {
	case err := <-job.result:
		return err
	case <-ctx.Done():
		// Join admitted work: no caller may observe a result while its callback is still running.
		select {
		case <-job.result:
		case <-s.writer.done:
		}
		return ctx.Err()
	case <-s.writer.done:
		return contracts.Failure("storage_unavailable")
	}
}
