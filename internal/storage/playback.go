package storage

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/rooms"
)

func (t roomTx) loadPlayback(r *rooms.Room) error {
	var descriptor string
	err := t.tx.QueryRowContext(t.ctx, `SELECT generation,descriptor FROM room_media WHERE room_id=?`, r.ID).Scan(&r.MediaGeneration, &descriptor)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	o, err := contracts.DecodeObject([]byte(descriptor))
	if err != nil || len(o) != 2 || o["v"] != json.Number("1") {
		return fmt.Errorf("invalid stored media version")
	}
	b, _ := json.Marshal(o["value"])
	m, err := contracts.DecodeMedia(b)
	if err != nil {
		return fmt.Errorf("invalid stored media")
	}
	r.Media = &m
	err = t.tx.QueryRowContext(t.ctx, `SELECT position_ms,phase FROM playback_checkpoints WHERE room_id=?`, r.ID).Scan(&r.Playback.PositionMs, &r.Playback.Phase)
	if err != nil {
		return err
	}
	if r.Playback.PositionMs > m.DurationMs {
		return fmt.Errorf("invalid stored position")
	}
	return nil
}
func (t roomTx) SavePlayback(r rooms.Room, now int64) error {
	if r.Media == nil {
		return nil
	}
	b, _ := json.Marshal(map[string]any{"v": 1, "value": r.Media})
	check, _ := json.Marshal(r.Media)
	if _, err := contracts.DecodeMedia(check); err != nil {
		return err
	}
	if r.MediaGeneration < 1 || r.MediaGeneration > contracts.MaxSafeInteger || r.Playback.PositionMs < 0 || r.Playback.PositionMs > r.Media.DurationMs {
		return fmt.Errorf("invalid playback checkpoint")
	}
	if _, err := t.tx.ExecContext(t.ctx, `INSERT INTO room_media VALUES(?,?,?) ON CONFLICT(room_id) DO UPDATE SET generation=excluded.generation,descriptor=excluded.descriptor`, r.ID, r.MediaGeneration, string(b)); err != nil {
		return err
	}
	_, err := t.tx.ExecContext(t.ctx, `INSERT INTO playback_checkpoints VALUES(?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET position_ms=excluded.position_ms,phase=excluded.phase,saved_at_ms=excluded.saved_at_ms`, r.ID, r.Playback.PositionMs, r.Playback.Phase, now)
	return err
}
func (t roomTx) Command(room, id, key string, now int64) (rooms.CommandRecord, bool, error) {
	var r rooms.CommandRecord
	err := t.tx.QueryRowContext(t.ctx, `SELECT epoch,digest,revision,expires_at_ms FROM command_results WHERE room_id=? AND identity_id=? AND command_id=? AND expires_at_ms>?`, room, id, key, now).Scan(&r.Epoch, &r.Digest, &r.Revision, &r.ExpiresAtMs)
	if errors.Is(err, sql.ErrNoRows) {
		return r, false, nil
	}
	return r, err == nil, err
}
func (t roomTx) SaveCommand(room, id, key string, r rooms.CommandRecord) error {
	_, err := t.tx.ExecContext(t.ctx, `DELETE FROM command_results WHERE expires_at_ms<=?`, r.ExpiresAtMs-86400000)
	if err != nil {
		return err
	}
	_, err = t.tx.ExecContext(t.ctx, `INSERT INTO command_results VALUES(?,?,?,?,?,?,?) ON CONFLICT(room_id,identity_id,command_id) DO UPDATE SET epoch=excluded.epoch,digest=excluded.digest,revision=excluded.revision,expires_at_ms=excluded.expires_at_ms`, room, id, key, r.Epoch, r.Digest, r.Revision, r.ExpiresAtMs)
	return err
}
