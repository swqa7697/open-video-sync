package contracts

import "encoding/json"

// Capabilities declares actual adapter operations, never inferred from a source name.
type Capabilities struct {
	CanPlay              bool  `json:"canPlay"`
	CanPause             bool  `json:"canPause"`
	CanSeek              bool  `json:"canSeek"`
	CanReadPosition      bool  `json:"canReadPosition"`
	CanSetPlaybackRate   bool  `json:"canSetPlaybackRate"`
	CanDetectBuffering   bool  `json:"canDetectBuffering"`
	CanShowDanmaku       bool  `json:"canShowDanmaku"`
	PositionResolutionMs int64 `json:"positionResolutionMs"`
}

// Readiness is bounded, transient player state. It never supplies the room timeline.
type Readiness struct {
	Status            string       `json:"status"`
	MediaGeneration   int64        `json:"mediaGeneration"`
	BarrierID         *string      `json:"barrierId"`
	SampledAtClientMs int64        `json:"sampledAtClientMs"`
	PositionMs        *int64       `json:"positionMs"`
	DurationMs        *int64       `json:"durationMs"`
	Capabilities      Capabilities `json:"capabilities"`
}

// ClientFrame is the validated allowlist used by room and socket handlers.
type ClientFrame struct {
	Type, CommandID, RequestID, Epoch, Action                   string
	MediaGeneration, ExpectedRevision, PositionMs, ClientSendMs int64
	Media                                                       MediaDescriptor
	Report                                                      Readiness
	Reply                                                       bool
}

// DecodeClientFrame rejects unknown, duplicate and missing fields before effects.
func DecodeClientFrame(data []byte) (ClientFrame, error) {
	var f ClientFrame
	o, err := DecodeObject(data)
	if err != nil {
		return f, err
	}
	if v, ok := integer(o["v"], 2, 2); !ok || v != 2 {
		return f, Failure("upgrade_required")
	}
	f.Type, _ = o["type"].(string)
	p, _ := o["payload"].(map[string]any)
	valid := false
	switch f.Type {
	case "heartbeat", "clock.ping":
		f.RequestID, _ = o["requestId"].(string)
		valid = shape(o, "v", "type", "requestId", "payload") && ValidID(f.RequestID)
		if f.Type == "heartbeat" {
			var ok bool
			f.Reply, ok = p["reply"].(bool)
			valid = valid && ok && shape(p, "reply")
		} else {
			var ok bool
			f.ClientSendMs, ok = integer(p["clientSendMs"], 0, MaxSafeInteger)
			valid = valid && ok && shape(p, "clientSendMs")
		}
	case "member.readiness":
		f.Epoch, _ = o["epoch"].(string)
		valid = shape(o, "v", "type", "epoch", "payload") && ValidID(f.Epoch)
		f.Report, err = decodeReadiness(p)
		valid = valid && err == nil
	case "playback.command", "media.select":
		f.CommandID, _ = o["commandId"].(string)
		f.Epoch, _ = o["epoch"].(string)
		var g, r bool
		f.MediaGeneration, g = integer(o["mediaGeneration"], 0, MaxSafeInteger)
		f.ExpectedRevision, r = integer(o["expectedRevision"], 1, MaxSafeInteger)
		valid = shape(o, "v", "type", "commandId", "epoch", "mediaGeneration", "expectedRevision", "payload") && ValidID(f.CommandID) && ValidID(f.Epoch) && g && r
		switch f.Type {
		case "playback.command":
			f.Action, _ = p["action"].(string)
			if f.Action == "seek" {
				var ok bool
				f.PositionMs, ok = integer(p["positionMs"], 0, MaxDurationMs)
				valid = valid && ok && shape(p, "action", "positionMs")
			} else {
				_, ok := choice(f.Action, "play", "pause", "replay")
				valid = valid && ok && shape(p, "action")
			}
		case "media.select":
			b, _ := json.Marshal(p["media"])
			f.Media, err = DecodeMedia(b)
			valid = valid && shape(p, "media") && err == nil

		}
	}
	if !valid {
		return ClientFrame{}, Failure("invalid_command")
	}
	return f, nil
}
func decodeReadiness(p map[string]any) (Readiness, error) {
	var r Readiness
	fields := []string{"status", "mediaGeneration", "sampledAtClientMs", "positionMs", "durationMs", "capabilities"}
	{
		fields = append(fields, "barrierId")
		if p["barrierId"] != nil {
			id, ok := p["barrierId"].(string)
			if !ok || !ValidID(id) {
				return r, ErrInvalidInput
			}
			r.BarrierID = &id
		}
	}
	if !shape(p, fields...) {
		return r, ErrInvalidInput
	}
	var s, g, t bool
	r.Status, s = choice(p["status"], "no_media", "loading", "ready", "buffering", "gesture_required", "mismatch", "access_denied", "unsupported", "error")
	r.MediaGeneration, g = integer(p["mediaGeneration"], 0, MaxSafeInteger)
	r.SampledAtClientMs, t = integer(p["sampledAtClientMs"], 0, MaxSafeInteger)
	if !s || !g || !t {
		return r, ErrInvalidInput
	}
	for key, out := range map[string]**int64{"positionMs": &r.PositionMs, "durationMs": &r.DurationMs} {
		if p[key] != nil {
			min := int64(0)
			if key == "durationMs" {
				min = 1
			}
			n, ok := integer(p[key], min, MaxDurationMs)
			if !ok {
				return r, ErrInvalidInput
			}
			*out = &n
		}
	}
	c, _ := p["capabilities"].(map[string]any)
	if !shape(c, "canPlay", "canPause", "canSeek", "canReadPosition", "canSetPlaybackRate", "canDetectBuffering", "canShowDanmaku", "positionResolutionMs") {
		return r, ErrInvalidInput
	}
	for key, out := range map[string]*bool{"canPlay": &r.Capabilities.CanPlay, "canPause": &r.Capabilities.CanPause, "canSeek": &r.Capabilities.CanSeek, "canReadPosition": &r.Capabilities.CanReadPosition, "canSetPlaybackRate": &r.Capabilities.CanSetPlaybackRate, "canDetectBuffering": &r.Capabilities.CanDetectBuffering, "canShowDanmaku": &r.Capabilities.CanShowDanmaku} {
		v, ok := c[key].(bool)
		if !ok {
			return r, ErrInvalidInput
		}
		*out = v
	}
	n, ok := integer(c["positionResolutionMs"], 1, 60000)
	if !ok {
		return r, ErrInvalidInput
	}
	r.Capabilities.PositionResolutionMs = n
	return r, nil
}

// CommandDigest hashes the canonical validated intent, including its original preconditions.
func CommandDigest(f ClientFrame) string {
	a := []any{"ovs-command-v2", f.Type, f.Epoch, f.MediaGeneration, f.ExpectedRevision}
	switch f.Type {
	case "playback.command":
		var p any
		if f.Action == "seek" {
			p = f.PositionMs
		}
		a = append(a, f.Action, p)
	case "media.select":
		m := f.Media
		var d []any
		if m.Kind == "local" {
			d = []any{m.Kind, m.FingerprintVersion, m.Digest, m.SizeBytes, m.DurationMs, m.Label}
		} else {
			d = []any{m.Kind, m.BVID, m.CID, m.Part, m.DurationMs}
		}
		a = append(a, d)

	}
	return CanonicalDigest(a)
}
