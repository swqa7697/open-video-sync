package rooms

import (
	"context"
	"io"
	"time"

	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/identity"
)

// Limits bounds owned resources. Queue sizes and the five-second deadline are protocol constants.
type Limits struct {
	MaxActive, MaxStored, MaxOwned, MaxMembers int
	CoordinatorIdle                            time.Duration
}

// DefaultLimits provides resource controls, not a capacity guarantee.
func DefaultLimits() Limits { return Limits{100, 1000, 20, 32, time.Minute} }

// Valid checks operator limits against the wire roster bound.
func (l Limits) Valid() bool {
	return l.MaxActive > 0 && l.MaxActive <= 1000 && l.MaxStored > 0 && l.MaxStored <= 100000 && l.MaxOwned > 0 && l.MaxOwned <= l.MaxStored && l.MaxMembers > 0 && l.MaxMembers <= 32 && l.CoordinatorIdle > 0
}

// Member keeps identity ownership private to the server.
type Member struct {
	ID, IdentityID, DisplayName string
	JoinedAtMs                  int64
}

// Room combines persistent metadata with epoch-scoped runtime counters. Storage never writes runtime fields.
type Room struct {
	ID, Title, HostIdentityID string
	Revision, CreatedAtMs     int64
	Settings                  contracts.RoomSettings
	Members                   []Member
	Media                     *contracts.MediaDescriptor
	Invite                    InvitationRecord
}

// InvitationRecord keeps private sharing values and indexed verifiers. Legacy records have hashes and expiry only.
type InvitationRecord struct {
	Generation, ExpiresAtMs int64
	LinkHash, CodeHash      string
	LinkSecret, Code        string
}

// Invitation contains newly generated secrets; never put it in snapshots or logs.
type Invitation struct {
	LinkSecret string `json:"linkSecret"`
	Code       string `json:"code"`
}

// Outcome retains nonsecret request recovery for at most sixty seconds.
type Outcome struct {
	Digest, RoomID string
	ExpiresAtMs    int64
}

// Tx exposes record-specific durable operations. Playback has no persistence method.
type Tx interface {
	InsertRoom(Room) error
	UpdateSettings(string, contracts.RoomSettings) error
	AddMember(string, Member) error
	ResetInvitation(string, InvitationRecord) error
	RemoveMember(string, string) error
	SelectMedia(string, contracts.MediaDescriptor) error
	DeleteRoom(string) error
}

// Repository loads metadata once at startup and commits low-frequency changes.
type Repository interface {
	LoadRooms(context.Context) ([]Room, error)
	Transact(context.Context, func(Tx) error) error
}

// Summary is an authorized list entry.
type Summary struct {
	RoomID string `json:"roomId"`
	Title  string `json:"title"`
	Role   string `json:"role"`
}

// RosterMember excludes identity IDs and all credentials.
type RosterMember struct {
	MemberID    string               `json:"memberId"`
	DisplayName string               `json:"displayName"`
	Role        string               `json:"role"`
	Presence    string               `json:"presence"`
	Readiness   *contracts.Readiness `json:"readiness"`
}

// Playback anchors the authoritative timeline in this process clock domain.
type Playback struct {
	Phase          string `json:"phase"`
	PositionMs     int64  `json:"positionMs"`
	AnchorServerMs int64  `json:"anchorServerMs"`
	DesiredPlaying bool   `json:"desiredPlaying"`
}

// Snapshot is a credential-free, caller-specific v2 room snapshot.
type Snapshot struct {
	RoomID          string                     `json:"roomId"`
	Title           string                     `json:"title"`
	Epoch           string                     `json:"epoch"`
	Revision        int64                      `json:"revision"`
	MediaGeneration int64                      `json:"mediaGeneration"`
	HostMemberID    string                     `json:"hostMemberId"`
	SelfMemberID    string                     `json:"selfMemberId"`
	Settings        contracts.RoomSettings     `json:"settings"`
	Media           *contracts.MediaDescriptor `json:"media"`
	Playback        Playback                   `json:"playback"`
	Barrier         *Barrier                   `json:"barrier"`
	Members         []RosterMember             `json:"members"`
	ServerNowMs     int64                      `json:"serverNowMs"`
}

// Result is a create/redeem or management response.
type Result struct {
	Snapshot   Snapshot    `json:"snapshot"`
	Invitation *Invitation `json:"invitation"`
	Replayed   bool        `json:"replayed"`
}

// Receipt acknowledges committed removal or closure after access ends.
type Receipt struct {
	RoomID          string `json:"roomId"`
	Revision        int64  `json:"revision"`
	RemovedMemberID string `json:"removedMemberId,omitempty"`
	Closed          bool   `json:"closed,omitempty"`
}

// Mutation carries common management preconditions and the selected operation.
type Mutation struct {
	Epoch            string
	ExpectedRevision int64
	Operation        string
	Settings         contracts.RoomSettings
	MemberID         string
}

func member(r Room, identityID string) (Member, bool) {
	for _, m := range r.Members {
		if m.IdentityID == identityID {
			return m, true
		}
	}
	return Member{}, false
}
func authorize(r Room, p identity.Session, host bool) error {
	if _, ok := member(r, p.IdentityID); !ok {
		return contracts.Failure("not_found")
	}
	if host && r.HostIdentityID != p.IdentityID {
		return contracts.Failure("forbidden")
	}
	return nil
}
func snapshot(r Room, epoch string, now int64, identityID string) Snapshot {
	s := Snapshot{RoomID: r.ID, Title: r.Title, Epoch: epoch, Revision: r.Revision, Settings: r.Settings, Playback: Playback{Phase: "empty"}, Members: make([]RosterMember, 0, len(r.Members)), ServerNowMs: now}
	for _, m := range r.Members {
		if m.IdentityID == identityID {
			s.SelfMemberID = m.ID
		}
		role := "participant"
		if m.IdentityID == r.HostIdentityID {
			role = "host"
			s.HostMemberID = m.ID
		}
		name := m.DisplayName
		if name == "" {
			name = "Guest " + m.ID[:6]
		}
		s.Members = append(s.Members, RosterMember{MemberID: m.ID, DisplayName: name, Role: role, Presence: "offline"})
	}
	return s
}
func invitation(random io.Reader, generation, now int64) (Invitation, InvitationRecord, error) {
	secret, err := contracts.RandomSecret(random, 16)
	if err != nil {
		return Invitation{}, InvitationRecord{}, err
	}
	b := make([]byte, 16)
	if _, err := io.ReadFull(random, b); err != nil {
		return Invitation{}, InvitationRecord{}, err
	}
	alphabet := "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
	for i := range b {
		b[i] = alphabet[b[i]&31]
	}
	hash, _ := contracts.SecretHash(secret, 16)
	return Invitation{secret, string(b)}, InvitationRecord{Generation: generation, LinkHash: hash, CodeHash: contracts.Hash(b), LinkSecret: secret, Code: string(b)}, nil
}
