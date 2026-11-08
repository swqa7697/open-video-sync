package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/rooms"
)

type roomTx struct {
	ctx context.Context
	tx  *sql.Tx
}

// Transact commits a durable room change on the bounded writer.
func (s *Store) Transact(ctx context.Context, run func(rooms.Tx) error) error {
	return s.write(ctx, func(tx *sql.Tx) error { return run(roomTx{ctx, tx}) })
}

// LoadRooms loads durable metadata once before application admission.
func (s *Store) LoadRooms(ctx context.Context) ([]rooms.Room, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,host_identity_id,title,settings,created_at_ms FROM rooms ORDER BY id`)
	if err != nil {
		return nil, err
	}
	result := []rooms.Room{}
	for rows.Next() {
		var r rooms.Room
		var raw string
		if err := rows.Scan(&r.ID, &r.HostIdentityID, &r.Title, &raw, &r.CreatedAtMs); err != nil {
			rows.Close()
			return nil, err
		}
		var wrapper struct {
			V     int             `json:"v"`
			Value json.RawMessage `json:"value"`
		}
		if err := json.Unmarshal([]byte(raw), &wrapper); err != nil || (wrapper.V != 2 && wrapper.V != 3 && wrapper.V != 4) {
			rows.Close()
			return nil, fmt.Errorf("invalid stored settings version")
		}
		r.Settings, err = decodeStoredSettings(wrapper.V, wrapper.Value)
		if err != nil {
			rows.Close()
			return nil, fmt.Errorf("invalid stored settings")
		}
		result = append(result, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	for i := range result {
		r := &result[i]
		rows, err := s.db.QueryContext(ctx, `SELECT m.member_id,m.identity_id,i.display_name,m.joined_at_ms FROM room_members m JOIN identities i ON i.id=m.identity_id WHERE m.room_id=? ORDER BY m.member_id`, r.ID)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var m rooms.Member
			if err := rows.Scan(&m.ID, &m.IdentityID, &m.DisplayName, &m.JoinedAtMs); err != nil {
				rows.Close()
				return nil, err
			}
			r.Members = append(r.Members, m)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		err = s.db.QueryRowContext(ctx, `SELECT generation,link_hash,code_hash,link_secret,code FROM room_invitations WHERE room_id=?`, r.ID).Scan(&r.Invite.Generation, &r.Invite.LinkHash, &r.Invite.CodeHash, &r.Invite.LinkSecret, &r.Invite.Code)
		if err != nil {
			return nil, err
		}
		var raw string
		err = s.db.QueryRowContext(ctx, `SELECT descriptor FROM room_media WHERE room_id=?`, r.ID).Scan(&raw)
		if err != nil && err != sql.ErrNoRows {
			return nil, err
		}
		if err == nil {
			var wrapper struct {
				V     int             `json:"v"`
				Value json.RawMessage `json:"value"`
			}
			if json.Unmarshal([]byte(raw), &wrapper) != nil || wrapper.V != 1 {
				return nil, fmt.Errorf("invalid stored media version")
			}
			m, err := contracts.DecodeMedia(wrapper.Value)
			if err != nil {
				return nil, fmt.Errorf("invalid stored media")
			}
			r.Media = &m
		}
		r.Revision = 1
		if err := validRoom(*r); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func decodeStoredSettings(version int, data []byte) (contracts.RoomSettings, error) {
	if version == 4 {
		return contracts.DecodeRoomSettings(data)
	}
	// Legacy versions used host/everyone enums. Convert only their exact shapes
	// in memory; startup never rewrites existing records.
	legacy, err := contracts.DecodeObject(data)
	fieldCount := 2
	if version == 3 {
		fieldCount = 3
	}
	if err != nil || len(legacy) != fieldCount {
		return contracts.RoomSettings{}, contracts.ErrInvalidInput
	}
	controllers, c := legacy["controllers"].(string)
	wait, w := legacy["waitForAll"].(bool)
	mediaControllers, m := "host", true
	if version == 3 {
		mediaControllers, m = legacy["mediaControllers"].(string)
	}
	if !c || !m || !w || (controllers != "host" && controllers != "everyone") || (mediaControllers != "host" && mediaControllers != "everyone") {
		return contracts.RoomSettings{}, contracts.ErrInvalidInput
	}
	return contracts.RoomSettings{EveryoneCanControl: controllers == "everyone", EveryoneCanSelectMedia: mediaControllers == "everyone", WaitForAll: wait}, nil
}

func validRoom(r rooms.Room) error {
	if !contracts.ValidID(r.ID) || !contracts.ValidID(r.HostIdentityID) || !contracts.ValidTitle(r.Title) || len(r.Members) < 1 || len(r.Members) > 32 {
		return fmt.Errorf("invalid stored room")
	}
	b, _ := json.Marshal(r.Settings)
	if _, err := contracts.DecodeRoomSettings(b); err != nil {
		return fmt.Errorf("invalid stored settings")
	}
	host := false
	for _, m := range r.Members {
		if !contracts.ValidID(m.ID) || !contracts.ValidID(m.IdentityID) {
			return fmt.Errorf("invalid stored member")
		}
		host = host || m.IdentityID == r.HostIdentityID
	}
	if !host {
		return fmt.Errorf("missing host membership")
	}
	hash, ok := contracts.SecretHash(r.Invite.LinkSecret, 16)
	code, valid := contracts.NormalizeCode(r.Invite.Code)
	if !ok || !valid || code != r.Invite.Code || hash != r.Invite.LinkHash || contracts.Hash([]byte(code)) != r.Invite.CodeHash {
		return fmt.Errorf("invalid stored invitation")
	}
	return nil
}
func settingsJSON(settings contracts.RoomSettings) string {
	b, _ := json.Marshal(struct {
		V     int                    `json:"v"`
		Value contracts.RoomSettings `json:"value"`
	}{4, settings})
	return string(b)
}
func (t roomTx) InsertRoom(r rooms.Room) error {
	if err := validRoom(r); err != nil {
		return err
	}
	if _, err := t.tx.ExecContext(t.ctx, `INSERT INTO rooms(id,host_identity_id,title,settings,created_at_ms) VALUES(?,?,?,?,?)`, r.ID, r.HostIdentityID, r.Title, settingsJSON(r.Settings), r.CreatedAtMs); err != nil {
		return err
	}
	for _, m := range r.Members {
		if err := t.AddMember(r.ID, m); err != nil {
			return err
		}
	}
	return t.ResetInvitation(r.ID, r.Invite)
}
func (t roomTx) UpdateSettings(id string, settings contracts.RoomSettings) error {
	_, err := t.tx.ExecContext(t.ctx, `UPDATE rooms SET settings=? WHERE id=?`, settingsJSON(settings), id)
	return err
}
func (t roomTx) AddMember(id string, m rooms.Member) error {
	_, err := t.tx.ExecContext(t.ctx, `INSERT INTO room_members VALUES(?,?,?,?)`, id, m.IdentityID, m.ID, m.JoinedAtMs)
	return err
}
func (t roomTx) ResetInvitation(id string, i rooms.InvitationRecord) error {
	_, err := t.tx.ExecContext(t.ctx, `INSERT INTO room_invitations(room_id,generation,link_hash,code_hash,link_secret,code) VALUES(?,?,?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET generation=excluded.generation,link_hash=excluded.link_hash,code_hash=excluded.code_hash,link_secret=excluded.link_secret,code=excluded.code`, id, i.Generation, i.LinkHash, i.CodeHash, i.LinkSecret, i.Code)
	return err
}
func (t roomTx) RemoveMember(id, mid string) error {
	_, err := t.tx.ExecContext(t.ctx, `DELETE FROM room_members WHERE room_id=? AND member_id=?`, id, mid)
	return err
}
func (t roomTx) SelectMedia(id string, m contracts.MediaDescriptor) error {
	b, _ := json.Marshal(struct {
		V     int                       `json:"v"`
		Value contracts.MediaDescriptor `json:"value"`
	}{1, m})
	_, err := t.tx.ExecContext(t.ctx, `INSERT INTO room_media(room_id,descriptor) VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET descriptor=excluded.descriptor`, id, string(b))
	return err
}
func (t roomTx) DeleteRoom(id string) error {
	_, err := t.tx.ExecContext(t.ctx, `DELETE FROM rooms WHERE id=?`, id)
	return err
}
