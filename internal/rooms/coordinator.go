package rooms

import (
	"context"
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
	epoch  string
	queue  chan operation
	done   chan struct{}
	closed bool
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
	// OnRemoved and OnClosed are synchronous post-commit connection revocation hooks.
	OnRemoved func(roomID, memberID string)
	OnClosed  func(roomID string)
}

// NewService validates limits before starting admission.
func NewService(repository Repository, now func() time.Time, random io.Reader, limits Limits) (*Service, error) {
	if !limits.Valid() {
		return nil, contracts.Failure("invalid_input")
	}
	return &Service{Repository: repository, Now: now, Random: random, Limits: limits, coordinators: make(map[string]*coordinator), stop: make(chan struct{}), started: time.Now()}, nil
}

// Close stops admission and joins all owned coordinator goroutines.
func (s *Service) Close() {
	s.mu.Lock()
	if !s.stopping {
		s.stopping = true
		close(s.stop)
	}
	s.mu.Unlock()
	s.wg.Wait()
}
func (s *Service) submit(ctx context.Context, id string, run func(context.Context, string) error) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	s.mu.Lock()
	if s.stopping {
		s.mu.Unlock()
		return contracts.Failure("busy")
	}
	c := s.coordinators[id]
	if c == nil {
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
			finish()
			return
		case <-timer.C:
			s.mu.Lock()
			if len(c.queue) == 0 {
				delete(s.coordinators, id)
				s.mu.Unlock()
				return
			}
			s.mu.Unlock()
			timer.Reset(s.Limits.CoordinatorIdle)
		case job := <-c.queue:
			if err := job.ctx.Err(); err != nil {
				job.result <- err
			} else if c.closed {
				job.result <- contracts.Failure("not_found")
			} else {
				job.result <- job.run(job.ctx, c.epoch)
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
func (s *Service) monotonicMs() int64 { return time.Since(s.started).Milliseconds() }
