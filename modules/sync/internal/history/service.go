// Package history owns private, identity-scoped online viewing history.
package history

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/modules/sync/internal/identity"
)

// Limit bounds each identity's persisted history.
const Limit = 100

// Entry is one concrete part or episode, with no playback or room state.
type Entry struct {
	EntryID        string                 `json:"entryId"`
	Video          contracts.HistoryVideo `json:"video"`
	LastPlayedAtMs int64                  `json:"lastPlayedAtMs"`
}

// State is an identity's sanitized history and recording preference.
type State struct {
	IdentityID       string  `json:"-"`
	Entries          []Entry `json:"entries"`
	RecordingEnabled bool    `json:"recordingEnabled"`
}

// Repository persists only low-frequency history mutations atomically.
type Repository interface {
	LoadHistory(context.Context) ([]State, error)
	RecordHistory(context.Context, identity.Session, Entry, int64) error
	DeleteHistory(context.Context, identity.Session, string, int64) error
	ClearHistory(context.Context, identity.Session, int64) error
	SetHistoryRecording(context.Context, identity.Session, bool, int64) error
}

type ownedState struct {
	mu    sync.Mutex
	state State
}

// Service serializes each identity independently and serves reads from memory.
type Service struct {
	repository Repository
	now        func() time.Time
	validate   func(identity.Session) error
	mu         sync.Mutex
	states     map[string]*ownedState
}

// New loads persistent history before the application admits requests.
func New(ctx context.Context, repository Repository, now func() time.Time, validate func(identity.Session) error) (*Service, error) {
	states, err := repository.LoadHistory(ctx)
	if err != nil {
		return nil, err
	}
	s := &Service{repository: repository, now: now, validate: validate, states: make(map[string]*ownedState)}
	for _, state := range states {
		s.states[state.IdentityID] = &ownedState{state: state}
	}
	return s, nil
}

func copyState(state State) State {
	state.Entries = append([]Entry{}, state.Entries...)
	return state
}

func (s *Service) withState(p identity.Session, run func(*State) error) (State, error) {
	if err := s.validate(p); err != nil {
		return State{}, err
	}
	s.mu.Lock()
	owned := s.states[p.IdentityID]
	if owned == nil {
		owned = &ownedState{state: State{IdentityID: p.IdentityID, Entries: []Entry{}, RecordingEnabled: true}}
		s.states[p.IdentityID] = owned
	}
	s.mu.Unlock()
	owned.mu.Lock()
	defer owned.mu.Unlock()
	if err := s.validate(p); err != nil {
		return State{}, err
	}
	if err := run(&owned.state); err != nil {
		return State{}, err
	}
	return copyState(owned.state), nil
}

// List returns a detached snapshot without storage access.
func (s *Service) List(p identity.Session) (State, error) {
	return s.withState(p, func(*State) error { return nil })
}

// VideoID gives EP precedence and otherwise identifies an exact BV part.
func VideoID(v contracts.HistoryVideo) string {
	key := "bilibili:bv:" + v.BVID + ":" + strconv.FormatInt(v.Part, 10)
	if v.EpisodeID != "" {
		key = "bilibili:ep:" + v.EpisodeID
	}
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:16])
}

// Record updates a watched video once; disabled recording is a successful no-op.
func (s *Service) Record(ctx context.Context, p identity.Session, video contracts.HistoryVideo) (State, error) {
	b, err := json.Marshal(video)
	if err != nil {
		return State{}, err
	}
	if _, err := contracts.DecodeHistoryVideo(b); err != nil {
		return State{}, contracts.Failure("invalid_input")
	}
	return s.withState(p, func(state *State) error {
		if !state.RecordingEnabled {
			return nil
		}
		now := s.now().UnixMilli()
		entry := Entry{EntryID: VideoID(video), Video: video, LastPlayedAtMs: now}
		if len(state.Entries) > 0 {
			entry.LastPlayedAtMs = max(now, state.Entries[0].LastPlayedAtMs+1)
		}
		if err := s.repository.RecordHistory(ctx, p, entry, now); err != nil {
			return err
		}
		entries := []Entry{entry}
		for _, old := range state.Entries {
			if old.EntryID != entry.EntryID {
				entries = append(entries, old)
			}
		}
		sort.Slice(entries, func(i, j int) bool { return entries[i].LastPlayedAtMs > entries[j].LastPlayedAtMs })
		state.Entries = entries[:min(len(entries), Limit)]
		return nil
	})
}

// Delete removes one of the caller's entries without affecting playback.
func (s *Service) Delete(ctx context.Context, p identity.Session, id string) (State, error) {
	if !contracts.ValidID(id) {
		return State{}, contracts.Failure("invalid_input")
	}
	return s.withState(p, func(state *State) error {
		if err := s.repository.DeleteHistory(ctx, p, id, s.now().UnixMilli()); err != nil {
			return err
		}
		entries := make([]Entry, 0, len(state.Entries))
		for _, entry := range state.Entries {
			if entry.EntryID != id {
				entries = append(entries, entry)
			}
		}
		state.Entries = entries
		return nil
	})
}

// Clear removes the caller's history while retaining the recording preference.
func (s *Service) Clear(ctx context.Context, p identity.Session) (State, error) {
	return s.withState(p, func(state *State) error {
		if err := s.repository.ClearHistory(ctx, p, s.now().UnixMilli()); err != nil {
			return err
		}
		state.Entries = []Entry{}
		return nil
	})
}

// SetRecording persists the identity's explicit recording preference.
func (s *Service) SetRecording(ctx context.Context, p identity.Session, enabled bool) (State, error) {
	return s.withState(p, func(state *State) error {
		if state.RecordingEnabled == enabled {
			return nil
		}
		if err := s.repository.SetHistoryRecording(ctx, p, enabled, s.now().UnixMilli()); err != nil {
			return err
		}
		state.RecordingEnabled = enabled
		return nil
	})
}
