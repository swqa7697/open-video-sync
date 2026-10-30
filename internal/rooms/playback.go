package rooms

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/identity"
)

// Sink must enqueue without blocking. Transport owns bounded output and closure.
type Sink interface {
	Offer(kind, epoch string, payload any) bool
	Close()
}

// Barrier freezes the required cohort for one play or buffering target.
type Barrier struct {
	BarrierID         string   `json:"barrierId"`
	RequiredMemberIDs []string `json:"requiredMemberIds"`
	Reason            string   `json:"reason"`
	TargetPositionMs  int64    `json:"targetPositionMs"`
	DeadlineServerMs  int64    `json:"deadlineServerMs"`
}

// CommandRecord records accepted runtime intent for at most sixty seconds.
type CommandRecord struct {
	Epoch, Digest         string
	Revision, ExpiresAtMs int64
}

// CommandResult acknowledges an applied runtime transition.
type CommandResult struct {
	CommandID string                 `json:"commandId"`
	Accepted  bool                   `json:"accepted"`
	Revision  *int64                 `json:"revision"`
	Error     *contracts.PublicError `json:"error"`
}

// Connection is a server-bound identity and room; frames cannot override ownership.
type Connection struct {
	ID, RoomID, MemberID string
	Generation           int64
	Session              identity.Session
	Sink                 Sink
}
type liveRoom struct {
	media                   *contracts.MediaDescriptor
	generation              int64
	playback                Playback
	barrier                 *Barrier
	connections             map[string]*Connection
	active                  map[string]string
	generations             map[string]int64
	disconnected            map[string]int64
	reports                 map[string]*contracts.Readiness
	cohort                  map[string]bool
	bufferSince, readySince map[string]int64
	receipts                map[string]CommandRecord
}

func (s *Service) coordinator(id string) *coordinator {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.coordinators[id]
}
func (s *Service) live(r Room, c *coordinator) *liveRoom {
	if c.live == nil {
		p := Playback{Phase: "empty", AnchorServerMs: s.monotonicMs()}
		generation := int64(0)
		if r.Media != nil {
			p.Phase = "paused"
			generation = 1
		}
		c.live = &liveRoom{media: r.Media, generation: generation, playback: p, connections: make(map[string]*Connection), active: make(map[string]string), generations: make(map[string]int64), disconnected: make(map[string]int64), reports: make(map[string]*contracts.Readiness), cohort: make(map[string]bool), bufferSince: make(map[string]int64), readySince: make(map[string]int64), receipts: make(map[string]CommandRecord)}
	}
	return c.live
}
func (s *Service) roomSnapshot(r Room, epoch, identityID string) Snapshot {
	c := s.coordinator(r.ID)
	l := s.live(r, c)
	r = cloneRoom(r)
	s.mu.Lock()
	for i, m := range r.Members {
		if name, ok := s.names[m.IdentityID]; ok {
			r.Members[i].DisplayName = name
		}
	}
	s.mu.Unlock()
	result := snapshot(r, epoch, s.monotonicMs(), identityID)
	result.Media = l.media
	result.MediaGeneration = l.generation
	result.Playback = l.playback
	if l.barrier != nil {
		b := *l.barrier
		b.RequiredMemberIDs = append([]string{}, b.RequiredMemberIDs...)
		result.Barrier = &b
	}
	for i := range result.Members {
		m := &result.Members[i]
		if l.connections[l.active[m.MemberID]] != nil {
			m.Presence = "connected"
		}
		if report := l.reports[m.MemberID]; report != nil {
			copy := *report
			m.Readiness = &copy
		}
	}
	return result
}
func (l *liveRoom) position(now int64) int64 {
	if l.media == nil {
		return 0
	}
	p := l.playback.PositionMs
	if l.playback.Phase == "playing" {
		p += max(0, now-l.playback.AnchorServerMs)
	}
	return min(l.media.DurationMs, max(0, p))
}

