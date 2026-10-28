package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/rooms"
)

type roomTx struct {
	ctx context.Context
	tx  *sql.Tx
}

// Transact runs a room capability operation on the single bounded writer.
func (s *Store) Transact(ctx context.Context, run func(rooms.Tx) error) error {
	return s.write(ctx, func(tx *sql.Tx) error { return run(roomTx{ctx, tx}) })
}
func (t roomTx) SessionValid(hash, id string, now int64) error {
	var exists bool
	err := t.tx.QueryRowContext(t.ctx, `SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND identity_id=? AND expires_at_ms>?)`, hash, id, now).Scan(&exists)
	if err != nil {
		return err
	}
	if !exists {
		return contracts.Failure("session_required")
	}
	return nil
}
func (t roomTx) LoadRoom(id string) (rooms.Room, error) {
	var r rooms.Room
	var settings string
	err := t.tx.QueryRowContext(t.ctx, `SELECT id,host_identity_id,title,settings,revision,created_at_ms,last_active_at_ms FROM rooms WHERE id=?`, id).Scan(&r.ID, &r.HostIdentityID, &r.Title, &settings, &r.Revision, &r.CreatedAtMs, &r.LastActiveAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return r, contracts.Failure("not_found")
	}
	if err != nil {
		return r, err
	}
	wrapper, err := contracts.DecodeObject([]byte(settings))
	if err != nil || len(wrapper) != 2 || wrapper["v"] != json.Number("1") {
		return r, fmt.Errorf("invalid stored settings version")
	}
	b, err := json.Marshal(wrapper["value"])
	if err != nil {
		return r, err
	}
	r.Settings, err = contracts.DecodeRoomSettings(b)
	if err != nil {
		return r, fmt.Errorf("invalid stored settings")
	}
	rows, err := t.tx.QueryContext(t.ctx, `SELECT m.member_id,m.identity_id,i.display_name,m.joined_at_ms FROM room_members m JOIN identities i ON i.id=m.identity_id WHERE m.room_id=? ORDER BY m.member_id`, id)
	if err != nil {
		return r, err
	}
	for rows.Next() {
		var m rooms.Member
		if err := rows.Scan(&m.ID, &m.IdentityID, &m.DisplayName, &m.JoinedAtMs); err != nil {
			_ = rows.Close()
			return r, err
		}
		r.Members = append(r.Members, m)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return r, err
	}
	err = t.tx.QueryRowContext(t.ctx, `SELECT generation,link_hash,code_hash,expires_at_ms FROM room_invitations WHERE room_id=?`, id).Scan(&r.Invite.Generation, &r.Invite.LinkHash, &r.Invite.CodeHash, &r.Invite.ExpiresAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		r.Invite.Generation = r.Revision
		err = nil
	}
	if err != nil {
		return r, err
	}
	if err := t.loadPlayback(&r); err != nil {
		return r, err
	}
	return r, validRoom(r)
}
func validRoom(r rooms.Room) error {
	if !contracts.ValidID(r.ID) || !contracts.ValidID(r.HostIdentityID) || !contracts.ValidTitle(r.Title) || r.Revision < 1 || r.Revision > contracts.MaxSafeInteger || len(r.Members) < 1 || len(r.Members) > 32 || r.Invite.Generation < 1 || r.Invite.Generation > contracts.MaxSafeInteger {
		return fmt.Errorf("invalid stored room")
	}
	b, _ := json.Marshal(r.Settings)
	if _, err := contracts.DecodeRoomSettings(b); err != nil {
		return fmt.Errorf("invalid room settings")
	}
	host := false
	for _, m := range r.Members {
		if !contracts.ValidID(m.ID) || !contracts.ValidID(m.IdentityID) {
			return fmt.Errorf("invalid member")
		}
		if m.IdentityID == r.HostIdentityID {
			host = true
		}
	}
	if !host {
		return fmt.Errorf("missing host membership")
	}
	return nil
}
func settingsJSON(r rooms.Room) string {
	b, _ := json.Marshal(struct {
		V     int                    `json:"v"`
		Value contracts.RoomSettings `json:"value"`
	}{1, r.Settings})
	return string(b)
}
func (t roomTx) InsertRoom(r rooms.Room) error {
	if err := validRoom(r); err != nil {
		return err
	}
	if _, err := t.tx.ExecContext(t.ctx, `INSERT INTO rooms VALUES(?,?,?,?,?,?,?)`, r.ID, r.HostIdentityID, r.Title, settingsJSON(r), r.Revision, r.CreatedAtMs, r.LastActiveAtMs); err != nil {
		return err
	}
	return t.saveChildren(r)
}
func (t roomTx) SaveRoom(r rooms.Room) error {
	if err := validRoom(r); err != nil {
		return err
	}
	if _, err := t.tx.ExecContext(t.ctx, `UPDATE rooms SET settings=?,revision=?,last_active_at_ms=? WHERE id=?`, settingsJSON(r), r.Revision, r.LastActiveAtMs, r.ID); err != nil {
		return err
	}
	return t.saveChildren(r)
}
func (t roomTx) saveChildren(r rooms.Room) error {
	if _, err := t.tx.ExecContext(t.ctx, `DELETE FROM room_members WHERE room_id=?`, r.ID); err != nil {
		return err
	}
	for _, m := range r.Members {
		if _, err := t.tx.ExecContext(t.ctx, `INSERT INTO room_members VALUES(?,?,?,?)`, r.ID, m.IdentityID, m.ID, m.JoinedAtMs); err != nil {
			return err
		}
	}
	if r.Invite.LinkHash == "" {
		return nil
	}
	_, err := t.tx.ExecContext(t.ctx, `INSERT INTO room_invitations VALUES(?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET generation=excluded.generation,link_hash=excluded.link_hash,code_hash=excluded.code_hash,expires_at_ms=excluded.expires_at_ms`, r.ID, r.Invite.Generation, r.Invite.LinkHash, r.Invite.CodeHash, r.Invite.ExpiresAtMs)
	return err
}
func (t roomTx) DeleteRoom(id string) error {
	_, err := t.tx.ExecContext(t.ctx, `DELETE FROM rooms WHERE id=?`, id)
	return err
}
func (t roomTx) Counts(id string) (stored, owned int, err error) {
	err = t.tx.QueryRowContext(t.ctx, `SELECT count(*),coalesce(sum(host_identity_id=?),0) FROM rooms`, id).Scan(&stored, &owned)
	return
}
func (t roomTx) Outcome(id, op, key string, now int64) (rooms.Outcome, bool, error) {
	return findOutcome(t.ctx, t.tx, id, op, key, now)
}
func (t roomTx) SaveOutcome(id, op, key string, o rooms.Outcome) error {
	_, err := t.tx.ExecContext(t.ctx, `INSERT INTO http_idempotency VALUES(?,?,?,?,?,?) ON CONFLICT(identity_id,operation,key) DO UPDATE SET digest=excluded.digest,room_id=excluded.room_id,expires_at_ms=excluded.expires_at_ms`, id, op, key, o.Digest, o.RoomID, o.ExpiresAtMs)
	return err
}

type rowQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func findOutcome(ctx context.Context, q rowQuerier, id, op, key string, now int64) (rooms.Outcome, bool, error) {
	var o rooms.Outcome
	err := q.QueryRowContext(ctx, `SELECT digest,room_id,expires_at_ms FROM http_idempotency WHERE identity_id=? AND operation=? AND key=? AND expires_at_ms>?`, id, op, key, now).Scan(&o.Digest, &o.RoomID, &o.ExpiresAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return o, false, nil
	}
	return o, err == nil, err
}

// FindOutcome looks up nonsecret resource recovery without recovering invitation plaintext.
func (s *Store) FindOutcome(ctx context.Context, id, op, key string, now int64) (rooms.Outcome, bool, error) {
	return findOutcome(ctx, s.db, id, op, key, now)
}

// ResolveInvitation locates an aggregate; its coordinator rechecks the verifier and expiry atomically.
func (s *Store) ResolveInvitation(ctx context.Context, kind, hash string) (string, error) {
	column := "link_hash"
	if kind == "code" {
		column = "code_hash"
	}
	var id string
	err := s.db.QueryRowContext(ctx, `SELECT room_id FROM room_invitations WHERE `+column+`=?`, hash).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return "", contracts.Failure("invalid_invitation")
	}
	return id, err
}

// List returns only the caller's memberships in stable room ID order.
func (s *Store) List(ctx context.Context, id, cursor string, limit int) ([]rooms.Summary, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT r.id,r.title,CASE WHEN r.host_identity_id=? THEN 'host' ELSE 'participant' END,r.revision,r.last_active_at_ms FROM rooms r JOIN room_members m ON m.room_id=r.id WHERE m.identity_id=? AND r.id>? ORDER BY r.id LIMIT ?`, id, id, cursor, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]rooms.Summary, 0)
	for rows.Next() {
		var row rooms.Summary
		if err := rows.Scan(&row.RoomID, &row.Title, &row.Role, &row.Revision, &row.LastActiveAtMs); err != nil {
			return nil, err
		}
		if !contracts.ValidTitle(row.Title) || !contracts.ValidID(row.RoomID) {
			return nil, fmt.Errorf("invalid stored summary")
		}
		result = append(result, row)
	}
	return result, rows.Err()
}
