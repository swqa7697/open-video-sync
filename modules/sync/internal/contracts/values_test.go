package contracts

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
)

// These shared cases own metadata compatibility and credential exclusion.
// Existing HTTP/WS tests own routing/origin rules, not unimplemented routes.
func TestSharedWireValues(t *testing.T) {
	data, err := os.ReadFile("../../../../specs/fixtures/wire-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string          `json:"name"`
		Contract string          `json:"contract"`
		Valid    bool            `json:"valid"`
		Input    json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	decode := func(kind string, input []byte) (any, error) {
		switch kind {
		case "profile":
			return DecodeProfilePatch(input)
		case "settings":
			return DecodeRoomSettings(input)
		case "media":
			return DecodeMedia(input)
		default:
			t.Fatalf("unknown fixture contract: %s", kind)
			return nil, nil
		}
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			value, err := decode(tc.Contract, tc.Input)
			if (err == nil) != tc.Valid {
				t.Fatalf("accepted=%v, want %v: %v", err == nil, tc.Valid, err)
			}
			if !tc.Valid {
				if !errors.Is(err, ErrInvalidInput) {
					t.Fatalf("unsafe public error: %v", err)
				}
				return
			}
			encoded, err := json.Marshal(value)
			if err != nil {
				t.Fatal(err)
			}
			original, err := DecodeObject(tc.Input)
			if err != nil {
				t.Fatal(err)
			}
			serialized, err := DecodeObject(encoded)
			if err != nil || !reflect.DeepEqual(original, serialized) {
				t.Fatalf("serialization changed shared values: %v", err)
			}
		})
	}
}

func TestStrictJSONBoundary(t *testing.T) {
	for _, input := range []string{
		`{"displayName":"Guest","displayName":"Host"}`,
		`{"x":{"role":null,"r\u006fle":"host"}}`,
		`{"x":[{"a":1,"a":2}]}`,
		`{} {}`, `[]`, `null`, `{"x":NaN}`, `{"x":1,}`, `{"x":`,
		`{"displayName":"\ud800"}`, `{"displayName":"\udc00"}`,
		"{\"displayName\":\"\xff\"}",
		`{"x":` + strings.Repeat(`[`, 8) + `0` + strings.Repeat(`]`, 8) + `}`,
	} {
		if _, err := DecodeObject([]byte(input)); !errors.Is(err, ErrInvalidInput) {
			t.Fatalf("malformed input accepted or leaked: %v", err)
		}
	}
	for _, input := range []string{
		`{"displayName":"\ud83d\ude00"}`,
		`{"displayName":"\\ud800"}`,
		`{"x":` + strings.Repeat(`[`, 7) + `0` + strings.Repeat(`]`, 7) + `}`,
	} {
		if _, err := DecodeObject([]byte(input)); err != nil {
			t.Fatalf("valid JSON rejected: %v", err)
		}
	}
	// The boundary accepts an exact-limit body and rejects it after one more byte.
	input := append([]byte(`{}`), bytes.Repeat([]byte(" "), MaxMessageBytes-2)...)
	if _, err := DecodeObject(input); err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeObject(append(input, ' ')); !errors.Is(err, ErrMessageTooLarge) {
		t.Fatalf("oversized input: %v", err)
	}
	if _, err := DecodeMedia([]byte(`{"kind":"local","fingerprintVersion":1,"digest":"` + strings.Repeat("a", 64) + `","sizeBytes":1e3,"durationMs":1000}`)); err == nil {
		t.Fatal("noncanonical integer literal accepted")
	}
}

// Shared fingerprint fixtures protect the length prefixes and overlap ordering.
// This reference hashes synthetic bytes only; production servers never receive file samples.
func TestLocalFingerprintVectors(t *testing.T) {
	data, err := os.ReadFile("../../../../specs/fixtures/local-fingerprints-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		RoomID    string
		SizeBytes int64
		Digest    string
	}
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, v := range vectors {
		h := sha256.New()
		put := func(n int64) { var b [8]byte; binary.BigEndian.PutUint64(b[:], uint64(n)); h.Write(b[:]) }
		for _, value := range []string{"ovs-local-v1", v.RoomID} {
			put(int64(len(value)))
			h.Write([]byte(value))
		}
		put(v.SizeBytes)
		length := min(v.SizeBytes, 1048576)
		for _, offset := range []int64{0, (v.SizeBytes - length) / 2, v.SizeBytes - length} {
			put(offset)
			put(length)
			sample := make([]byte, length)
			for i := range sample {
				sample[i] = byte((offset + int64(i)) * 31 % 251)
			}
			h.Write(sample)
		}
		if hex.EncodeToString(h.Sum(nil)) != v.Digest {
			t.Fatalf("fingerprint encoding differs for size %d", v.SizeBytes)
		}
	}
}

