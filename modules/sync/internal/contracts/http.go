package contracts

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"regexp"
	"strings"
)

var idPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

// ValidID validates server and client generated opaque identifiers.
func ValidID(value string) bool { return idPattern.MatchString(value) }

// RandomID uses the supplied cryptographic random source.
func RandomID(random io.Reader) (string, error) {
	b := make([]byte, 16)
	_, err := io.ReadFull(random, b)
	return hex.EncodeToString(b), err
}

// RandomSecret generates an unpadded base64url bearer secret.
func RandomSecret(random io.Reader, size int) (string, error) {
	b := make([]byte, size)
	_, err := io.ReadFull(random, b)
	return base64.RawURLEncoding.EncodeToString(b), err
}

// SecretHash rejects noncanonical encodings before hashing decoded bytes.
func SecretHash(secret string, size int) (string, bool) {
	b, err := base64.RawURLEncoding.Strict().DecodeString(secret)
	if err != nil || len(b) != size || base64.RawURLEncoding.EncodeToString(b) != secret {
		return "", false
	}
	return Hash(b), true
}

// Hash returns a lowercase SHA-256 digest.
func Hash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

// CanonicalDigest hashes positional arrays without HTML escaping or whitespace.
func CanonicalDigest(value []any) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(value) // Only validated strings, finite numbers, booleans, and arrays enter here.
	raw := bytes.TrimSuffix(b.Bytes(), []byte{'\n'})
	// encoding/json escapes U+2028/U+2029 even with HTML escaping disabled.
	// Decode only those actual escapes, preserving literal backslash-u text.
	canonical := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); i++ {
		if raw[i] == '\\' && i+1 < len(raw) {
			if i+5 < len(raw) && raw[i+1] == 'u' && (string(raw[i+2:i+6]) == "2028" || string(raw[i+2:i+6]) == "2029") {
				if raw[i+5] == '8' {
					canonical = append(canonical, []byte(" ")...)
				} else {
					canonical = append(canonical, []byte(" ")...)
				}
				i += 5
				continue
			}
			canonical = append(canonical, raw[i], raw[i+1])
			i++
			continue
		}
		canonical = append(canonical, raw[i])
	}
	return Hash(canonical)
}

// SettingsArray defines the version-2 digest order.
func SettingsArray(s RoomSettings) []any {
	return []any{s.Controllers, s.WaitForAll}
}

// DefaultSettings constructs the initial host preferences.
func DefaultSettings() RoomSettings {
	return RoomSettings{"host", true}
}

// NormalizeCode applies only the specified ASCII Crockford aliases/separators.
func NormalizeCode(input string) (string, bool) {
	var b strings.Builder
	for _, c := range input {
		if c == ' ' || c == '-' {
			continue
		}
		if c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
		}
		switch c {
		case 'O':
			c = '0'
		case 'I', 'L':
			c = '1'
		}
		if !strings.ContainsRune("0123456789ABCDEFGHJKMNPQRSTVWXYZ", c) {
			return "", false
		}
		b.WriteRune(c)
	}
	return b.String(), b.Len() == 16
}

// ValidTitle validates a user-entered room title without modifying it.
func ValidTitle(title string) bool {
	return boundedText(title, 120, 480) && strings.TrimSpace(title) != ""
}

// PublicError is a bounded transport error. Its code is safe to log.
type PublicError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"requestId"`
	Retryable bool   `json:"retryable"`
}

// Failure is an application rejection without private diagnostics.
type Failure string

func (f Failure) Error() string { return string(f) }
