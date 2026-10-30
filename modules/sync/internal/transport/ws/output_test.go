package ws

import (
	"strings"
	"testing"
)

func TestBoundedOutputPreservesResultsAndCoalescesUnsequencedSnapshots(t *testing.T) {
	o := newOutput()
	for range 100 {
		if !o.Offer("room.snapshot", "epoch", map[string]int{"revision": 1}) {
			t.Fatal("replaceable snapshot filled queue")
		}
	}
	if !o.Offer("command.result", "epoch", map[string]bool{"accepted": true}) {
		t.Fatal("result lost")
	}
	if !o.Offer("room.snapshot", "epoch", map[string]int{"revision": 2}) {
		t.Fatal("snapshot lost")
	}
	for _, kind := range []string{"room.snapshot", "command.result", "room.snapshot"} {
		v, ok, _ := o.next()
		if !ok || v.kind != kind {
			t.Fatal("result ordering lost")
		}
	}
	for range 64 {
		if !o.Offer("command.result", "epoch", 1) {
			t.Fatal("queue capacity too small")
		}
	}
	if o.Offer("command.result", "epoch", 2) {
		t.Fatal("frame budget exceeded")
	}
	bytes := newOutput()
	if bytes.Offer("command.result", "epoch", strings.Repeat("a", 256<<10)) {
		t.Fatal("byte budget exceeded")
	}
}
