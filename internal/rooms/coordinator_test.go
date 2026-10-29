package rooms

import (
	"context"
	"crypto/rand"
	"sync/atomic"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/internal/contracts"
)

func TestCoordinatorBackpressureCancellationAndShutdown(t *testing.T) {
	limits := DefaultLimits()
	limits.MaxActive = 1
	s, err := NewService(emptyRepository{}, time.Now, rand.Reader, limits)
	if err != nil {
		t.Fatal(err)
	}
	s.records["room"] = Room{ID: "room"}
	defer s.Close()
	started, release := make(chan struct{}), make(chan struct{})
	first := make(chan error, 1)
	go func() {
		first <- s.submit(context.Background(), "room", func(context.Context, string) error { close(started); <-release; return nil })
	}()
	<-started
	if err := s.submit(context.Background(), "other", func(context.Context, string) error { return nil }); err != contracts.Failure("capacity_reached") {
		t.Fatal("active coordinator cap ignored", err)
	}
	var effects atomic.Int32
	s.mu.Lock()
	c := s.coordinators["room"]
	s.mu.Unlock()
	queued := make([]operation, 64)
	for i := range queued {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		queued[i] = operation{ctx, func(context.Context, string) error { effects.Add(1); return nil }, make(chan error, 1)}
		c.queue <- queued[i]
	}
	if err := s.submit(context.Background(), "room", func(context.Context, string) error { return nil }); err != contracts.Failure("busy") {
		t.Fatal("coordinator overflow admitted", err)
	}
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	for _, job := range queued {
		if err := <-job.result; err != context.Canceled {
			t.Fatal(err)
		}
	}
	if effects.Load() != 0 {
		t.Fatal("cancelled room work had effects")
	}
	s.Close()
	if err := s.submit(context.Background(), "room", func(context.Context, string) error { return nil }); err != contracts.Failure("busy") {
		t.Fatal("shutdown admission open")
	}
}

type emptyRepository struct{}

func (emptyRepository) LoadRooms(context.Context) ([]Room, error)      { return nil, nil }
func (emptyRepository) Transact(context.Context, func(Tx) error) error { return nil }
