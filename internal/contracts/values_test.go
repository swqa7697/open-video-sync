package contracts

import (
	"bytes"
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
	data, err := os.ReadFile("../../specs/fixtures/wire-v1.json")
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
