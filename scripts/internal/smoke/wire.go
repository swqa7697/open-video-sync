package smoke

// These client-owned views contain only fields used by application smoke checks.
// specs/WIRE.md defines the public contract; server domain types stay private.

// MaxMessageBytes is the version-1 HTTP and WebSocket JSON size limit.
const MaxMessageBytes = 64 << 10

// Snapshot contains the room state observed by smoke checks.
type Snapshot struct {
	RoomID          string `json:"roomId"`
	Title           string `json:"title"`
	Epoch           string `json:"epoch"`
	Revision        int64  `json:"revision"`
	MediaGeneration int64  `json:"mediaGeneration"`
	HostMemberID    string `json:"hostMemberId"`
	SelfMemberID    string `json:"selfMemberId"`
	Settings        struct {
		EveryoneCanControl     bool `json:"everyoneCanControl"`
		EveryoneCanSelectMedia bool `json:"everyoneCanSelectMedia"`
		WaitForAll             bool `json:"waitForAll"`
	} `json:"settings"`
	Playback struct {
		Phase      string `json:"phase"`
		PositionMs int64  `json:"positionMs"`
	} `json:"playback"`
	// Smoke checks inspect presence only for media and waiting barriers.
	Media   *struct{} `json:"media"`
	Barrier *struct{} `json:"barrier"`
	Members []struct {
		MemberID    string `json:"memberId"`
		DisplayName string `json:"displayName"`
	} `json:"members"`
}

// Invitation contains synthetic smoke-test credentials. Never log these fields.
type Invitation struct {
	LinkSecret string `json:"linkSecret"`
	Code       string `json:"code"`
}

// RoomResult is the create-room or redeem-invitation response used by checks.
type RoomResult struct {
	Snapshot   Snapshot    `json:"snapshot"`
	Invitation *Invitation `json:"invitation"`
}

// CommandResult identifies the command and whether the server accepted it.
type CommandResult struct {
	CommandID string `json:"commandId"`
	Accepted  bool   `json:"accepted"`
}
