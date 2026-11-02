package rooms

import (
	"crypto/rand"
	"testing"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
)

func policyRoom() (Room, *liveRoom, *Service) {
	r := Room{HostIdentityID: "host", Settings: contracts.DefaultSettings(), Members: []Member{{ID: "h", IdentityID: "host"}, {ID: "g", IdentityID: "guest"}, {ID: "late", IdentityID: "late"}}}
	l := &liveRoom{media: &contracts.MediaDescriptor{DurationMs: 60000}, generation: 1, playback: Playback{Phase: "playing", DesiredPlaying: true}, connections: map[string]*Connection{"h": {}, "g": {}, "late": {}}, active: map[string]string{"h": "h", "g": "g", "late": "late"}, cohort: map[string]bool{"h": true, "g": true}, reports: map[string]*contracts.Readiness{}, disconnected: map[string]int64{}, bufferSince: map[string]int64{}, readySince: map[string]int64{}}
	return r, l, &Service{Random: rand.Reader}
}
func reportAt(l *liveRoom, status string, position int64) *contracts.Readiness {
	duration := l.media.DurationMs
	r := &contracts.Readiness{Status: status, MediaGeneration: l.generation, PositionMs: &position, DurationMs: &duration, Capabilities: contracts.Capabilities{CanPlay: true, CanPause: true, CanSeek: true, CanReadPosition: true, CanDetectBuffering: true}}
	if l.barrier != nil {
		id := l.barrier.BarrierID
		r.BarrierID = &id
	}
	return r
}
func advance(t *testing.T, s *Service, l *liveRoom, r Room, now int64) {
	t.Helper()
	if _, err := s.advancePolicy(l, r, now); err != nil {
		t.Fatal(err)
	}
}
func TestBufferingCohortStableRecoveryAndDeadline(t *testing.T) {
	r, l, s := policyRoom()
	l.reports["g"] = reportAt(l, "buffering", 0)
	advance(t, s, l, r, 100)
	advance(t, s, l, r, 849)
	if l.barrier != nil {
		t.Fatal("short buffer interrupted playback")
	}
	advance(t, s, l, r, 850)
	if l.barrier == nil || l.barrier.Reason != "buffering" || l.playback.PositionMs != 850 || !l.playback.DesiredPlaying || len(l.barrier.RequiredMemberIDs) != 2 {
		t.Fatal("buffer barrier lost authoritative anchor/cohort")
	}
	l.reports["h"] = reportAt(l, "ready", 850)
	l.reports["g"] = reportAt(l, "ready", 850)
	advance(t, s, l, r, 900)
	advance(t, s, l, r, 1899)
	if l.playback.Phase != "waiting" {
		t.Fatal("unstable readiness released barrier")
	}
	l.reports["g"] = reportAt(l, "buffering", 850)
	advance(t, s, l, r, 1900)
	l.reports["g"] = reportAt(l, "ready", 850)
	advance(t, s, l, r, 2000)
	advance(t, s, l, r, 3000)
	if l.playback.Phase != "playing" || l.playback.AnchorServerMs != 3000 {
		t.Fatal("stable cohort did not resume")
	}
	if err := s.startBarrier(l, "play", []string{"h", "g"}, 4000); err != nil {
		t.Fatal(err)
	}
	l.reports["h"] = reportAt(l, "ready", 850)
	l.reports["g"] = reportAt(l, "ready", 850)
	advance(t, s, l, r, l.barrier.DeadlineServerMs)
	if l.playback.Phase != "paused" || l.playback.DesiredPlaying {
		t.Fatal("deadline silently resumed playback")
	}
}
func TestLateJoinCapabilitiesStaleReportsAndHostLoss(t *testing.T) {
	r, l, s := policyRoom()
	l.reports["late"] = reportAt(l, "ready", 0)
	l.reports["late"].Capabilities.CanDetectBuffering = false
	advance(t, s, l, r, 100)
	if !l.cohort["late"] {
		t.Fatal("ready late joiner did not catch up with buffering fallback")
	}
	if err := s.startBarrier(l, "play", []string{"h", "g"}, 400); err != nil {
		t.Fatal(err)
	}
	l.reports["h"] = reportAt(l, "ready", 0)
	l.reports["g"] = reportAt(l, "ready", 0)
	old := "old"
	l.reports["g"].BarrierID = &old
	advance(t, s, l, r, 500)
	if l.barrier == nil {
		t.Fatal("stale report released barrier")
	}
	l.disconnected["g"] = 15000
	delete(l.connections, "g")
	advance(t, s, l, r, 14999)
	if l.barrier == nil {
		t.Fatal("disconnected member skipped grace")
	}
	advance(t, s, l, r, 15000)
	if l.playback.Phase != "playing" {
		t.Fatal("expired non-host blocked forever")
	}
	l.disconnected["h"] = 30000
	delete(l.connections, "h")
	advance(t, s, l, r, 30000)
	if l.playback.Phase != "playing" || l.barrier != nil {
		t.Fatal("host loss changed controller policy")
	}
	// A client's early ended observation is not an authoritative duration timer.
	r, l, s = policyRoom()
	advance(t, s, l, r, 59999)
	if l.playback.Phase != "playing" {
		t.Fatal("timeline ended early")
	}
	advance(t, s, l, r, 60000)
	if l.playback.Phase != "ended" || l.playback.PositionMs != 60000 {
		t.Fatal("server duration did not end room")
	}
}
