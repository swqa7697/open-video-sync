package rooms

import (
	"maps"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/contracts"
)

func (l *liveRoom) clone() liveRoom {
	n := *l
	n.receipts = maps.Clone(l.receipts)
	n.cohort = maps.Clone(l.cohort)
	n.disconnected = maps.Clone(l.disconnected)
	n.departures = maps.Clone(l.departures)
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

func (s *Service) startBarrier(l *liveRoom, reason string, required []string, now int64) error {
	id, err := contracts.RandomID(s.Random)
	if err != nil {
		return err
	}
	l.barrier = &Barrier{id, append([]string{}, required...), reason, l.playback.PositionMs, now + 30000}
	l.playback.Phase = "waiting"
	l.playback.DesiredPlaying = true
	l.readySince = make(map[string]int64)
	l.bufferSince = make(map[string]int64)
	return nil
}

func capable(report *contracts.Readiness) bool {
	if report == nil {
		return false
	}
	c := report.Capabilities
	return c.CanPlay && c.CanPause && c.CanSeek && c.CanReadPosition
}

func (s *Service) advancePolicy(l *liveRoom, r Room, now int64) (bool, error) {
	changed := false
	for _, m := range r.Members {
		if deadline, ok := l.disconnected[m.ID]; ok && now >= deadline {
			delete(l.disconnected, m.ID)
			delete(l.cohort, m.ID)
			if l.barrier != nil {
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
	if len(l.connections) == 0 && l.media != nil && (l.playback.Phase == "playing" || l.playback.Phase == "waiting") {
		l.playback.PositionMs = l.position(now)
		l.playback.AnchorServerMs = now
		l.playback.Phase = "paused"
		l.playback.DesiredPlaying = false
		l.barrier = nil
		changed = true
	}
	if l.media == nil {
		return changed, nil
	}
	if l.playback.Phase == "playing" && l.position(now) >= l.media.DurationMs {
		l.playback = Playback{Phase: "ended", PositionMs: l.media.DurationMs, AnchorServerMs: now}
		l.barrier = nil
		return true, nil
	}
	if l.playback.Phase == "playing" {
		for _, m := range r.Members {
			report := l.reports[m.ID]
			if !l.cohort[m.ID] && l.connections[l.active[m.ID]] != nil && report != nil && report.Status == "ready" && report.MediaGeneration == l.generation && report.DurationMs != nil && abs(*report.DurationMs-l.media.DurationMs) <= 250 && capable(report) {
				l.cohort[m.ID] = true
				changed = true
			}
			if !r.Settings.WaitForAll || !l.cohort[m.ID] {
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
				if l.cohort[candidate.ID] {
					required = append(required, candidate.ID)
				}
			}
			if err := s.startBarrier(l, "buffering", required, now); err != nil {
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
			return true, nil
		}
		all := true
		for _, mid := range l.barrier.RequiredMemberIDs {
			if !readyFor(l.reports[mid], l, l.barrier) || !capable(l.reports[mid]) || l.connections[l.active[mid]] == nil {
				delete(l.readySince, mid)
				all = false
				continue
			}
			since, exists := l.readySince[mid]
			if !exists {
				l.readySince[mid] = now
				all = false
			} else if now-since < 1000 {
				all = false
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