// Connect makes the latest authenticated page the sole playback owner.
func (s *Service) Connect(ctx context.Context, p identity.Session, id string, sink Sink) (*Connection, error) {
	if _, err := s.Snapshot(ctx, p, id); err != nil {
		return nil, err
	}
	s.mu.Lock()
	if s.sockets >= 500 {
		s.mu.Unlock()
		return nil, contracts.Failure("capacity_reached")
	}
	s.sockets++
	s.mu.Unlock()
	var connection *Connection
	installed := false
	err := s.submit(ctx, id, func(_ context.Context, epoch string) error {
		if err := s.access(p, id); err != nil {
			return err
		}
		c := s.coordinator(id)
		r := c.room
		l := s.live(r, c)
		m, _ := member(r, p.IdentityID)
		cid, err := contracts.RandomID(s.Random)
		if err != nil {
			return err
		}
		if old := l.connections[l.active[m.ID]]; old != nil {
			old.Sink.Offer("session.replaced", epoch, map[string]string{"reason": "connection_replaced"})
			s.drop(l, old)
		}
		l.generations[m.ID]++
		connection = &Connection{cid, id, m.ID, l.generations[m.ID], p, sink}
		l.connections[cid] = connection
		l.active[m.ID] = cid
		delete(l.disconnected, m.ID)
		delete(l.reports, m.ID)
		delete(l.readySince, m.ID)
		delete(l.bufferSince, m.ID)
		installed = true
		sink.Offer("session.welcome", epoch, map[string]any{"connectionId": cid, "snapshot": s.roomSnapshot(r, epoch, p.IdentityID)})
		s.refreshLive(id, c)
		return nil
	})
	if err != nil {
		if installed {
			s.Disconnect(connection)
		} else {
			s.mu.Lock()
			s.sockets--
			s.mu.Unlock()
		}
		sink.Close()
	}
	return connection, err
}
func (s *Service) drop(l *liveRoom, c *Connection) {
	if l.connections[c.ID] == nil {
		return
	}
	delete(l.connections, c.ID)
	s.mu.Lock()
	s.sockets--
	s.mu.Unlock()
	if l.active[c.MemberID] == c.ID {
		l.disconnected[c.MemberID] = s.monotonicMs() + 15000
		delete(l.reports, c.MemberID)
		delete(l.readySince, c.MemberID)
		delete(l.bufferSince, c.MemberID)
	}
	c.Sink.Close()
}

// Disconnect releases a socket and retains its existing waiting membership for the reconnect grace.
func (s *Service) Disconnect(c *Connection) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = s.dispatch(ctx, c.RoomID, func(_ context.Context, _ string) error {
		co := s.coordinator(c.RoomID)
		if co.live != nil {
			s.drop(co.live, c)
		}
		return nil
	}, false)
}
func (s *Service) active(l *liveRoom, c *Connection) error {
	if l.connections[c.ID] != c || l.active[c.MemberID] != c.ID {
		return contracts.Failure("forbidden")
	}
	return nil
}

// CheckConnection validates liveness traffic against current memory authorization.
func (s *Service) CheckConnection(ctx context.Context, c *Connection) error {
	return s.dispatch(ctx, c.RoomID, func(_ context.Context, _ string) error {
		if err := s.validSession(c.Session); err != nil {
			return err
		}
		return s.active(s.coordinator(c.RoomID).live, c)
	}, false)
}

