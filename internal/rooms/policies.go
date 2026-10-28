package rooms

import (
	"maps"

	"github.com/swqa7697/open-video-sync/internal/contracts"
)

func (l *liveRoom) clone() liveRoom {
	n := *l
	n.excluded = maps.Clone(l.excluded)
	n.cohort = maps.Clone(l.cohort)
	n.disconnected = maps.Clone(l.disconnected)
	n.bufferSince = maps.Clone(l.bufferSince)
	n.readySince = maps.Clone(l.readySince)
	n.connections = maps.Clone(l.connections)
	n.active = maps.Clone(l.active)
	n.generations = maps.Clone(l.generations)
	n.reports = maps.Clone(l.reports)
	if l.barrier != nil {
		b := *l.barrier
		b.RequiredMemberIDs = append([]string{}, b.RequiredMemberIDs...)
		n.barrier = &b
	}
	return n
}

func waitingChanged(a, b contracts.RoomSettings) bool {
	return a.WaitMode != b.WaitMode || a.WaitOnBuffering != b.WaitOnBuffering || a.WaitTimeoutMs != b.WaitTimeoutMs || a.LateJoin != b.LateJoin
}

func (s *Service) startBarrier(l *liveRoom, r Room, reason string, required []string, now int64) error {
	id, err := contracts.RandomID(s.Random)
	if err != nil {
		return err
	}
	l.barrier = &Barrier{id, append([]string{}, required...), reason, l.playback.PositionMs, now + r.Settings.WaitTimeoutMs}
	l.playback.Phase = "waiting"
	l.playback.DesiredPlaying = true
	l.readySince = make(map[string]int64)
	l.bufferSince = make(map[string]int64)
	return nil
}

func capable(report *contracts.Readiness, settings contracts.RoomSettings, excluded bool) bool {
	if report == nil {
		return false
	}
	c := report.Capabilities
	return c.CanPlay && c.CanPause && c.CanSeek && c.CanReadPosition && (settings.WaitMode != "all" || !settings.WaitOnBuffering || excluded || c.CanDetectBuffering)
}

func (s *Service) advancePolicy(l *liveRoom, r Room, now int64) (bool, error) {
	changed := false
	for _, m := range r.Members {
		if deadline, ok := l.disconnected[m.ID]; ok && now >= deadline {
			delete(l.disconnected, m.ID)
			delete(l.cohort, m.ID)
			if m.IdentityID == r.HostIdentityID {
				l.hostLost = true
				l.playback.PositionMs = l.position(now)
				l.playback.AnchorServerMs = now
				if l.media != nil {
					l.playback.Phase = "paused"
				}
				l.playback.DesiredPlaying = false
				l.barrier = nil
			} else if l.barrier != nil {
				ids := []string{}
				for _, mid := range l.barrier.RequiredMemberIDs {
					if mid != m.ID {
						ids = append(ids, mid)
					}
				}
				l.barrier.RequiredMemberIDs = ids
			}
			changed = true
		}
	}
	if l.media == nil {
		return changed, nil
	}
	if l.playback.Phase == "playing" && l.position(now) >= l.media.DurationMs {
		l.playback = Playback{Phase: "ended", PositionMs: l.media.DurationMs, AnchorServerMs: now, BaseRate: 1}
		l.barrier = nil
		return true, nil
	}
	if l.playback.Phase == "playing" {
		for _, m := range r.Members {
			report := l.reports[m.ID]
			if !l.cohort[m.ID] && r.Settings.LateJoin == "catch_up" && l.connections[l.active[m.ID]] != nil && report != nil && report.Status == "ready" && report.MediaGeneration == l.generation && report.DurationMs != nil && abs(*report.DurationMs-l.media.DurationMs) <= 250 && capable(report, r.Settings, l.excluded[m.ID]) {
				l.cohort[m.ID] = true
				changed = true
			}
			if r.Settings.WaitMode != "all" || !r.Settings.WaitOnBuffering || !l.cohort[m.ID] || l.excluded[m.ID] {
				continue
			}
			if report == nil || report.Status != "buffering" {
				delete(l.bufferSince, m.ID)
				continue
			}
			start, exists := l.bufferSince[m.ID]
			if !exists {
				l.bufferSince[m.ID] = now
				continue
			}
			if now-start < 750 {
				continue
			}
			l.playback.PositionMs = l.position(now)
			l.playback.AnchorServerMs = now
			required := []string{}
			for _, candidate := range r.Members {
				if l.cohort[candidate.ID] && !l.excluded[candidate.ID] {
					required = append(required, candidate.ID)
				}
			}
			if err := s.startBarrier(l, r, "buffering", required, now); err != nil {
				return false, err
			}
			return true, nil
		}
	}
	if l.barrier != nil {
		// The deadline wins even if the final ready report arrives at the deadline.
		if now >= l.barrier.DeadlineServerMs {
			l.playback.Phase = "paused"
			l.playback.DesiredPlaying = false
			l.barrier = nil
			l.hostLost = true // Only explicit host action can retry after a deadline.
			return true, nil
		}
		all := true
		for _, mid := range l.barrier.RequiredMemberIDs {
			if !readyFor(l.reports[mid], l, l.barrier) || !capable(l.reports[mid], r.Settings, false) || l.connections[l.active[mid]] == nil {
				delete(l.readySince, mid)
				all = false
				continue
			}
			if l.barrier.Reason == "buffering" {
				since, exists := l.readySince[mid]
				if !exists {
					l.readySince[mid] = now
					all = false
				} else if now-since < 1000 {
					all = false
				}
			}
		}
		if all {
			l.playback.Phase = "playing"
			l.playback.DesiredPlaying = true
			l.playback.AnchorServerMs = now
			l.barrier = nil
			changed = true
		}
	}
	return changed, nil
}
