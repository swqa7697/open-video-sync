package contracts

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"unicode/utf8"
)

const (
	// MaxMessageBytes bounds HTTP JSON bodies and WebSocket text messages.
	MaxMessageBytes = 64 << 10
	// MaxJSONDepth counts containers, including the root object.
	MaxJSONDepth = 8
)

var (
	// ErrInvalidInput contains no untrusted input or decoder diagnostics.
	ErrInvalidInput = errors.New("invalid input")
	// ErrMessageTooLarge distinguishes transport size failures from bad input.
	ErrMessageTooLarge = errors.New("message too large")
)

// DecodeObject decodes one bounded JSON object, rejecting duplicate keys at every
// depth, malformed Unicode, and trailing data. Numbers retain their exact text.
// Callers must validate required/unknown fields and semantic bounds before use.
// HTTP callers must also bound reads before allocating the complete body.
func DecodeObject(data []byte) (map[string]any, error) {
	if len(data) > MaxMessageBytes {
		return nil, ErrMessageTooLarge
	}
	if !utf8.Valid(data) || !validSurrogates(data) {
		return nil, ErrInvalidInput
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.UseNumber()
	value, err := readValue(d, 0)
	if err != nil {
		return nil, ErrInvalidInput
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, ErrInvalidInput
	}
	object, ok := value.(map[string]any)
	if !ok {
		return nil, ErrInvalidInput
	}
	return object, nil
}

func readValue(d *json.Decoder, depth int) (any, error) {
	token, err := d.Token()
	if err != nil {
		return nil, err
	}
	delim, container := token.(json.Delim)
	if !container {
		return token, nil
	}
	if depth >= MaxJSONDepth {
		return nil, ErrInvalidInput
	}
	switch delim {
	case '{':
		object := make(map[string]any)
		for d.More() {
			key, err := d.Token()
			if err != nil {
				return nil, err
			}
			name, ok := key.(string)
			if !ok {
				return nil, ErrInvalidInput
			}
			if _, duplicate := object[name]; duplicate {
				return nil, ErrInvalidInput
			}
			value, err := readValue(d, depth+1)
			if err != nil {
				return nil, err
			}
			object[name] = value
		}
		if end, err := d.Token(); err != nil || end != json.Delim('}') {
			return nil, ErrInvalidInput
		}
		return object, nil
	case '[':
		values := make([]any, 0)
		for d.More() {
			value, err := readValue(d, depth+1)
			if err != nil {
				return nil, err
			}
			values = append(values, value)
		}
		if end, err := d.Token(); err != nil || end != json.Delim(']') {
			return nil, ErrInvalidInput
		}
		return values, nil
	default:
		return nil, ErrInvalidInput
	}
}

// encoding/json replaces lone UTF-16 surrogate escapes with U+FFFD. Reject them
// instead so Go and browser validation count the same Unicode scalar values.
func validSurrogates(data []byte) bool {
	for i := 0; i < len(data); i++ {
		if data[i] != '\\' {
			continue
		}
		i++
		if i >= len(data) || data[i] != 'u' || i+4 >= len(data) {
			continue // JSON syntax validation handles incomplete escapes.
		}
		unit, ok := hexUnit(data[i+1 : i+5])
		if !ok {
			return false
		}
		i += 4
		if unit >= 0xdc00 && unit <= 0xdfff {
			return false
		}
		if unit < 0xd800 || unit > 0xdbff {
			continue
		}
		if i+6 >= len(data) || data[i+1] != '\\' || data[i+2] != 'u' {
			return false
		}
		low, ok := hexUnit(data[i+3 : i+7])
		if !ok || low < 0xdc00 || low > 0xdfff {
			return false
		}
		i += 6
	}
	return true
}

func hexUnit(data []byte) (uint16, bool) {
	var value uint16
	for _, c := range data {
		value <<= 4
		switch {
		case c >= '0' && c <= '9':
			value += uint16(c - '0')
		case c >= 'a' && c <= 'f':
			value += uint16(c-'a') + 10
		case c >= 'A' && c <= 'F':
			value += uint16(c-'A') + 10
		default:
			return 0, false
		}
	}
	return value, true
}
