package rooms

import (
	"context"
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

// CommandRecord is persisted atomically with the accepted transition.
type CommandRecord struct {
	Epoch, Digest         string
	Revision, ExpiresAtMs int64
}

// CommandResult acknowledges only committed mutations.
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
	media          *contracts.MediaDescriptor
	generation     int64
	playback       Playback
	barrier        *Barrier
	connections    map[string]*Connection
	active         map[string]string
	generations    map[string]int64
	disconnected   map[string]int64
	reports        map[string]*contracts.Readiness
	excluded       map[string]bool
	cohort         map[string]bool
	bufferSince    map[string]int64
	readySince     map[string]int64
	storageVersion uint64
	hostLost       bool
	lastCheckpoint int64
}

func (s *Service) coordinator(id string) *coordinator {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.coordinators[id]
}
func (s *Service) live(r Room, c *coordinator) *liveRoom {
	if c.live == nil {
		p := Playback{Phase: "empty", BaseRate: 1}
		if r.Media != nil {
			p = Playback{Phase: "paused", PositionMs: r.Playback.PositionMs, AnchorServerMs: s.monotonicMs(), BaseRate: 1}
		}
		c.live = &liveRoom{media: r.Media, generation: r.MediaGeneration, playback: p, connections: make(map[string]*Connection), active: make(map[string]string), generations: make(map[string]int64), disconnected: make(map[string]int64), reports: make(map[string]*contracts.Readiness), excluded: make(map[string]bool), cohort: make(map[string]bool), bufferSince: make(map[string]int64), readySince: make(map[string]int64), storageVersion: s.storageVersion(), lastCheckpoint: s.monotonicMs()}
		c.live.hostLost = r.Media != nil
	}
	return c.live
}
func (s *Service) roomSnapshot(r Room, epoch, identityID string) Snapshot {
	c := s.coordinator(r.ID)
	l := s.live(r, c)
	now := s.monotonicMs()
	result := snapshot(r, epoch, now, identityID)
	result.Media = l.media
	result.MediaGeneration = l.generation
	result.Playback = l.playback
	result.Barrier = l.barrier
	for i := range result.Members {
		m := &result.Members[i]
		for _, connection := range l.connections {
			if connection.MemberID == m.MemberID {
				m.Presence = "connected"
			}
		}
		m.PlaybackActive = l.active[m.MemberID] != "" && l.connections[l.active[m.MemberID]] != nil
		m.Readiness = l.reports[m.MemberID]
		m.ExcludedFromWaiting = l.excluded[m.MemberID]
		m.PlaybackEligible = l.cohort[m.MemberID]
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
func (l *liveRoom) writeTo(r *Room, now int64) {
	r.Media = l.media
	r.MediaGeneration = l.generation
	r.Playback = l.playback
	r.Playback.PositionMs = l.position(now)
	r.Playback.AnchorServerMs = now
}
func (s *Service) loadAuthorized(ctx context.Context, p identity.Session, id string, run func(Tx, Room) error) error {
	return s.Repository.Transact(ctx, func(tx Tx) error {
		if err := tx.SessionValid(p.TokenHash, p.IdentityID, s.Now().UnixMilli()); err != nil {
			return err
		}
		r, err := tx.LoadRoom(id)
		if err != nil {
			return err
		}
		if err = authorize(r, p, false); err != nil {
			return err
		}
		return run(tx, r)
	})
}

// Connect admits at most 500 instance sockets and four tabs per membership.
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
	err := s.submit(ctx, id, func(ctx context.Context, epoch string) error {
		var admitted *liveRoom
		var room Room
		err := s.loadAuthorized(ctx, p, id, func(_ Tx, r Room) error {
			c := s.coordinator(id)
			next := s.live(r, c).clone()
			l := &next
			m, _ := member(r, p.IdentityID)
			tabs := 0
			for _, v := range l.connections {
				if v.MemberID == m.ID {
					tabs++
				}
			}
			if tabs >= 4 {
				return contracts.Failure("capacity_reached")
			}
			cid, err := contracts.RandomID(s.Random)
			if err != nil {
				return err
			}
			l.generations[m.ID]++
			connection = &Connection{cid, id, m.ID, l.generations[m.ID], p, sink}
			l.connections[cid] = connection
			if l.active[m.ID] == "" || l.connections[l.active[m.ID]] == nil {
				l.active[m.ID] = cid
				delete(l.disconnected, m.ID)
				delete(l.reports, m.ID)
			}
			admitted = l
			room = r
			return nil
		})
		if err == nil {
			s.coordinator(id).live = admitted
			installed = true
			sink.Offer("session.welcome", epoch, map[string]any{"connectionId": connection.ID, "connectionGeneration": connection.Generation, "playbackLease": admitted.active[connection.MemberID] == connection.ID, "snapshot": s.roomSnapshot(room, epoch, p.IdentityID)})
		}
		return err
	})
	if err != nil {
		if installed {
			// A deadline can win after admission committed. Release that actual connection.
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

// Disconnect releases a socket, keeping its playback lease for the reconnect grace.
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

// Handle applies a validated socket frame through the room coordinator.
func (s *Service) Handle(ctx context.Context, c *Connection, f contracts.ClientFrame) error {
	return s.dispatch(ctx, c.RoomID, func(ctx context.Context, epoch string) error {
		var resultRevision int64
		var committed *liveRoom
		err := s.loadAuthorized(ctx, c.Session, c.RoomID, func(tx Tx, r Room) error {
			l := s.live(r, s.coordinator(r.ID))
			if l.connections[c.ID] != c {
				return contracts.Failure("session_required")
			}
			if f.Epoch != epoch {
				return contracts.Failure("stale_state")
			}
			if f.Type == "member.activate" {
				old := l.connections[l.active[c.MemberID]]
				if old != nil && old != c {
					old.Sink.Offer("session.replaced", epoch, map[string]string{"reason": "lease_transferred"})
					s.drop(l, old)
				}
				l.active[c.MemberID] = c.ID
				delete(l.disconnected, c.MemberID)
				delete(l.reports, c.MemberID)
				c.Sink.Offer("session.welcome", epoch, map[string]any{"connectionId": c.ID, "connectionGeneration": c.Generation, "playbackLease": true, "snapshot": s.roomSnapshot(r, epoch, c.Session.IdentityID)})
				return nil
			}
			if err := s.active(l, c); err != nil {
				return err
			}
			if f.Type == "member.readiness" || f.Type == "member.observation" {
				if f.Report.MediaGeneration != l.generation {
					return contracts.Failure("stale_state")
				}
				if f.Report.PositionMs != nil && (l.media == nil || *f.Report.PositionMs > l.media.DurationMs) {
					return contracts.Failure("invalid_command")
				}
				if f.Type == "member.readiness" {
					if (l.barrier != nil && (f.Report.BarrierID == nil || *f.Report.BarrierID != l.barrier.BarrierID)) || (l.barrier == nil && f.Report.BarrierID != nil) {
						return contracts.Failure("stale_state")
					}
					report := f.Report
					l.reports[c.MemberID] = &report
					if report.Status != "ready" {
						delete(l.readySince, c.MemberID)
					}
					if report.Status != "buffering" {
						delete(l.bufferSince, c.MemberID)
					}
				}
				return nil
			}
			if f.Type == "media.select" || f.Type == "waiting.exclude" {
				if r.HostIdentityID != c.Session.IdentityID {
					return contracts.Failure("forbidden")
				}
			} else if r.Settings.Controllers != "everyone" && r.HostIdentityID != c.Session.IdentityID {
				return contracts.Failure("forbidden")
			}
			previous, found, err := tx.Command(r.ID, c.Session.IdentityID, f.CommandID, s.Now().UnixMilli())
			if err != nil {
				return err
			}
			digest := contracts.CommandDigest(f)
			if found {
				if previous.Epoch != epoch {
					return contracts.Failure("stale_state")
				}
				if previous.Digest != digest {
					return contracts.Failure("invalid_command")
				}
				resultRevision = previous.Revision
				return nil
			}
			if f.ExpectedRevision != r.Revision || f.MediaGeneration != l.generation {
				return contracts.Failure("stale_state")
			}
			if r.Revision >= contracts.MaxSafeInteger {
				return contracts.Failure("capacity_reached")
			}
			next := l.clone()
			now := s.monotonicMs()
			next.playback.PositionMs = l.position(now)
			next.playback.AnchorServerMs = now
			switch f.Type {
			case "media.select":
				if f.Media.Kind != "local" {
					return contracts.Failure("invalid_command")
				}
				if l.generation >= contracts.MaxSafeInteger {
					return contracts.Failure("capacity_reached")
				}
				m := f.Media
				next.media = &m
				next.generation++
				next.playback = Playback{Phase: "paused", AnchorServerMs: now, BaseRate: 1}
				next.barrier = nil
				next.reports = make(map[string]*contracts.Readiness)
				next.excluded = make(map[string]bool)
				next.cohort = make(map[string]bool)
				next.bufferSince = make(map[string]int64)
				next.readySince = make(map[string]int64)
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
					if f.PositionMs > l.media.DurationMs {
						return contracts.Failure("invalid_command")
					}
					next.playback.PositionMs = f.PositionMs
					if next.playback.Phase == "ended" {
						next.playback.Phase = "paused"
					}
					if next.playback.Phase == "waiting" {
						if err := s.startBarrier(&next, r, l.barrier.Reason, l.barrier.RequiredMemberIDs, now); err != nil {
							return err
						}
					}
				case "play", "replay":
					if l.hostLost && r.HostIdentityID != c.Session.IdentityID {
						return contracts.Failure("forbidden")
					}
					next.hostLost = false
					if f.Action == "replay" || next.playback.PositionMs >= l.media.DurationMs {
						next.playback.PositionMs = 0
					}
					next.playback.Phase = "playing"
					next.playback.DesiredPlaying = true
					next.barrier = nil
					next.cohort = make(map[string]bool)
					for _, m := range r.Members {
						if m.IdentityID == r.HostIdentityID || l.connections[l.active[m.ID]] != nil {
							next.cohort[m.ID] = true
						}
					}
					if r.Settings.WaitMode == "all" {
						required := []string{}
						for _, m := range r.Members {
							if next.cohort[m.ID] && !l.excluded[m.ID] {
								required = append(required, m.ID)
							}
						}
						if err := s.startBarrier(&next, r, "play", required, now); err != nil {
							return err
						}
					}
				default:
					return contracts.Failure("invalid_command")
				}
			case "waiting.exclude":
				found := false
				for _, m := range r.Members {
					if m.ID == f.MemberID {
						if m.IdentityID == r.HostIdentityID {
							return contracts.Failure("forbidden")
						}
						found = true
					}
				}
				if !found || l.media == nil {
					return contracts.Failure("invalid_command")
				}
				next.excluded[f.MemberID] = f.Excluded
				if next.barrier != nil && f.Excluded {
					ids := []string{}
					for _, mid := range next.barrier.RequiredMemberIDs {
						if mid != f.MemberID {
							ids = append(ids, mid)
						}
					}
					next.barrier.RequiredMemberIDs = ids
				}
				if next.barrier != nil && !f.Excluded && next.cohort[f.MemberID] {
					found := false
					for _, mid := range next.barrier.RequiredMemberIDs {
						if mid == f.MemberID {
							found = true
						}
					}
					if !found {
						next.barrier.RequiredMemberIDs = append(next.barrier.RequiredMemberIDs, f.MemberID)
					}
				}
			default:
				return contracts.Failure("invalid_command")
			}
			r.Revision++
			r.LastActiveAtMs = s.Now().UnixMilli()
			next.writeTo(&r, now)
			if err := tx.SaveRoom(r); err != nil {
				return err
			}
			if err := tx.SavePlayback(r, s.Now().UnixMilli()); err != nil {
				return err
			}
			if err := tx.SaveCommand(r.ID, c.Session.IdentityID, f.CommandID, CommandRecord{epoch, digest, r.Revision, s.Now().UnixMilli() + 86400000}); err != nil {
				return err
			}
			resultRevision = r.Revision
			// Do not publish runtime state until Transact has committed.
			committed = &next
			return nil
		})
		if err == nil && f.Type == "member.readiness" {
			s.tickLive(c.RoomID, s.coordinator(c.RoomID))
		}
		if err == nil && committed != nil {
			s.coordinator(c.RoomID).live = committed
		}
		committed = nil
		if f.CommandID != "" {
			result := CommandResult{CommandID: f.CommandID, Accepted: err == nil}
			if err == nil {
				result.Revision = &resultRevision
			} else {
				result.Error = s.publicError(err)
			}
			c.Sink.Offer("command.result", epoch, result)
		} else if err != nil && !(err == contracts.Failure("stale_state") && (f.Type == "member.readiness" || f.Type == "member.observation")) {
			c.Sink.Offer("error", epoch, s.publicError(err))
		}
		if err != nil {
			s.refreshLive(c.RoomID, s.coordinator(c.RoomID))
			var failure contracts.Failure
			if !errors.As(err, &failure) {
				s.failLive(s.coordinator(c.RoomID))
			}
		}
		return err
	}, false)
}
func (s *Service) publicError(err error) *contracts.PublicError {
	code := "storage_unavailable"
	var f contracts.Failure
	if errors.As(err, &f) {
		code = string(f)
	}
	id, _ := contracts.RandomID(s.Random)
	return &contracts.PublicError{Code: code, Message: "The room request could not complete.", RequestID: id, Retryable: code == "busy" || code == "storage_unavailable" || code == "rate_limited"}
}
func (s *Service) refreshLive(id string, c *coordinator) {
	if c.live == nil || len(c.live.connections) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var r Room
	err := s.Repository.Transact(ctx, func(tx Tx) error {
		var err error
		r, err = tx.LoadRoom(id)
		if err != nil {
			return err
		}
		for _, conn := range c.live.connections {
			_, exists := member(r, conn.Session.IdentityID)
			sessionErr := tx.SessionValid(conn.Session.TokenHash, conn.Session.IdentityID, s.Now().UnixMilli())
			if sessionErr != nil && sessionErr != contracts.Failure("session_required") {
				return sessionErr
			}
			if !exists || sessionErr != nil {
				conn.Sink.Offer("session.replaced", c.epoch, map[string]string{"reason": "session_revoked"})
				s.drop(c.live, conn)
			}
		}
		if len(c.live.connections) > 0 && s.Now().UnixMilli()-r.LastActiveAtMs >= 60000 {
			r.LastActiveAtMs = s.Now().UnixMilli()
			if err := tx.SaveRoom(r); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		s.failLive(c)
		return
	}
	for _, conn := range c.live.connections {
		conn.Sink.Offer("room.snapshot", c.epoch, s.roomSnapshot(r, c.epoch, conn.Session.IdentityID))
	}
}
func (s *Service) failLive(c *coordinator) {
	if c.live == nil {
		return
	}
	for _, conn := range c.live.connections {
		conn.Sink.Offer("error", c.epoch, s.publicError(contracts.Failure("storage_unavailable")))
		s.drop(c.live, conn)
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
		delete(c.live.excluded, removed)
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
func (s *Service) tickLive(id string, c *coordinator) {
	if c.live == nil {
		return
	}
	l := c.live
	now := s.monotonicMs()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var committed *liveRoom
	var publish bool
	err := s.Repository.Transact(ctx, func(tx Tx) error {
		r, err := tx.LoadRoom(id)
		if err != nil {
			return err
		}
		next := l.clone()
		transition, err := s.advancePolicy(&next, r, now)
		if err != nil {
			return err
		}
		checkpoint := l.media != nil && l.playback.Phase == "playing" && now-l.lastCheckpoint >= 10000
		if !transition && !checkpoint {
			// Timer observations are ephemeral, but retain their server receive times.
			committed = &next
			return nil
		}
		publish = true
		if transition {
			if r.Revision >= contracts.MaxSafeInteger {
				return contracts.Failure("capacity_reached")
			}
			r.Revision++
			r.LastActiveAtMs = s.Now().UnixMilli()
			if err := tx.SaveRoom(r); err != nil {
				return err
			}
		}
		next.writeTo(&r, now)
		if err := tx.SavePlayback(r, s.Now().UnixMilli()); err != nil {
			return err
		}
		next.lastCheckpoint = now
		if checkpoint {
			r.LastActiveAtMs = s.Now().UnixMilli()
			if err := tx.SaveRoom(r); err != nil {
				return err
			}
		}
		committed = &next
		return nil
	})
	if err != nil {
		s.failLive(c)
		return
	}
	if committed != nil {
		c.live = committed
	}
	// Periodic authorization also revokes otherwise idle sessions.
	if now%5000 < 250 || publish {
		s.refreshLive(id, c)
	}
}
func (s *Service) finishLive(id string, c *coordinator) error {
	if c.live == nil {
		return nil
	}
	s.mu.Lock()
	parent := s.shutdown
	s.mu.Unlock()
	shuttingDown := parent != nil
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	for _, conn := range c.live.connections {
		conn.Sink.Offer("server.stopping", c.epoch, map[string]string{"reason": "shutdown"})
	}
	err := s.Repository.Transact(ctx, func(tx Tx) error {
		r, err := tx.LoadRoom(id)
		if err != nil {
			return err
		}
		if c.live.media == nil {
			return nil
		}
		if c.live.storageVersion == s.storageVersion() {
			c.live.writeTo(&r, s.monotonicMs())
		}
		r.Playback.Phase = "paused"
		r.Playback.DesiredPlaying = false
		return tx.SavePlayback(r, s.Now().UnixMilli())
	})
	if shuttingDown && err != nil && err != contracts.Failure("not_found") {
		s.mu.Lock()
		s.shutdownErr = errors.Join(s.shutdownErr, err)
		s.mu.Unlock()
	}
	for _, conn := range c.live.connections {
		s.drop(c.live, conn)
	}
	return err
}

// ServerTimeMs returns this process's monotonic clock for four-timestamp exchanges.
func (s *Service) ServerTimeMs() int64 { return s.monotonicMs() }
