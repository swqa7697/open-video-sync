package rooms

import (
	"context"
	"encoding/json"
	"time"

	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/identity"
)

func validateSettings(settings contracts.RoomSettings) error {
	b, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	_, err = contracts.DecodeRoomSettings(b)
	return err
}
func outcome(tx Tx, p identity.Session, op, key string, now int64) (Outcome, bool, error) {
	if err := tx.SessionValid(p.TokenHash, p.IdentityID, now); err != nil {
		return Outcome{}, false, err
	}
	o, found, err := tx.Outcome(p.IdentityID, op, key, now)
	if err != nil {
		return o, false, err
	}
	return o, found, nil
}

// Create atomically creates the host membership, room, invitation and retry result.
func (s *Service) Create(ctx context.Context, p identity.Session, key, title string, settings contracts.RoomSettings) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if !contracts.ValidID(key) || !contracts.ValidTitle(title) || validateSettings(settings) != nil {
		return Result{}, contracts.Failure("invalid_input")
	}
	digest := contracts.CanonicalDigest([]any{"ovs-http-v1", "rooms.create", title, contracts.SettingsArray(settings)})
	var roomID string
	var inv *Invitation
	replayed := false
	err := s.Repository.Transact(ctx, func(tx Tx) error {
		now := s.Now().UnixMilli()
		o, found, err := outcome(tx, p, "rooms.create", key, now)
		if err != nil {
			return err
		}
		if found {
			r, err := tx.LoadRoom(o.RoomID)
			if err != nil {
				return err
			}
			if err := authorize(r, p, true); err != nil {
				return err
			}
			if o.Digest != digest {
				return contracts.Failure("idempotency_conflict")
			}
			roomID = o.RoomID
			replayed = true
			return nil
		}
		total, owned, err := tx.Counts(p.IdentityID)
		if err != nil {
			return err
		}
		if total >= s.Limits.MaxStored || owned >= s.Limits.MaxOwned {
			return contracts.Failure("capacity_reached")
		}
		id, err := contracts.RandomID(s.Random)
		if err != nil {
			return err
		}
		mid, err := contracts.RandomID(s.Random)
		if err != nil {
			return err
		}
		invitation, record, err := invitation(s.Random, 1, now)
		if err != nil {
			return err
		}
		r := Room{ID: id, Title: title, HostIdentityID: p.IdentityID, Revision: 1, CreatedAtMs: now, LastActiveAtMs: now, Settings: settings, Members: []Member{{mid, p.IdentityID, p.DisplayName, now}}, Invite: record}
		if err := tx.InsertRoom(r); err != nil {
			return err
		}
		if err := tx.SaveOutcome(p.IdentityID, "rooms.create", key, Outcome{digest, id, now + 86400000}); err != nil {
			return err
		}
		roomID = id
		inv = &invitation
		return nil
	})
	if err != nil {
		return Result{}, err
	}
	snap, err := s.Snapshot(ctx, p, roomID)
	if err == contracts.Failure("capacity_reached") {
		err = contracts.Failure("busy")
	}
	return Result{snap, inv, replayed}, err
}

// Snapshot activates only an authorized room and refreshes its authenticated visit time.
func (s *Service) Snapshot(ctx context.Context, p identity.Session, id string) (Snapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if !contracts.ValidID(id) {
		return Snapshot{}, contracts.Failure("not_found")
	}
	// Check membership before allocating an active coordinator for a guessed room ID.
	if err := s.Repository.Transact(ctx, func(tx Tx) error {
		if err := tx.SessionValid(p.TokenHash, p.IdentityID, s.Now().UnixMilli()); err != nil {
			return err
		}
		r, err := tx.LoadRoom(id)
		if err != nil {
			return err
		}
		return authorize(r, p, false)
	}); err != nil {
		return Snapshot{}, err
	}
	var result Snapshot
	err := s.submit(ctx, id, func(ctx context.Context, epoch string) error {
		return s.Repository.Transact(ctx, func(tx Tx) error {
			if err := tx.SessionValid(p.TokenHash, p.IdentityID, s.Now().UnixMilli()); err != nil {
				return err
			}
			r, err := tx.LoadRoom(id)
			if err != nil {
				return err
			}
			if err := authorize(r, p, false); err != nil {
				return err
			}
			// Batch activity writes to at most once per minute per room.
			now := s.Now().UnixMilli()
			if now-r.LastActiveAtMs >= 60000 {
				r.LastActiveAtMs = now
				if err := tx.SaveRoom(r); err != nil {
					return err
				}
			}
			result = s.roomSnapshot(r, epoch, p.IdentityID)
			return nil
		})
	})
	return result, err
}

