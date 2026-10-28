package contracts

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestSharedCanonicalHTTPDigests(t *testing.T) {
	b, err := os.ReadFile("../../specs/fixtures/http-digests-v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name   string
		Input  []any
		Digest string
	}
	if err := json.Unmarshal(b, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			if got := CanonicalDigest(tc.Input); got != tc.Digest {
				t.Fatalf("digest=%s want %s", got, tc.Digest)
			}
		})
	}
}
func TestInvitationCanonicalBoundaries(t *testing.T) {
	for _, input := range []string{"0123-4567-89ab-cdef", "o123 4567 89AB CDEF"} {
		code, ok := NormalizeCode(input)
		if !ok || code != "0123456789ABCDEF" {
			t.Fatal("normalization", code, ok)
		}
	}
	for _, input := range []string{"0123\t456789ABCDEF", "0123456789ABCDEU", "0123456789ABCDEF!", strings.Repeat("0", 17)} {
		if _, ok := NormalizeCode(input); ok {
			t.Fatal("invalid code accepted")
		}
	}
	if _, ok := SecretHash("AAECAwQFBgcICQoLDA0ODw", 16); !ok {
		t.Fatal("valid link rejected")
	}
	for _, secret := range []string{"AAECAwQFBgcICQoLDA0ODx", "AAECAwQFBgcICQoLDA0ODw==", "AAECAwQFBgcICQoLDA0ODw\n"} {
		if _, ok := SecretHash(secret, 16); ok {
			t.Fatal("noncanonical secret accepted")
		}
	}
}
