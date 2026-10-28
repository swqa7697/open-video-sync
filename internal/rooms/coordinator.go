package rooms

import (
	"context"
	"errors"
	"io"
	"sync"
	"time"

	"github.com/swqa7697/open-video-sync/internal/contracts"
)

type operation struct {
	ctx    context.Context
	run    func(context.Context, string) error
	result chan error
}
type coordinator struct {
	epoch    string
	queue    chan operation
	done     chan struct{}
	closed   bool
	evicting bool
	live     *liveRoom
}

// Service owns the lazy coordinator registry and serializes every room operation.
type Service struct {
	Repository   Repository
	Now          func() time.Time
	Random       io.Reader
	Limits       Limits
	mu           sync.Mutex
	coordinators map[string]*coordinator
	stopping     bool
	stop         chan struct{}
	wg           sync.WaitGroup
	started      time.Time
	shutdown     context.Context
	shutdownErr  error
	joined       chan struct{}
	joinOnce     sync.Once
	// Monotonic returns process time independently of wall-clock expiry. Set before admission.
	Monotonic func() int64
	sockets   int
	// OnRemoved and OnClosed are synchronous post-commit connection revocation hooks.
	OnRemoved func(roomID, memberID string)
	OnClosed  func(roomID string)
}

// NewService validates limits before starting admission.
func NewService(repository Repository, now func() time.Time, random io.Reader, limits Limits) (*Service, error) {
	if !limits.Valid() {
		return nil, contracts.Failure("invalid_input")
	}
	s := &Service{Repository: repository, Now: now, Random: random, Limits: limits, coordinators: make(map[string]*coordinator), stop: make(chan struct{}), joined: make(chan struct{}), started: time.Now()}
	if _, ok := repository.(retentionRepository); ok {
		s.wg.Add(1)
		go s.maintenance()
	}
	return s, nil
}

// Close stops admission and joins all owned coordinator goroutines.
func (s *Service) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return s.CloseContext(ctx)
}

// CloseContext stops admission, checkpoints rooms, and joins owned workers within ctx.
func (s *Service) CloseContext(ctx context.Context) error {
	s.mu.Lock()
	if !s.stopping {
		s.stopping = true
		s.shutdown = ctx
		close(s.stop)
	}
	s.mu.Unlock()
	s.joinOnce.Do(func() { go func() { s.wg.Wait(); close(s.joined) }() })
	select {
	case <-s.joined:
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.shutdownErr
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (s *Service) submit(ctx context.Context, id string, run func(context.Context, string) error) error {
	return s.dispatch(ctx, id, run, true)
}
func (s *Service) dispatch(ctx context.Context, id string, run func(context.Context, string) error, activate bool) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return contracts.Failure("busy")
	}
	c := s.coordinators[id]
	if c != nil && c.evicting {
		s.mu.Unlock()
		return contracts.Failure("busy")
	}
	if c == nil {
		if !activate {
			s.mu.Unlock()
			return contracts.Failure("not_found")
		}
		if len(s.coordinators) >= s.Limits.MaxActive {
			s.mu.Unlock()
			return contracts.Failure("capacity_reached")
		}
		epoch, err := contracts.RandomID(s.Random)
		if err != nil {
			s.mu.Unlock()
			return err
		}
		c = &coordinator{epoch: epoch, queue: make(chan operation, 64), done: make(chan struct{})}
		s.coordinators[id] = c
		s.wg.Add(1)
		go s.serve(id, c)
	}
	job := operation{ctx, run, make(chan error, 1)}
	select {
	case c.queue <- job:
		s.mu.Unlock()
	default:
		s.mu.Unlock()
		return contracts.Failure("busy")
	}
	select {
	case err := <-job.result:
		return err
	case <-ctx.Done():
		select {
		case <-job.result:
		case <-c.done:
		}
		return ctx.Err()
	case <-c.done:
		select {
		case err := <-job.result:
			return err
		default:
			return contracts.Failure("busy")
		}
	}
}
func (s *Service) serve(id string, c *coordinator) {
	defer s.wg.Done()
	defer close(c.done)
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	timer := time.NewTimer(s.Limits.CoordinatorIdle)
	defer timer.Stop()
	finish := func() {
		s.mu.Lock()
		if s.coordinators[id] == c {
			delete(s.coordinators, id)
		}
		s.mu.Unlock()
	}
	for {
		select {
		case <-s.stop:
			s.finishLive(id, c)
			finish()
			return
		case <-tick.C:
			if err := s.recoverLive(id, c); err != nil {
				s.failLive(c)
			} else {
				s.tickLive(id, c)
			}
		case <-timer.C:
			s.mu.Lock()
			if len(c.queue) == 0 && (c.live == nil || len(c.live.connections) == 0) {
				c.evicting = true
				s.mu.Unlock()
				if err := s.finishLive(id, c); err == nil || err == contracts.Failure("not_found") {
					finish()
					return
				}
				s.mu.Lock()
				c.evicting = false
				s.mu.Unlock()
				timer.Reset(s.Limits.CoordinatorIdle)
				continue
			}
			s.mu.Unlock()
			timer.Reset(s.Limits.CoordinatorIdle)
		case job := <-c.queue:
			if err := job.ctx.Err(); err != nil {
				job.result <- err
			} else if c.closed {
				job.result <- contracts.Failure("not_found")
			} else {
				err := s.recoverLive(id, c)
				if err == nil {
					err = job.run(job.ctx, c.epoch)
				}
				job.result <- err
				if err == nil {
					s.refreshLive(id, c)
				}
				if err != nil {
					var failure contracts.Failure
					if errors.As(err, &failure) && failure == "storage_unavailable" {
						s.failLive(c)
					}
				}
			}
			if c.closed {
				finish()
				return
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(s.Limits.CoordinatorIdle)
		}
	}
}
func (s *Service) monotonicMs() int64 {
	if s.Monotonic != nil {
		return s.Monotonic()
	}
	return time.Since(s.started).Milliseconds()
}