// Media selection accepts only a boolean playback intent, with omission meaning paused.
func TestMediaSelectionPlaybackIntentBoundary(t *testing.T) {
	media := `"media":{"kind":"bilibili","bvid":"BV1TESTaaaaa","cid":"9000000000001","part":1,"durationMs":60000}`
	for _, tc := range []struct {
		name, extra string
		valid, play bool
	}{
		{"omitted", "", true, false},
		{"paused", `,"autoPlay":false`, true, false},
		{"playing", `,"autoPlay":true`, true, true},
		{"string", `,"autoPlay":"true"`, false, false},
		{"null", `,"autoPlay":null`, false, false},
		{"unknown", `,"autoPlay":true,"extra":true`, false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			raw := `{"v":1,"type":"media.select","commandId":"` + strings.Repeat("a", 32) + `","epoch":"` + strings.Repeat("b", 32) + `","mediaGeneration":1,"expectedRevision":1,"payload":{` + media + tc.extra + `}}`
			frame, err := DecodeClientFrame([]byte(raw))
			if (err == nil) != tc.valid || frame.AutoPlay != tc.play {
				t.Fatalf("accepted=%v, play=%v: %v", err == nil, frame.AutoPlay, err)
			}
		})
	}
}

func TestPlaybackRateBoundary(t *testing.T) {
	for _, tc := range []struct {
		payload string
		valid   bool
	}{
		{`{"action":"rate","rate":0.5}`, true},
		{`{"action":"rate","rate":0.75}`, true},
		{`{"action":"rate","rate":1}`, true},
		{`{"action":"rate","rate":1.25}`, true},
		{`{"action":"rate","rate":1.5}`, true},
		{`{"action":"rate","rate":1.75}`, true},
		{`{"action":"rate","rate":2}`, true},
		{`{"action":"rate"}`, false},
		{`{"action":"rate","rate":null}`, false},
		{`{"action":"rate","rate":"1.5"}`, false},
		{`{"action":"rate","rate":0}`, false},
		{`{"action":"rate","rate":0.25}`, false},
		{`{"action":"rate","rate":2.25}`, false},
		{`{"action":"rate","rate":1.1}`, false},
		{`{"action":"rate","rate":1e999}`, false},
		{`{"action":"rate","rate":1,"positionMs":0}`, false},
		{`{"action":"rate","rate":1,"rate":2}`, false},
		{`{"action":"play","rate":1}`, false},
	} {
		t.Run(tc.payload, func(t *testing.T) {
			raw := `{"v":1,"type":"playback.command","commandId":"` + strings.Repeat("a", 32) + `","epoch":"` + strings.Repeat("b", 32) + `","mediaGeneration":1,"expectedRevision":1,"payload":` + tc.payload + `}`
			if _, err := DecodeClientFrame([]byte(raw)); (err == nil) != tc.valid {
				t.Fatalf("accepted=%v, want %v: %v", err == nil, tc.valid, err)
			}
		})
	}
}

// Unsupported operations must fail at the frame boundary before reaching a room owner.
func TestApplicationRejectsUnsupportedMessagesAndVersions(t *testing.T) {
	for _, typ := range []string{"member.activate", "member.observation", "waiting.exclude"} {
		raw, _ := json.Marshal(map[string]any{"v": 1, "type": typ, "epoch": strings.Repeat("a", 32), "payload": map[string]any{}})
		if _, err := DecodeClientFrame(raw); err != Failure("invalid_command") {
			t.Fatalf("unsupported %s accepted: %v", typ, err)
		}
	}
	frame := `{"v":1,"type":"heartbeat","requestId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","payload":{"reply":true}}`
	if got, err := DecodeClientFrame([]byte(frame)); err != nil || got.Type != "heartbeat" || !got.Reply {
		t.Fatal("initial application protocol rejected", got, err)
	}
	if _, err := DecodeClientFrame([]byte(strings.Replace(frame, `"v":1`, `"v":2`, 1))); err != Failure("upgrade_required") {
		t.Fatal("unsupported application protocol accepted", err)
	}
}
