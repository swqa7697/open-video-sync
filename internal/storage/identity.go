package storage

import (
	"context"
	"database/sql"

	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/identity"
)

// LoadSessions loads unexpired sessions once before admission.
func (s *Store) LoadSessions(ctx context.Context, now int64) ([]identity.Session, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT i.id,i.display_name,s.token_hash,s.csrf_secret,s.created_at_ms,s.renewed_at_ms,s.expires_at_ms FROM sessions s JOIN identities i ON i.id=s.identity_id WHERE s.expires_at_ms>?`, now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []identity.Session{}
	for rows.Next() {
		var p identity.Session
		if err := rows.Scan(&p.IdentityID, &p.DisplayName, &p.TokenHash, &p.CSRF, &p.CreatedAtMs, &p.RenewedAtMs, &p.ExpiresAtMs); err != nil {
			return nil, err
		}
		result = append(result, p)
	}
	return result, rows.Err()
}

// CreateSession persists identity and credential verifier atomically.
func (s *Store) CreateSession(ctx context.Context, session identity.Session) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO identities(id,created_at_ms) VALUES(?,?)`, session.IdentityID, session.CreatedAtMs); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO sessions VALUES(?,?,?,?,?,?)`, session.TokenHash, session.IdentityID, session.CSRF, session.CreatedAtMs, session.RenewedAtMs, session.ExpiresAtMs)
		return err
	})
}

// RenewSession advances rolling expiry at most once daily, even across concurrent requests.
func (s *Store) RenewSession(ctx context.Context, hash string, now, expires int64) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		result, err := tx.ExecContext(ctx, `UPDATE sessions SET renewed_at_ms=?,expires_at_ms=? WHERE token_hash=? AND expires_at_ms>? AND renewed_at_ms<=?`, now, expires, hash, now, now-86400000)
		if err != nil {
			return err
		}
		if n, _ := result.RowsAffected(); n == 0 {
			var count int
			if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM sessions WHERE token_hash=? AND expires_at_ms>?`, hash, now).Scan(&count); err != nil {
				return err
			}
			if count == 0 {
				return contracts.Failure("session_required")
			}
		}
		return nil
	})
}

// Rename checks session validity again inside the mutation transaction.
func (s *Store) Rename(ctx context.Context, hash, name string, now int64) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		r, err := tx.ExecContext(ctx, `UPDATE identities SET display_name=? WHERE id=(SELECT identity_id FROM sessions WHERE token_hash=? AND expires_at_ms>?)`, name, hash, now)
		if err != nil {
			return err
		}
		if n, _ := r.RowsAffected(); n == 0 {
			return contracts.Failure("session_required")
		}
		return nil
	})
}

// Revoke removes a session without transferring any owned room.
func (s *Store) Revoke(ctx context.Context, hash string, now int64) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		r, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash=? AND expires_at_ms>?`, hash, now)
		if err != nil {
			return err
		}
		if n, _ := r.RowsAffected(); n == 0 {
			return contracts.Failure("session_required")
		}
		return nil
	})
}

// CleanupSessions removes a bounded batch of expired credentials on explicit maintenance.
func (s *Store) CleanupSessions(ctx context.Context, now int64) error {
	return s.write(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM sessions WHERE expires_at_ms<=? LIMIT 256)`, now)
		return err
	})
}