// Redeem normalizes the invitation before hashing, and never stores its plaintext.
func (s *Service) Redeem(ctx context.Context, p identity.Session, key, kind, secret string) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if !contracts.ValidID(key) {
		return Result{}, contracts.Failure("invalid_input")
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
	digest := contracts.CanonicalDigest([]any{"ovs-http-v1", "invitations.redeem", kind, secret})
	o, found, err := s.Repository.FindOutcome(ctx, p.IdentityID, "invitations.redeem", key, s.Now().UnixMilli())
	if err != nil {
		return Result{}, err
	}
	id := o.RoomID
	if !found {
		id, err = s.Repository.ResolveInvitation(ctx, kind, hash)
		if err != nil {
			return Result{}, err
		}
	}
	var result Result
	err = s.submit(ctx, id, func(ctx context.Context, epoch string) error {
		return s.Repository.Transact(ctx, func(tx Tx) error {
			now := s.Now().UnixMilli()
			stored, replay, err := outcome(tx, p, "invitations.redeem", key, now)
			if err != nil {
				return err
			}
			r, err := tx.LoadRoom(id)
			if err != nil {
				if err == contracts.Failure("not_found") {
					return contracts.Failure("invalid_invitation")
				}
				return err
			}
			_, existing := member(r, p.IdentityID)
			if replay {
				if !existing {
					return contracts.Failure("invalid_invitation")
				}
				if stored.Digest != digest {
					return contracts.Failure("idempotency_conflict")
				}
			} else {
				expectedHash := r.Invite.LinkHash
				if kind == "code" {
					expectedHash = r.Invite.CodeHash
				}
				if expectedHash != hash || r.Invite.ExpiresAtMs <= now {
					return contracts.Failure("invalid_invitation")
				}
				if !existing {
					if len(r.Members) >= s.Limits.MaxMembers {
						return contracts.Failure("capacity_reached")
					}
					if r.Revision >= contracts.MaxSafeInteger {
						return contracts.Failure("capacity_reached")
					}
					mid, err := contracts.RandomID(s.Random)
					if err != nil {
						return err
					}
					r.Members = append(r.Members, Member{mid, p.IdentityID, p.DisplayName, now})
					r.Revision++
					r.LastActiveAtMs = now
					if err := tx.SaveRoom(r); err != nil {
						return err
					}
				}
				if err := tx.SaveOutcome(p.IdentityID, "invitations.redeem", key, Outcome{digest, id, now + 86400000}); err != nil {
					return err
				}
			}
			result = Result{Snapshot: s.roomSnapshot(r, epoch, p.IdentityID), Replayed: replay}
			return nil
		})
	})
	return result, err
}

