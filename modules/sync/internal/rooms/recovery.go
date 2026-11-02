package rooms

import (
	"context"
	"time"
)

// RevokeSession closes every socket authenticated by a revoked session before return.
func (s *Service) RevokeSession(hash string) {
	s.mu.Lock()
	s.revoked[hash] = true
	s.mu.Unlock()
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

// RenameIdentity updates all room rosters after the identity owner commits a profile change.
func (s *Service) RenameIdentity(id, name string) {
	s.mu.Lock()
	s.names[id] = name
	ids := []string{}
	for roomID, r := range s.records {
		for i, m := range r.Members {
			if m.IdentityID == id {
				r = cloneRoom(r)
				r.Members[i].DisplayName = name
				s.records[roomID] = r
				ids = append(ids, roomID)
				break
			}
		}
	}
	s.mu.Unlock()
	for _, roomID := range ids {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = s.dispatch(ctx, roomID, func(_ context.Context, _ string) error {
			c := s.coordinator(roomID)
			for i, m := range c.room.Members {
				if m.IdentityID == id {
					c.room.Members[i].DisplayName = name
				}
			}
			s.refreshLive(roomID, c)
			return nil
		}, false)
		cancel()
	}
}
