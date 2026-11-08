package rooms

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
)

func validateSettings(settings contracts.RoomSettings) error {
	b, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	_, err = contracts.DecodeRoomSettings(b)
	return err
}
func cloneRoom(r Room) Room { r.Members = append([]Member{}, r.Members...); return r }
func (s *Service) install(r Room) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if old, ok := s.records[r.ID]; ok {
		delete(s.links, old.Invite.LinkHash)
		delete(s.codes, old.Invite.CodeHash)
	}
	for _, m := range r.Members {
		if _, ok := s.names[m.IdentityID]; !ok {
			s.names[m.IdentityID] = m.DisplayName
		}
	}
	s.records[r.ID] = cloneRoom(r)
	if r.Invite.LinkHash != "" {
		s.links[r.Invite.LinkHash] = r.ID
	}
	if r.Invite.CodeHash != "" {
		s.codes[r.Invite.CodeHash] = r.ID
	}
}
func (s *Service) validSession(p identity.Session) error {
	if s.SessionValid != nil {
		return s.SessionValid(p)
	}
	s.mu.Lock()
	revoked := s.revoked[p.TokenHash]
	s.mu.Unlock()
	if revoked || p.ExpiresAtMs <= s.Now().UnixMilli() {
		return contracts.Failure("session_required")
	}
	return nil
}
func (s *Service) access(p identity.Session, id string) error {
	if err := s.validSession(p); err != nil {
		return err
	}
	s.mu.Lock()
	r, ok := s.records[id]
	s.mu.Unlock()
	if !ok {
		return contracts.Failure("not_found")
	}
	return authorize(r, p, false)
}

// Request recovery is serialized per request, without holding the registry lock across storage.
func (s *Service) requestOwner(ctx context.Context, k string) (func(), error) {
	for {
		s.receiptMu.Lock()
		if s.requests == nil {
			s.requests = make(map[string]chan struct{})
		}
		wait := s.requests[k]
		if wait == nil {
			if len(s.requests) >= 4096 {
				s.receiptMu.Unlock()
				return nil, contracts.Failure("busy")
			}
			wait = make(chan struct{})
			s.requests[k] = wait
			s.receiptMu.Unlock()
			return func() { s.receiptMu.Lock(); delete(s.requests, k); close(wait); s.receiptMu.Unlock() }, nil
		}
		s.receiptMu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-wait:
		}
	}
}
func (s *Service) receipt(k string) (Outcome, bool) {
	s.receiptMu.Lock()
	defer s.receiptMu.Unlock()
	s.pruneReceipts()
	o, ok := s.receipts[k]
	return o, ok
}
func (s *Service) pruneReceipts() {
	for k, o := range s.receipts {
		if o.ExpiresAtMs <= s.Now().UnixMilli() {
			delete(s.receipts, k)
			delete(s.receiptOwners, k)
		}
	}
}
func (s *Service) saveReceipt(k, owner string, o Outcome) {
	s.receiptMu.Lock()
	defer s.receiptMu.Unlock()
	s.pruneReceipts()
	for {
		count := 0
		oldest := ""
		var expiry int64
		for key, value := range s.receipts {
			if s.receiptOwners[key] == owner {
				count++
				if oldest == "" || value.ExpiresAtMs < expiry {
					oldest = key
					expiry = value.ExpiresAtMs
				}
			}
		}
		if count < 256 {
			break
		}
		delete(s.receipts, oldest)
		delete(s.receiptOwners, oldest)
	}
	if len(s.receipts) >= 4096 {
		oldest := ""
		var expiry int64
		for key, value := range s.receipts {
			if oldest == "" || value.ExpiresAtMs < expiry {
				oldest = key
				expiry = value.ExpiresAtMs
			}
		}
		delete(s.receipts, oldest)
		delete(s.receiptOwners, oldest)
	}
	s.receipts[k] = o
	s.receiptOwners[k] = owner
}

// Create commits the room and host membership before publishing memory state.
func (s *Service) Create(ctx context.Context, p identity.Session, key, title string, settings contracts.RoomSettings) (Result, error) {
	return s.create(ctx, p, key, title, settings, nil, false)
}

// RecoverCreate checks a retained result without ever creating another room.
func (s *Service) RecoverCreate(ctx context.Context, p identity.Session, key, title string, settings contracts.RoomSettings) (Result, error) {
	return s.create(ctx, p, key, title, settings, nil, true)
}

