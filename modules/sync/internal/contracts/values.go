package contracts

import (
	"encoding/json"
	"regexp"
	"unicode"
	"unicode/utf8"
)

const (
	// MaxSafeInteger is the largest exact integer supported by JavaScript.
	MaxSafeInteger int64 = 1<<53 - 1
	// MaxDurationMs bounds a selected video's duration to seven days.
	MaxDurationMs int64 = 7 * 24 * 60 * 60 * 1000
	// MaxFileBytes bounds matching metadata, not an upload allowance (16 TiB).
	MaxFileBytes int64 = 16 << 40
)

var (
	digestPattern  = regexp.MustCompile(`^[a-f0-9]{64}$`)
	bvidPattern    = regexp.MustCompile(`^BV[1-9A-HJ-NP-Za-km-z]{10}$`)
	cidPattern     = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)
	episodePattern = regexp.MustCompile(`^[1-9][0-9]{0,14}$`)
)

// ProfilePatch replaces the optional name; an empty string clears it.
type ProfilePatch struct {
	DisplayName string `json:"displayName"`
}

// RoomSettings contains the room's host-managed preferences.
type RoomSettings struct {
	EveryoneCanControl     bool `json:"everyoneCanControl"`
	EveryoneCanSelectMedia bool `json:"everyoneCanSelectMedia"`
	WaitForAll             bool `json:"waitForAll"`
}

// MediaDescriptor contains only allowlisted matching metadata. Kind determines
// which fields are present; DecodeMedia rejects fields from the other variant.
// A label is optional and user-entered, never derived from a local filename.
type MediaDescriptor struct {
	Kind               string `json:"kind"`
	FingerprintVersion int64  `json:"fingerprintVersion,omitempty"`
	Digest             string `json:"digest,omitempty"`
	SizeBytes          int64  `json:"sizeBytes,omitempty"`
	DurationMs         int64  `json:"durationMs"`
	Label              string `json:"label,omitempty"`
	BVID               string `json:"bvid,omitempty"`
	CID                string `json:"cid,omitempty"`
	Part               int64  `json:"part,omitempty"`
	EpisodeID          string `json:"episodeId,omitempty"`
}

// DecodeProfilePatch validates an exact profile mutation body.
func DecodeProfilePatch(data []byte) (ProfilePatch, error) {
	object, err := DecodeObject(data)
	if err != nil {
		return ProfilePatch{}, err
	}
	name, ok := object["displayName"].(string)
	if !shape(object, "displayName") || !ok || !boundedText(name, 48, 192) {
		return ProfilePatch{}, ErrInvalidInput
	}
	return ProfilePatch{DisplayName: name}, nil
}

// DecodeRoomSettings validates complete settings, including relational bounds.
func DecodeRoomSettings(data []byte) (RoomSettings, error) {
	object, err := DecodeObject(data)
	if err != nil {
		return RoomSettings{}, err
	}
	if !shape(object, "everyoneCanControl", "everyoneCanSelectMedia", "waitForAll") {
		return RoomSettings{}, ErrInvalidInput
	}
	controls, c := object["everyoneCanControl"].(bool)
	selectMedia, m := object["everyoneCanSelectMedia"].(bool)
	wait, w := object["waitForAll"].(bool)
	if !c || !m || !w {
		return RoomSettings{}, ErrInvalidInput
	}
	return RoomSettings{EveryoneCanControl: controls, EveryoneCanSelectMedia: selectMedia, WaitForAll: wait}, nil
}

// DecodeMedia validates a local or Bilibili stable descriptor.
// Bilibili syntax validation establishes neither access nor player support.
func DecodeMedia(data []byte) (MediaDescriptor, error) {
	object, err := DecodeObject(data)
	if err != nil {
		return MediaDescriptor{}, err
	}
	kind, _ := object["kind"].(string)
	duration, validDuration := integer(object["durationMs"], 1, MaxDurationMs)
	if !validDuration {
		return MediaDescriptor{}, ErrInvalidInput
	}
	media := MediaDescriptor{Kind: kind, DurationMs: duration}
	switch kind {
	case "local":
		fields := []string{"kind", "fingerprintVersion", "digest", "sizeBytes", "durationMs"}
		if label, exists := object["label"]; exists {
			text, ok := label.(string)
			if !ok || !boundedText(text, 120, 480) {
				return MediaDescriptor{}, ErrInvalidInput
			}
			media.Label = text
			fields = append(fields, "label")
		}
		version, v := integer(object["fingerprintVersion"], 1, 1)
		size, s := integer(object["sizeBytes"], 1, MaxFileBytes)
		digest, d := object["digest"].(string)
		if !shape(object, fields...) || !v || !s || !d || !digestPattern.MatchString(digest) {
			return MediaDescriptor{}, ErrInvalidInput
		}
		media.FingerprintVersion, media.SizeBytes, media.Digest = version, size, digest
	case "bilibili":
		fields := []string{"kind", "bvid", "cid", "part", "durationMs"}
		if episode, exists := object["episodeId"]; exists {
			id, ok := episode.(string)
			if !ok || !episodePattern.MatchString(id) {
				return MediaDescriptor{}, ErrInvalidInput
			}
			media.EpisodeID = id
			fields = append(fields, "episodeId")
		}
		bvid, b := object["bvid"].(string)
		cid, c := object["cid"].(string)
		part, p := integer(object["part"], 1, 10000)
		if !shape(object, fields...) || !b || !c || !p || !bvidPattern.MatchString(bvid) || !cidPattern.MatchString(cid) || (media.EpisodeID != "" && part != 1) {
			return MediaDescriptor{}, ErrInvalidInput
		}
		media.BVID, media.CID, media.Part = bvid, cid, part
	default:
		return MediaDescriptor{}, ErrInvalidInput
	}
	return media, nil
}

func shape(object map[string]any, fields ...string) bool {
	if len(object) != len(fields) {
		return false
	}
	for _, field := range fields {
		if _, exists := object[field]; !exists {
			return false
		}
	}
	return true
}

func choice(value any, options ...string) (string, bool) {
	text, ok := value.(string)
	if ok {
		for _, option := range options {
			if text == option {
				return text, true
			}
		}
	}
	return "", false
}

func integer(value any, minimum, maximum int64) (int64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	// Version 1 uses integer literals, without fractions or exponent notation.
	n, err := number.Int64()
	return n, err == nil && n >= minimum && n <= maximum && n <= MaxSafeInteger
}

func boundedText(value string, codepoints, bytes int) bool {
	if !utf8.ValidString(value) || len(value) > bytes || utf8.RuneCountInString(value) > codepoints {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}
