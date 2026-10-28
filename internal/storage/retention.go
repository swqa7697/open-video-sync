package storage

import (
	"context"
	"database/sql"
)

// CleanupRetention bounds each transaction to at most 100 rows per record class.
func (s *Store) CleanupRetention(ctx context.Context, now int64) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		for _, query := range []string{
			`DELETE FROM command_results WHERE rowid IN (SELECT rowid FROM command_results WHERE expires_at_ms<=? LIMIT 100)`,
			`DELETE FROM http_idempotency WHERE rowid IN (SELECT rowid FROM http_idempotency WHERE expires_at_ms<=? LIMIT 100)`,
			`DELETE FROM room_invitations WHERE rowid IN (SELECT rowid FROM room_invitations WHERE expires_at_ms<=? LIMIT 100)`,
			`DELETE FROM sessions WHERE rowid IN (SELECT rowid FROM sessions WHERE expires_at_ms<=? LIMIT 100)`,
		} {
			if _, err := tx.ExecContext(ctx, query, now); err != nil {
				return err
			}
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM identities WHERE id IN (
			SELECT i.id FROM identities i WHERE i.last_seen_at_ms<?
			AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.identity_id=i.id)
			AND NOT EXISTS(SELECT 1 FROM rooms r WHERE r.host_identity_id=i.id)
			AND NOT EXISTS(SELECT 1 FROM room_members m WHERE m.identity_id=i.id)
			AND NOT EXISTS(SELECT 1 FROM http_idempotency h WHERE h.identity_id=i.id)
			AND NOT EXISTS(SELECT 1 FROM command_results c WHERE c.identity_id=i.id) LIMIT 100)`, now-365*86400000)
		return err
	})
}

// ExpiredRooms returns bounded candidates; the room coordinator rechecks inactivity.
func (s *Store) ExpiredRooms(ctx context.Context, cutoff int64) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM rooms WHERE last_active_at_ms<? ORDER BY last_active_at_ms LIMIT 100`, cutoff)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}