// CreateSelected atomically creates a room and its initial descriptor. The random request
// key is also the room ID, allowing room-specific local matching before creation.
func (s *Service) CreateSelected(ctx context.Context, p identity.Session, key, title string, settings contracts.RoomSettings, media contracts.MediaDescriptor, recoveryOnly bool) (Result, error) {
	b, err := json.Marshal(media)
	if err != nil {
		return Result{}, contracts.Failure("invalid_input")
	}
	validated, err := contracts.DecodeMedia(b)
	if err != nil {
		return Result{}, contracts.Failure("invalid_input")
	}
	return s.create(ctx, p, key, title, settings, &validated, recoveryOnly)
}
func (s *Service) create(ctx context.Context, p identity.Session, key, title string, settings contracts.RoomSettings, initial *contracts.MediaDescriptor, recoveryOnly bool) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if !contracts.ValidID(key) || !contracts.ValidTitle(title) || validateSettings(settings) != nil {
		return Result{}, contracts.Failure("invalid_input")
	}
	if err := s.validSession(p); err != nil {
		return Result{}, err
	}
	k := p.IdentityID + ":create:" + key
	release, err := s.requestOwner(ctx, k)
	if err != nil {
		return Result{}, err
	}
	defer release()
	digest := contracts.CanonicalDigest([]any{"ovs-http-v1", "rooms.create", title, contracts.SettingsArray(settings), initial})
	if o, ok := s.receipt(k); ok {
		snap, err := s.Snapshot(ctx, p, o.RoomID)
		if err != nil {
			return Result{}, err
		}
		if snap.SelfMemberID != snap.HostMemberID {
			return Result{}, contracts.Failure("forbidden")
		}
		if o.Digest != digest {
			return Result{}, contracts.Failure("idempotency_conflict")
		}
		inv, err := s.Invitation(ctx, p, o.RoomID)
		return Result{Snapshot: snap, Invitation: &inv, Replayed: true}, err
	}
	if recoveryOnly {
		return Result{}, contracts.Failure("request_outcome_unknown")
	}
	id, err := contracts.RandomID(s.Random)
	if err != nil {
		return Result{}, err
	}
	if initial != nil {
		id = key
	}
	mid, err := contracts.RandomID(s.Random)
	if err != nil {
		return Result{}, err
	}
	inv, record, err := invitation(s.Random, 1, s.Now().UnixMilli())
	if err != nil {
		return Result{}, err
	}
	s.mu.Lock()
	owned := 0
	for _, r := range s.records {
		if r.HostIdentityID == p.IdentityID {
			owned++
		}
	}
	for _, owner := range s.pending {
		if owner == p.IdentityID {
			owned++
		}
	}
	if s.stopping || len(s.records)+len(s.pending) >= s.Limits.MaxStored || owned >= s.Limits.MaxOwned {
		s.mu.Unlock()
		return Result{}, contracts.Failure("capacity_reached")
	}
	if _, exists := s.records[id]; exists {
		s.mu.Unlock()
		return Result{}, contracts.Failure("request_outcome_unknown")
	}
	if _, exists := s.pending[id]; exists {
		s.mu.Unlock()
		return Result{}, contracts.Failure("busy")
	}
	s.pending[id] = p.IdentityID
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.pending, id); s.mu.Unlock() }()
	now := s.Now().UnixMilli()
	r := Room{ID: id, Title: title, HostIdentityID: p.IdentityID, Revision: 1, CreatedAtMs: now, Settings: settings, Members: []Member{{mid, p.IdentityID, p.DisplayName, now}}, Invite: record, Media: initial}
	if err := s.Repository.Transact(ctx, func(tx Tx) error {
		if err := tx.InsertRoom(r); err != nil {
			return err
		}
		if initial != nil {
			return tx.SelectMedia(id, *initial)
		}
		return nil
	}); err != nil {
		return Result{}, err
	}
	s.install(r)
	s.saveReceipt(k, p.IdentityID, Outcome{digest, id, now + 60000})
	snap, err := s.Snapshot(ctx, p, id)
	return Result{Snapshot: snap, Invitation: &inv}, err
}

// Snapshot authorizes from memory before allocating a playback coordinator.
func (s *Service) Snapshot(ctx context.Context, p identity.Session, id string) (Snapshot, error) {
	if !contracts.ValidID(id) {
		return Snapshot{}, contracts.Failure("not_found")
	}
	if err := s.access(p, id); err != nil {
		return Snapshot{}, err
	}
	var result Snapshot
	err := s.submit(ctx, id, func(_ context.Context, epoch string) error {
		if err := s.access(p, id); err != nil {
			return err
		}
		c := s.coordinator(id)
		result = s.roomSnapshot(c.room, epoch, p.IdentityID)
		return nil
	})
	return result, err
}

// Invitation returns the existing recoverable invitation to its host only.
func (s *Service) Invitation(ctx context.Context, p identity.Session, id string) (Invitation, error) {
	if err := s.access(p, id); err != nil {
		return Invitation{}, err
	}
	var result Invitation
	err := s.submit(ctx, id, func(_ context.Context, _ string) error {
		if err := s.validSession(p); err != nil {
			return err
		}
		r := s.coordinator(id).room
		if err := authorize(r, p, true); err != nil {
			return err
		}
		result = Invitation{r.Invite.LinkSecret, r.Invite.Code}
		return nil
	})
	return result, err
}