// Handle applies controls in memory; only media selection crosses persistence.
func (s *Service) Handle(ctx context.Context, c *Connection, f contracts.ClientFrame) error {
	return s.dispatch(ctx, c.RoomID, func(ctx context.Context, epoch string) error {
		co := s.coordinator(c.RoomID)
		r := co.room
		l := s.live(r, co)
		var revision int64
		apply := func() error {
			if err := s.validSession(c.Session); err != nil {
				return err
			}
			if err := authorize(r, c.Session, false); err != nil {
				return err
			}
			if err := s.active(l, c); err != nil {
				return err
			}
			if f.Epoch != epoch {
				return contracts.Failure("stale_state")
			}
			if f.Type == "member.readiness" {
				report := f.Report
				if report.MediaGeneration != l.generation || (l.barrier != nil && (report.BarrierID == nil || *report.BarrierID != l.barrier.BarrierID)) || (l.barrier == nil && report.BarrierID != nil) {
					return contracts.Failure("stale_state")
				}
				if report.PositionMs != nil && (l.media == nil || *report.PositionMs > l.media.DurationMs) {
					return contracts.Failure("invalid_command")
				}
				old := l.reports[c.MemberID]
				changed := old == nil || old.Status != report.Status || old.MediaGeneration != report.MediaGeneration || old.Capabilities != report.Capabilities
				l.reports[c.MemberID] = &report
				if report.Status != "ready" {
					delete(l.readySince, c.MemberID)
				}
				if report.Status != "buffering" {
					delete(l.bufferSince, c.MemberID)
				}
				s.tickLive(c.RoomID, co)
				if changed {
					s.refreshLive(c.RoomID, co)
				}
				return nil
			}
			if f.Type != "playback.command" && f.Type != "media.select" {
				return contracts.Failure("invalid_command")
			}
			if (f.Type == "media.select" || r.Settings.Controllers != "everyone") && r.HostIdentityID != c.Session.IdentityID {
				return contracts.Failure("forbidden")
			}
			now := s.monotonicMs()
			digest := contracts.CommandDigest(f)
			receiptKey := c.Session.IdentityID + ":" + f.CommandID
			for k, v := range l.receipts {
				if v.ExpiresAtMs <= now {
					delete(l.receipts, k)
				}
			}
			if previous, ok := l.receipts[receiptKey]; ok {
				if previous.Digest != digest {
					return contracts.Failure("invalid_command")
				}
				revision = previous.Revision
				return nil
			}
			if f.ExpectedRevision != r.Revision || f.MediaGeneration != l.generation {
				return contracts.Failure("stale_state")
			}
			if r.Revision >= contracts.MaxSafeInteger {
				return contracts.Failure("capacity_reached")
			}
			next := l.clone()
			next.playback.PositionMs = l.position(now)
			next.playback.AnchorServerMs = now
			switch f.Type {
			case "media.select":
				if l.generation >= contracts.MaxSafeInteger {
					return contracts.Failure("capacity_reached")
				}
				b, err := json.Marshal(f.Media)
				if err != nil {
					return err
				}
				media, err := contracts.DecodeMedia(b)
				if err != nil {
					return contracts.Failure("invalid_command")
				}
				if err := s.Repository.Transact(ctx, func(tx Tx) error { return tx.SelectMedia(r.ID, media) }); err != nil {
					return err
				}
				next.media = &media
				next.generation++
				next.playback = Playback{Phase: "paused", AnchorServerMs: now}
				next.barrier = nil
				next.reports = make(map[string]*contracts.Readiness)
				next.cohort = make(map[string]bool)
				next.bufferSince = make(map[string]int64)
				next.readySince = make(map[string]int64)
				r.Media = &media
				s.install(r)
			case "playback.command":
				if l.media == nil {
					return contracts.Failure("invalid_command")
				}
				switch f.Action {
				case "pause":
					next.playback.Phase = "paused"
					next.playback.DesiredPlaying = false
					next.barrier = nil
				case "seek":
					if f.PositionMs < 0 || f.PositionMs > l.media.DurationMs {
						return contracts.Failure("invalid_command")
					}
					next.playback.PositionMs = f.PositionMs
					if next.playback.Phase == "ended" {
						next.playback.Phase = "paused"
					}
					if next.playback.Phase == "waiting" {
						if err := s.startBarrier(&next, l.barrier.Reason, l.barrier.RequiredMemberIDs, now); err != nil {
							return err
						}
					}
				case "play", "replay":
					if f.Action == "replay" || next.playback.PositionMs >= l.media.DurationMs {
						next.playback.PositionMs = 0
					}
					next.playback.Phase = "playing"
					next.playback.DesiredPlaying = true
					next.barrier = nil
					next.cohort = make(map[string]bool)
					required := []string{}
					for _, m := range r.Members {
						if l.connections[l.active[m.ID]] != nil {
							next.cohort[m.ID] = true
							required = append(required, m.ID)
						}
					}
					if r.Settings.WaitForAll {
						if err := s.startBarrier(&next, "play", required, now); err != nil {
							return err
						}
					}
				default:
					return contracts.Failure("invalid_command")
				}
			}
			r.Revision++
			co.room = r
			if len(next.receipts) >= 256 {
				oldest := ""
				var expiry int64
				for k, v := range next.receipts {
					if oldest == "" || v.ExpiresAtMs < expiry {
						oldest = k
						expiry = v.ExpiresAtMs
					}
				}
				delete(next.receipts, oldest)
			}
			next.receipts[receiptKey] = CommandRecord{epoch, digest, r.Revision, now + 60000}
			co.live = &next
			revision = r.Revision
			return nil
		}
		err := apply()
		if f.CommandID != "" {
			result := CommandResult{CommandID: f.CommandID, Accepted: err == nil}
			if err == nil {
				result.Revision = &revision
			} else {
				result.Error = s.publicError(err)
			}
			c.Sink.Offer("command.result", epoch, result)
		} else if err != nil && err != contracts.Failure("stale_state") {
			c.Sink.Offer("error", epoch, s.publicError(err))
		}
		if f.Type != "member.readiness" {
			s.refreshLive(c.RoomID, co)
		}
		return err
	}, false)
}
func (s *Service) publicError(err error) *contracts.PublicError {
	code := "storage_unavailable"
	var f contracts.Failure
	if errors.As(err, &f) {
		code = string(f)
	} else if errors.Is(err, context.DeadlineExceeded) {
		code = "busy"
	}
	id, _ := contracts.RandomID(s.Random)
	return &contracts.PublicError{Code: code, Message: "The room request could not complete.", RequestID: id, Retryable: code == "busy" || code == "storage_unavailable" || code == "rate_limited"}
}
func (s *Service) refreshLive(_ string, c *coordinator) {
	if c.live == nil {
		return
	}
	for _, conn := range c.live.connections {
		if s.validSession(conn.Session) != nil {
			conn.Sink.Offer("session.replaced", c.epoch, map[string]string{"reason": "session_revoked"})
			s.drop(c.live, conn)
			continue
		}
		conn.Sink.Offer("room.snapshot", c.epoch, s.roomSnapshot(c.room, c.epoch, conn.Session.IdentityID))
	}
}
func (s *Service) managementCommitted(id, epoch, operation, removed string, revision int64) {
	c := s.coordinator(id)
	if c.live == nil {
		return
	}
	if removed != "" {
		delete(c.live.cohort, removed)
		delete(c.live.reports, removed)
		delete(c.live.disconnected, removed)
		delete(c.live.bufferSince, removed)
		delete(c.live.readySince, removed)
		if c.live.barrier != nil {
			ids := []string{}
			for _, mid := range c.live.barrier.RequiredMemberIDs {
				if mid != removed {
					ids = append(ids, mid)
				}
			}
			c.live.barrier.RequiredMemberIDs = ids
		}
	}
	for _, conn := range c.live.connections {
		if operation == "close" {
			conn.Sink.Offer("room.closed", epoch, map[string]any{"roomId": id, "revision": revision})
			s.drop(c.live, conn)
		} else if conn.MemberID == removed {
			conn.Sink.Offer("session.replaced", epoch, map[string]string{"reason": "session_revoked"})
			s.drop(c.live, conn)
		}
	}
	if removed != "" {
		delete(c.live.active, removed)
		delete(c.live.generations, removed)
		delete(c.live.disconnected, removed)
	}
}
func readyFor(r *contracts.Readiness, l *liveRoom, b *Barrier) bool {
	return r != nil && r.Status == "ready" && r.MediaGeneration == l.generation && r.BarrierID != nil && *r.BarrierID == b.BarrierID && r.PositionMs != nil && r.DurationMs != nil && abs(*r.PositionMs-b.TargetPositionMs) <= 250 && abs(*r.DurationMs-l.media.DurationMs) <= 250 && r.Capabilities.CanPlay && r.Capabilities.CanPause && r.Capabilities.CanSeek && r.Capabilities.CanReadPosition
}
func abs(n int64) int64 {
	if n < 0 {
		return -n
	}
	return n
}
func (s *Service) tickLive(_ string, c *coordinator) {
	if c.live == nil {
		return
	}
	l := c.live
	for _, conn := range l.connections {
		if s.validSession(conn.Session) != nil {
			conn.Sink.Offer("session.replaced", c.epoch, map[string]string{"reason": "session_revoked"})
			s.drop(l, conn)
		}
	}
	changed, err := s.advancePolicy(l, c.room, s.monotonicMs())
	if err != nil {
		return
	}
	if changed {
		c.room.Revision++
		s.refreshLive(c.room.ID, c)
	}
}
func (s *Service) finishLive(_ string, c *coordinator) {
	if c.live != nil {
		for _, conn := range c.live.connections {
			conn.Sink.Offer("server.stopping", c.epoch, map[string]string{"reason": "shutdown"})
			s.drop(c.live, conn)
		}
	}
}

// ServerTimeMs returns this process's monotonic clock for four-timestamp exchanges.
func (s *Service) ServerTimeMs() int64 { return s.monotonicMs() }
