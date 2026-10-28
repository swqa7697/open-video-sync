package identity

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"time"

	"github.com/swqa7697/open-video-sync/internal/contracts"
)

// Session contains authenticated server-side state. Never serialize it directly.
type Session struct {
	IdentityID, DisplayName, TokenHash, CSRF string
	CreatedAtMs, RenewedAtMs, ExpiresAtMs    int64
}

// Repository owns atomic identity persistence.
type Repository interface {
	FindSession(context.Context, string, int64) (Session, error)
	CreateSession(context.Context, Session) error
	RenewSession(context.Context, string, int64, int64) error
	Rename(context.Context, string, string, int64) error
	Revoke(context.Context, string, int64) error
}

// Service owns identity use cases and session revocation notification.
type Service struct {
	Repository Repository
	Now        func() time.Time
	Random     io.Reader
	OnRevoked  func(tokenHash string)
}

// Authenticate never treats a client-supplied identity ID as a credential.
func (s *Service) Authenticate(ctx context.Context, token string) (Session, error) {
	hash, ok := contracts.SecretHash(token, 32)
	if !ok {
		return Session{}, contracts.Failure("session_required")
	}
	return s.Repository.FindSession(ctx, hash, s.Now().UnixMilli())
}

// Bootstrap resumes a valid session or creates an independent anonymous identity.
func (s *Service) Bootstrap(ctx context.Context, token string) (Session, string, bool, error) {
	session, err := s.Authenticate(ctx, token)
	if err == nil {
		now := s.Now().UnixMilli()
		if now-session.RenewedAtMs < int64(24*time.Hour/time.Millisecond) {
			return session, token, false, nil
		}
		expires := s.Now().Add(365 * 24 * time.Hour).UnixMilli()
		if err := s.Repository.RenewSession(ctx, session.TokenHash, now, expires); err != nil {
			return Session{}, "", false, err
		}
		session.RenewedAtMs, session.ExpiresAtMs = now, expires
		return session, token, true, nil
	}
	if err != contracts.Failure("session_required") {
		return Session{}, "", false, err
	}
	id, err := contracts.RandomID(s.Random)
	if err != nil {
		return Session{}, "", false, err
	}
	token, err = contracts.RandomSecret(s.Random, 32)
	if err != nil {
		return Session{}, "", false, err
	}
	csrf, err := contracts.RandomSecret(s.Random, 32)
	if err != nil {
		return Session{}, "", false, err
	}
	hash, _ := contracts.SecretHash(token, 32)
	now := s.Now()
	session = Session{IdentityID: id, TokenHash: hash, CSRF: csrf, CreatedAtMs: now.UnixMilli(), RenewedAtMs: now.UnixMilli(), ExpiresAtMs: now.Add(365 * 24 * time.Hour).UnixMilli()}
	if err := s.Repository.CreateSession(ctx, session); err != nil {
		return Session{}, "", false, err
	}
	return session, token, true, nil
}

// CheckCSRF compares the session-bound token without accepting an empty value.
func CheckCSRF(session Session, token string) bool {
	return len(token) == 43 && subtle.ConstantTimeCompare([]byte(session.CSRF), []byte(token)) == 1
}

// Forget revokes credentials before notifying connection owners.
func (s *Service) Forget(ctx context.Context, session Session) error {
	if err := s.Repository.Revoke(ctx, session.TokenHash, s.Now().UnixMilli()); err != nil {
		return err
	}
	if s.OnRevoked != nil {
		s.OnRevoked(session.TokenHash)
	}
	return nil
}

// Rename validates the optional profile name before changing persistent state.
func (s *Service) Rename(ctx context.Context, session Session, patch contracts.ProfilePatch) (Session, error) {
	b, err := json.Marshal(patch)
	if err != nil {
		return Session{}, err
	}
	if _, err := contracts.DecodeProfilePatch(b); err != nil {
		return Session{}, contracts.Failure("invalid_input")
	}
	if err := s.Repository.Rename(ctx, session.TokenHash, patch.DisplayName, s.Now().UnixMilli()); err != nil {
		return Session{}, err
	}
	session.DisplayName = patch.DisplayName
	return session, nil
}