// Redeem persists a new membership once. Verifiers and retry receipts live in memory.
func (s *Service) Redeem(ctx context.Context, p identity.Session, key, kind, secret string) (Result, error) {
	if !contracts.ValidID(key) {
		return Result{}, contracts.Failure("invalid_input")
	}
	if err := s.validSession(p); err != nil {
		return Result{}, err
	}
	var hash string
	switch kind {
	case "link":
		var ok bool
		hash, ok = contracts.SecretHash(secret, 16)
		if !ok {
			return Result{}, contracts.Failure("invalid_invitation")
		}
	case "code":
		code, ok := contracts.NormalizeCode(secret)
		if !ok {
			return Result{}, contracts.Failure("invalid_invitation")
		}
		secret = code
		hash = contracts.Hash([]byte(code))
	default:
		return Result{}, contracts.Failure("invalid_input")
	}
	k := p.IdentityID + ":redeem:" + key
	release, err := s.requestOwner(ctx, k)
	if err != nil {
		return Result{}, err
	}
	defer release()
	digest := contracts.CanonicalDigest([]any{"ovs-http-v1", "invitations.redeem", kind, secret})
	o, replay := s.receipt(k)
	id := o.RoomID
	if !replay {
		s.mu.Lock()
		if kind == "link" {
			id = s.links[hash]
		} else {
			id = s.codes[hash]
		}
		s.mu.Unlock()
	}
	if id == "" {
		return Result{}, contracts.Failure("invalid_invitation")
	}
	var result Result
	err = s.submit(ctx, id, func(ctx context.Context, epoch string) error {
		if err := s.validSession(p); err != nil {
			return err
		}
		c := s.coordinator(id)
		r := cloneRoom(c.room)
		_, existing := member(r, p.IdentityID)
		if replay {
			if !existing {
				return contracts.Failure("invalid_invitation")
			}
			if o.Digest != digest {
				return contracts.Failure("idempotency_conflict")
			}
		} else {
			expected := r.Invite.LinkHash
			if kind == "code" {
				expected = r.Invite.CodeHash
			}
			if expected != hash {
				return contracts.Failure("invalid_invitation")
			}
			if !existing {
				if len(r.Members) >= s.Limits.MaxMembers || r.Revision >= contracts.MaxSafeInteger {
					return contracts.Failure("capacity_reached")
				}
				mid, err := contracts.RandomID(s.Random)
				if err != nil {
					return err
				}
				m := Member{mid, p.IdentityID, p.DisplayName, s.Now().UnixMilli()}
				if err := s.Repository.Transact(ctx, func(tx Tx) error { return tx.AddMember(id, m) }); err != nil {
					return err
				}
				r.Members = append(r.Members, m)
				r.Revision++
				c.room = r
				s.install(r)
				s.refreshLive(id, c)
			}
			s.saveReceipt(k, p.IdentityID, Outcome{digest, id, s.Now().UnixMilli() + 60000})
		}
		result = Result{Snapshot: s.roomSnapshot(c.room, epoch, p.IdentityID), Replayed: replay}
		return nil
	})
	if err == contracts.Failure("not_found") {
		err = contracts.Failure("invalid_invitation")
	}
	return result, err
}

