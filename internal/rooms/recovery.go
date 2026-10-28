package rooms

import (
	"context"
	"errors"
	"time"

	"github.com/swqa7697/open-video-sync/internal/contracts"
)

func (s *Service) storageVersion() uint64 {
	if repository, ok := s.Repository.(interface{ RecoveryGeneration() uint64 }); ok {
		return repository.RecoveryGeneration()
	}
	return 0
}

func (s *Service) recoverLive(id string, c *coordinator) error {
	if c.live == nil || c.live.storageVersion == s.storageVersion() {
		return nil
	}
	epoch, err := contracts.RandomID(s.Random)
	if err != nil {
		return err
	}
	var restored *liveRoom
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err = s.Repository.Transact(ctx, func(tx Tx) error {
		r, err := tx.LoadRoom(id)
		if err != nil {
			return err
		}
		next := c.live.clone()
		next.media = r.Media
		next.generation = r.MediaGeneration
		next.playback = Playback{Phase: "empty", BaseRate: 1, AnchorServerMs: s.monotonicMs()}
		if r.Media != nil {
			next.playback.Phase = "paused"
			next.playback.PositionMs = r.Playback.PositionMs
		}
		next.barrier = nil
		next.hostLost = true
		next.cohort = make(map[string]bool)
		next.reports = make(map[string]*contracts.Readiness)
		next.bufferSince = make(map[string]int64)
		next.readySince = make(map[string]int64)
		next.storageVersion = s.storageVersion()
		next.writeTo(&r, s.monotonicMs())
		if err := tx.SavePlayback(r, s.Now().UnixMilli()); err != nil {
			return err
		}
		restored = &next
		return nil
	})
	if err == nil {
		c.live = restored
		c.epoch = epoch
		s.refreshLive(id, c)
	}
	return err
}

// RevokeSession closes every socket authenticated by a revoked session before return.
func (s *Service) RevokeSession(hash string) {
	s.mu.Lock()
	ids := make([]string, 0, len(s.coordinators))
	for id := range s.coordinators {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = s.dispatch(ctx, id, func(_ context.Context, epoch string) error {
			c := s.coordinator(id)
			if c.live != nil {
				for _, conn := range c.live.connections {
					if conn.Session.TokenHash == hash {
						conn.Sink.Offer("session.replaced", epoch, map[string]string{"reason": "session_revoked"})
						s.drop(c.live, conn)
					}
				}
			}
			return nil
		}, false)
		cancel()
	}
}

type retentionRepository interface {
	CleanupRetention(context.Context, int64) error
	ExpiredRooms(context.Context, int64) ([]string, error)
}

// Maintain removes bounded expired records and serializes inactive-room expiry with admission.
func (s *Service) Maintain(ctx context.Context) error {
	repo, ok := s.Repository.(retentionRepository)
	if !ok {
		return nil
	}
	if err := repo.CleanupRetention(ctx, s.Now().UnixMilli()); err != nil {
		return err
	}
	cutoff := s.Now().Add(-30 * 24 * time.Hour).UnixMilli()
	ids, err := repo.ExpiredRooms(ctx, cutoff)
	if err != nil {
		return err
	}
	for _, id := range ids {
		err := s.submit(ctx, id, func(ctx context.Context, _ string) error {
			c := s.coordinator(id)
			if c.live != nil && len(c.live.connections) != 0 {
				return nil
			}
			deleted := false
			err := s.Repository.Transact(ctx, func(tx Tx) error {
				r, err := tx.LoadRoom(id)
				if err != nil {
					return err
				}
				if r.LastActiveAtMs >= cutoff {
					return nil
				}
				if err := tx.DeleteRoom(id); err != nil {
					return err
				}
				deleted = true
				return nil
			})
			if err == nil && deleted {
				c.closed = true
			}
			return err
		})
		if err != nil && !errors.Is(err, contracts.Failure("not_found")) {
			return err
		}
	}
	return nil
}

func (s *Service) maintenance() {
	defer s.wg.Done()
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = s.Maintain(ctx)
			cancel()
		}
	}
}
