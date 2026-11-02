package identity

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"io"
	"sync"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
)

// Session contains authenticated server-side state. Never serialize it directly.
type Session struct {
	IdentityID, DisplayName, TokenHash, CSRF string
	CreatedAtMs, RenewedAtMs, ExpiresAtMs    int64
}

// Repository owns atomic identity persistence.
type Repository interface {
	LoadSessions(context.Context, int64) ([]Session, error)
	CreateSession(context.Context, Session) error
	RenewSession(context.Context, string, int64, int64) error
	Rename(context.Context, string, string, int64) error
	Revoke(context.Context, string, int64) error
	CleanupSessions(context.Context, int64) error
}

// Service owns identity use cases and session revocation notification.
type Service struct {
	Repository Repository
	Now        func() time.Time
	Random     io.Reader
	OnRevoked  func(tokenHash string)
	OnRenamed  func(identityID, name string)
	once       sync.Once
	initErr    error
	mu         sync.RWMutex
	sessions   map[string]*ownedSession
}

type ownedSession struct {
	mu    sync.Mutex
	value Session
}

// Initialize loads all unexpired credentials before process readiness.
func (s *Service) Initialize(ctx context.Context) error {
	s.once.Do(func() {
		entries, err := s.Repository.LoadSessions(ctx, s.Now().UnixMilli())
		s.initErr = err
		s.sessions = make(map[string]*ownedSession, len(entries))
		for _, p := range entries {
			s.sessions[p.TokenHash] = &ownedSession{value: p}
		}
	})
	return s.initErr
}
func (s *Service) lookup(ctx context.Context, hash string) (*ownedSession, error) {
	if err := s.Initialize(ctx); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	entry := s.sessions[hash]
	if entry == nil || entry.value.ExpiresAtMs <= s.Now().UnixMilli() {
		return nil, contracts.Failure("session_required")
	}
	return entry, nil
}

// Validate checks current expiry and revocation in application memory.
func (s *Service) Validate(p Session) error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	entry := s.sessions[p.TokenHash]
	if entry == nil || entry.value.IdentityID != p.IdentityID || entry.value.ExpiresAtMs <= s.Now().UnixMilli() {
		return contracts.Failure("session_required")
	}
	return nil
}

// Authenticate resolves only a canonical bearer token against application memory.
func (s *Service) Authenticate(ctx context.Context, token string) (Session, error) {
	hash, ok := contracts.SecretHash(token, 32)
	if !ok {
		return Session{}, contracts.Failure("session_required")
	}
	entry, err := s.lookup(ctx, hash)
	if err != nil {
		return Session{}, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.sessions[hash] != entry || entry.value.ExpiresAtMs <= s.Now().UnixMilli() {
		return Session{}, contracts.Failure("session_required")
	}
	return entry.value, nil
}

// Bootstrap resumes a valid session or creates an independent anonymous identity.
func (s *Service) Bootstrap(ctx context.Context, token string) (Session, string, bool, error) {
	if err := s.Initialize(ctx); err != nil {
		return Session{}, "", false, err
	}
	session, err := s.Authenticate(ctx, token)
	if err == nil {
		entry, err := s.lookup(ctx, session.TokenHash)
		if err != nil {
			return Session{}, "", false, err
		}
		entry.mu.Lock()
		defer entry.mu.Unlock()
		s.mu.RLock()
		session = entry.value
		s.mu.RUnlock()
		if err := s.Validate(session); err != nil {
			return Session{}, "", false, err
		}
		now := s.Now().UnixMilli()
		if now-session.RenewedAtMs < int64(24*time.Hour/time.Millisecond) {
			return session, token, false, nil
		}
		expires := s.Now().Add(365 * 24 * time.Hour).UnixMilli()
		if err := s.Repository.RenewSession(ctx, session.TokenHash, now, expires); err != nil {
			return Session{}, "", false, err
		}
		session.RenewedAtMs, session.ExpiresAtMs = now, expires
		s.mu.Lock()
		entry.value = session
		s.mu.Unlock()
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
	s.mu.Lock()
	s.sessions[session.TokenHash] = &ownedSession{value: session}
	s.mu.Unlock()
	return session, token, true, nil
}

// CheckCSRF compares the session-bound token without accepting an empty value.
func CheckCSRF(session Session, token string) bool {
	return len(token) == 43 && subtle.ConstantTimeCompare([]byte(session.CSRF), []byte(token)) == 1
}

// Forget revokes credentials before notifying connection owners.
func (s *Service) Forget(ctx context.Context, session Session) error {
	entry, err := s.lookup(ctx, session.TokenHash)
	if err != nil {
		return err
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := s.Validate(session); err != nil {
		return err
	}
	if err := s.Repository.Revoke(ctx, session.TokenHash, s.Now().UnixMilli()); err != nil {
		return err
	}
	s.mu.Lock()
	delete(s.sessions, session.TokenHash)
	s.mu.Unlock()
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
	entry, err := s.lookup(ctx, session.TokenHash)
	if err != nil {
		return Session{}, err
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if err := s.Validate(session); err != nil {
		return Session{}, err
	}
	if err := s.Repository.Rename(ctx, session.TokenHash, patch.DisplayName, s.Now().UnixMilli()); err != nil {
		return Session{}, err
	}
	s.mu.Lock()
	session = entry.value
	session.DisplayName = patch.DisplayName
	entry.value = session
	s.mu.Unlock()
	if s.OnRenamed != nil {
		s.OnRenamed(session.IdentityID, patch.DisplayName)
	}
	return session, nil
}

// RunCleanup owns bounded, low-frequency removal of expired credentials until cancellation.
func (s *Service) RunCleanup(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			now := s.Now().UnixMilli()
			if err := s.Repository.CleanupSessions(ctx, now); err != nil {
				continue
			}
			s.mu.Lock()
			n := 0
			for hash, entry := range s.sessions {
				if entry.value.ExpiresAtMs <= now {
					delete(s.sessions, hash)
					n++
					if n >= 256 {
						break
					}
				}
			}
			s.mu.Unlock()
		}
	}
}