// Mutate uses the same coordinator as playback and installs durable state after commit.
func (s *Service) Mutate(ctx context.Context, p identity.Session, id string, m Mutation) (Result, Receipt, error) {
	if !contracts.ValidID(m.Epoch) || m.ExpectedRevision < 1 || m.ExpectedRevision > contracts.MaxSafeInteger || (m.Operation == "settings" && validateSettings(m.Settings) != nil) {
		return Result{}, Receipt{}, contracts.Failure("invalid_input")
	}
	if _, err := s.Snapshot(ctx, p, id); err != nil {
		return Result{}, Receipt{}, err
	}
	var result Result
	var receipt Receipt
	err := s.submit(ctx, id, func(ctx context.Context, epoch string) error {
		if err := s.validSession(p); err != nil {
			return err
		}
		c := s.coordinator(id)
		r := cloneRoom(c.room)
		if err := authorize(r, p, m.Operation != "remove" && m.Operation != "leave"); err != nil {
			return err
		}
		if m.Operation == "leave" {
			if epoch != m.Epoch || r.Revision != m.ExpectedRevision {
				return contracts.Failure("stale_state")
			}
			self, _ := member(r, p.IdentityID)
			if s.finalDeparture(c, self.ID) {
				m.Operation = "close"
			} else if p.IdentityID == r.HostIdentityID {
				m.Operation = "host_leave"
				m.MemberID = self.ID
			} else {
				m.Operation = "remove"
				m.MemberID = self.ID
			}
		}
		removed := ""
		if m.Operation == "remove" {
			for i, target := range r.Members {
				if target.ID == m.MemberID {
					if target.IdentityID == r.HostIdentityID || (p.IdentityID != r.HostIdentityID && target.IdentityID != p.IdentityID) {
						return contracts.Failure("forbidden")
					}
					removed = target.ID
					r.Members = append(r.Members[:i], r.Members[i+1:]...)
					break
				}
			}
			if removed == "" {
				return contracts.Failure("not_found")
			}
		}
		if epoch != m.Epoch || r.Revision != m.ExpectedRevision {
			return contracts.Failure("stale_state")
		}
		if r.Revision >= contracts.MaxSafeInteger {
			return contracts.Failure("capacity_reached")
		}
		oldSettings := r.Settings
		switch m.Operation {
		case "host_leave":
			r.Settings.EveryoneCanControl = true
			removed = m.MemberID
		case "settings":
			r.Settings = m.Settings
		case "rotate":
			if r.Invite.Generation >= contracts.MaxSafeInteger {
				return contracts.Failure("capacity_reached")
			}
			inv, record, err := invitation(s.Random, r.Invite.Generation+1, s.Now().UnixMilli())
			if err != nil {
				return err
			}
			r.Invite = record
			result.Invitation = &inv
		case "close", "remove":
		default:
			return contracts.Failure("invalid_input")
		}
		if err := s.Repository.Transact(ctx, func(tx Tx) error {
			switch m.Operation {
			case "host_leave", "settings":
				return tx.UpdateSettings(id, r.Settings)
			case "rotate":
				return tx.ResetInvitation(id, r.Invite)
			case "remove":
				return tx.RemoveMember(id, removed)
			case "close":
				return tx.DeleteRoom(id)
			}
			return nil
		}); err != nil {
			return err
		}
		r.Revision++
		c.room = r
		if m.Operation == "close" {
			s.mu.Lock()
			delete(s.records, id)
			delete(s.links, r.Invite.LinkHash)
			delete(s.codes, r.Invite.CodeHash)
			delete(s.restored, id)
			s.mu.Unlock()
		} else {
			s.install(r)
		}
		if m.Operation == "settings" && oldSettings.WaitForAll != r.Settings.WaitForAll {
			l := s.live(r, c)
			l.playback.PositionMs = l.position(s.monotonicMs())
			l.playback.AnchorServerMs = s.monotonicMs()
			if l.media != nil {
				l.playback.Phase = "paused"
			}
			l.playback.DesiredPlaying = false
			l.barrier = nil
			l.bufferSince = make(map[string]int64)
			l.readySince = make(map[string]int64)
		}
		receipt = Receipt{RoomID: id, Revision: r.Revision, RemovedMemberID: removed, Closed: m.Operation == "close"}
		s.managementCommitted(id, epoch, m.Operation, removed, r.Revision)
		if m.Operation == "host_leave" {
			c.hostDeadline = 0
		}
		if m.Operation == "remove" && len(s.live(r, c).connections) == 0 && c.emptyDeadline == 0 {
			c.emptyDeadline = s.monotonicMs() + departureGraceMs
		}
		if removed != "" && s.OnRemoved != nil {
			s.OnRemoved(id, removed)
		}
		if m.Operation == "close" {
			if s.OnClosed != nil {
				s.OnClosed(id)
			}
			c.closed = true
		} else {
			result.Snapshot = s.roomSnapshot(r, epoch, p.IdentityID)
			s.refreshLive(id, c)
		}
		return nil
	})
	return result, receipt, err
}

// List reads authorized memberships from application memory without activating playback.
func (s *Service) List(_ context.Context, p identity.Session, cursor string, limit int) ([]Summary, *string, error) {
	if err := s.validSession(p); err != nil {
		return nil, nil, err
	}
	if (cursor != "" && !contracts.ValidID(cursor)) || limit < 1 || limit > 100 {
		return nil, nil, contracts.Failure("invalid_input")
	}
	rows := []Summary{}
	s.mu.Lock()
	for _, r := range s.records {
		if _, ok := member(r, p.IdentityID); ok && r.ID > cursor {
			role := "participant"
			if r.HostIdentityID == p.IdentityID {
				role = "host"
			}
			rows = append(rows, Summary{RoomID: r.ID, Title: r.Title, Role: role})
		}
	}
	s.mu.Unlock()
	sort.Slice(rows, func(i, j int) bool { return rows[i].RoomID < rows[j].RoomID })
	var next *string
	if len(rows) > limit {
		rows = rows[:limit]
		value := rows[len(rows)-1].RoomID
		next = &value
	}
	return rows, next, nil
}
