package storage

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/history"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
)

// LoadHistory reads bounded personal history and preferences once at startup.
func (s *Store) LoadHistory(ctx context.Context) ([]history.State, error) {
	states := map[string]*history.State{}
	get := func(id string) *history.State {
		state := states[id]
		if state == nil {
			state = &history.State{IdentityID: id, Entries: []history.Entry{}, RecordingEnabled: true}
			states[id] = state
		}
		return state
	}
	rows, err := s.db.QueryContext(ctx, `SELECT identity_id,recording_enabled FROM watch_history_preferences`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id string
		var enabled bool
		if err := rows.Scan(&id, &enabled); err != nil {
			rows.Close()
			return nil, err
		}
		get(id).RecordingEnabled = enabled
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	rows, err = s.db.QueryContext(ctx, `SELECT identity_id,entry_id,video,last_played_at_ms FROM watch_history ORDER BY identity_id,last_played_at_ms DESC,entry_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, raw string
		var entry history.Entry
		if err := rows.Scan(&id, &entry.EntryID, &raw, &entry.LastPlayedAtMs); err != nil {
			return nil, err
		}
		entry.Video, err = contracts.DecodeHistoryVideo([]byte(raw))
		if err != nil {
			return nil, fmt.Errorf("invalid stored history video")
		}
		state := get(id)
		if !contracts.ValidID(entry.EntryID) || entry.EntryID != history.VideoID(entry.Video) || entry.LastPlayedAtMs < 0 || len(state.Entries) >= history.Limit {
			return nil, fmt.Errorf("invalid stored history")
		}
		state.Entries = append(state.Entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	result := make([]history.State, 0, len(states))
	for _, state := range states {
		result = append(result, *state)
	}
	return result, nil
}

func validHistorySession(ctx context.Context, tx *sql.Tx, p identity.Session, now int64) error {
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sessions WHERE token_hash=? AND identity_id=? AND expires_at_ms>?)`, p.TokenHash, p.IdentityID, now).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return contracts.Failure("session_required")
	}
	return nil
}

// RecordHistory upserts and trims one identity atomically.
func (s *Store) RecordHistory(ctx context.Context, p identity.Session, entry history.Entry, now int64) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		if err := validHistorySession(ctx, tx, p, now); err != nil {
			return err
		}
		video, err := json.Marshal(entry.Video)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO watch_history(identity_id,entry_id,video,last_played_at_ms) VALUES(?,?,?,?) ON CONFLICT(identity_id,entry_id) DO UPDATE SET video=excluded.video,last_played_at_ms=excluded.last_played_at_ms`, p.IdentityID, entry.EntryID, string(video), entry.LastPlayedAtMs); err != nil {
			return err
		}
		_, err = tx.ExecContext(ctx, `DELETE FROM watch_history WHERE identity_id=? AND entry_id IN (SELECT entry_id FROM watch_history WHERE identity_id=? ORDER BY last_played_at_ms DESC,entry_id LIMIT -1 OFFSET ?)`, p.IdentityID, p.IdentityID, history.Limit)
		return err
	})
}

// DeleteHistory removes only the authenticated identity's entry.
func (s *Store) DeleteHistory(ctx context.Context, p identity.Session, id string, now int64) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		if err := validHistorySession(ctx, tx, p, now); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM watch_history WHERE identity_id=? AND entry_id=?`, p.IdentityID, id)
		return err
	})
}

// ClearHistory leaves other identities and the recording preference unchanged.
func (s *Store) ClearHistory(ctx context.Context, p identity.Session, now int64) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		if err := validHistorySession(ctx, tx, p, now); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM watch_history WHERE identity_id=?`, p.IdentityID)
		return err
	})
}

// SetHistoryRecording updates only the caller's persistent recording preference.
func (s *Store) SetHistoryRecording(ctx context.Context, p identity.Session, enabled bool, now int64) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		if err := validHistorySession(ctx, tx, p, now); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO watch_history_preferences(identity_id,recording_enabled) VALUES(?,?) ON CONFLICT(identity_id) DO UPDATE SET recording_enabled=excluded.recording_enabled`, p.IdentityID, enabled)
		return err
	})
}
