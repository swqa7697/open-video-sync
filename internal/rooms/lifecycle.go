package rooms

import (
	"context"
	"time"

	"github.com/swqa7697/open-video-sync/internal/contracts"
)

const departureGraceMs int64 = 30000
const restartGraceMs int64 = 60000

// finalDeparture includes live owners and bounded reconnection grace, not stored membership.
func (s *Service) finalDeparture(c *coordinator, excluding string) bool {
	if c.live == nil {
		return true
	}
	for _, conn := range c.live.connections {
		if conn.MemberID != excluding {
			return false
		}
	}
	for memberID, until := range c.live.departures {
		if memberID != excluding && until > s.monotonicMs() {
			return false
		}
	}
	return true
}

func (s *Service) deleteRecord(c *coordinator) {
	s.mu.Lock()
	delete(s.records, c.room.ID)
	delete(s.links, c.room.Invite.LinkHash)
	delete(s.codes, c.room.Invite.CodeHash)
	delete(s.restored, c.room.ID)
	s.mu.Unlock()
	c.closed = true
	s.managementCommitted(c.room.ID, c.epoch, "close", "", c.room.Revision)
	if s.OnClosed != nil {
		s.OnClosed(c.room.ID)
	}
}

// Lifecycle writes are one-shot durable transitions, never storage recovery probes.
func (s *Service) tickLifecycle(c *coordinator) {
	s.mu.Lock()
	unavailable := s.lifecycleFailed
	s.mu.Unlock()
	if unavailable || c.closed {
		return
	}
	now := s.monotonicMs()
	closeRoom := c.emptyDeadline > 0 && now >= c.emptyDeadline && s.finalDeparture(c, "")
	hostLeft := c.hostDeadline > 0 && now >= c.hostDeadline && c.room.Settings.Controllers == "host"
	if !closeRoom && !hostLeft {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	settings := c.room.Settings
	settings.Controllers = "everyone"
	err := s.Repository.Transact(ctx, func(tx Tx) error {
		if closeRoom {
			return tx.DeleteRoom(c.room.ID)
		}
		return tx.UpdateSettings(c.room.ID, settings)
	})
	if err != nil {
		s.mu.Lock()
		s.lifecycleFailed = true
		s.mu.Unlock()
		if c.live != nil {
			for _, conn := range c.live.connections {
				problem := s.publicError(contracts.Failure("storage_unavailable"))
				problem.Message = "Room departure could not be saved. Existing playback remains available; the operator must fix storage and restart."
				conn.Sink.Offer("error", c.epoch, problem)
			}
		}
		return
	}
	c.room.Revision++
	if closeRoom {
		s.deleteRecord(c)
		return
	}
	c.room.Settings = settings
	c.hostDeadline = 0
	s.install(c.room)
	s.refreshLive(c.room.ID, c)
}

// Only restored rooms without an activated coordinator need this bounded startup sweep.
func (s *Service) watchRestored() {
	defer s.wg.Done()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-ticker.C:
			s.mu.Lock()
			ids := []string{}
			if !s.lifecycleFailed {
				for id := range s.restored {
					if s.coordinators[id] == nil {
						ids = append(ids, id)
					}
				}
			}
			s.mu.Unlock()
			if s.monotonicMs() < restartGraceMs {
				continue
			}
			for _, id := range ids {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				_ = s.submit(ctx, id, func(_ context.Context, _ string) error { s.tickLifecycle(s.coordinator(id)); return nil })
				cancel()
			}
		}
	}
}