// Mutate serializes management with socket commands in the same room coordinator.
func (s *Service) Mutate(ctx context.Context, p identity.Session, id string, m Mutation) (Result, Receipt, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if !contracts.ValidID(id) {
		return Result{}, Receipt{}, contracts.Failure("not_found")
	}
	if !contracts.ValidID(m.Epoch) || m.ExpectedRevision < 1 || m.ExpectedRevision > contracts.MaxSafeInteger {
		return Result{}, Receipt{}, contracts.Failure("invalid_input")
	}
	if m.Operation == "settings" && validateSettings(m.Settings) != nil {
		return Result{}, Receipt{}, contracts.Failure("invalid_input")
	}
	// The snapshot path authorizes before allocating any coordinator.
	if _, err := s.Snapshot(ctx, p, id); err != nil {
		return Result{}, Receipt{}, err
	}
	var result Result
	var receipt Receipt
	var removed string
	err := s.submit(ctx, id, func(ctx context.Context, epoch string) error {
		err := s.Repository.Transact(ctx, func(tx Tx) error {
			now := s.Now().UnixMilli()
			if err := tx.SessionValid(p.TokenHash, p.IdentityID, now); err != nil {
				return err
			}
			r, err := tx.LoadRoom(id)
			if err != nil {
				return err
			}
			if err := authorize(r, p, m.Operation != "remove"); err != nil {
				return err
			}
			if m.Operation == "remove" {
				targetFound := false
				for _, target := range r.Members {
					if target.ID == m.MemberID {
						targetFound = true
						if target.IdentityID == r.HostIdentityID {
							return contracts.Failure("forbidden")
						}
						if p.IdentityID != r.HostIdentityID && target.IdentityID != p.IdentityID {
							return contracts.Failure("forbidden")
						}
					}
				}
				if !targetFound {
					return contracts.Failure("not_found")
				}
			}
			if epoch != m.Epoch || r.Revision != m.ExpectedRevision {
				return contracts.Failure("stale_state")
			}
			if r.Revision >= contracts.MaxSafeInteger {
				return contracts.Failure("capacity_reached")
			}
			r.Revision++
			r.LastActiveAtMs = now
			switch m.Operation {
			case "settings":
				r.Settings = m.Settings
			case "rotate", "remove":
				if r.Invite.Generation >= contracts.MaxSafeInteger {
					return contracts.Failure("capacity_reached")
				}
				inv, record, err := invitation(s.Random, r.Invite.Generation+1, now)
				if err != nil {
					return err
				}
				r.Invite = record
				if m.Operation == "rotate" {
					result.Invitation = &inv
				} else {
					for i, member := range r.Members {
						if member.ID == m.MemberID {
							r.Members = append(r.Members[:i], r.Members[i+1:]...)
							removed = member.ID
							break
						}
					}
				}
			case "close":
				if err := tx.DeleteRoom(id); err != nil {
					return err
				}
				receipt = Receipt{RoomID: id, Revision: r.Revision, Closed: true}
				return nil
			default:
				return contracts.Failure("invalid_input")
			}
			if err := tx.SaveRoom(r); err != nil {
				return err
			}
			result.Snapshot = s.roomSnapshot(r, epoch, p.IdentityID)
			receipt = Receipt{RoomID: id, Revision: r.Revision, RemovedMemberID: removed}
			return nil
		})
		if err == nil {
			s.managementCommitted(id, epoch, m.Operation, removed, receipt.Revision)
			if removed != "" && s.OnRemoved != nil {
				s.OnRemoved(id, removed)
			}
			if m.Operation == "close" {
				if s.OnClosed != nil {
					s.OnClosed(id)
				}
				s.mu.Lock()
				s.coordinators[id].closed = true
				s.mu.Unlock()
			}
		}
		return err
	})
	return result, receipt, err
}

// List returns memberships only and never activates room coordinators.
func (s *Service) List(ctx context.Context, p identity.Session, cursor string, limit int) ([]Summary, *string, error) {
	if (cursor != "" && !contracts.ValidID(cursor)) || limit < 1 || limit > 100 {
		return nil, nil, contracts.Failure("invalid_input")
	}
	rows, err := s.Repository.List(ctx, p.IdentityID, cursor, limit+1)
	if err != nil {
		return nil, nil, err
	}
	var next *string
	if len(rows) > limit {
		rows = rows[:limit]
		value := rows[len(rows)-1].RoomID
		next = &value
	}
	return rows, next, nil
}
