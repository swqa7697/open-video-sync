package ws

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/identity"
	"github.com/swqa7697/open-video-sync/internal/rooms"
)

type outgoing struct {
	kind, epoch string
	payload     json.RawMessage
}
type output struct {
	mu      sync.Mutex
	queue   []outgoing
	bytes   int
	closing bool
	wake    chan struct{}
}

func newOutput() *output { return &output{wake: make(chan struct{}, 1)} }
func (o *output) signal() {
	select {
	case o.wake <- struct{}{}:
	default:
	}
}
func (o *output) Offer(kind, epoch string, payload any) bool {
	b, err := json.Marshal(payload)
	if err != nil {
		o.Close()
		return false
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.closing {
		return false
	}
	// Replace snapshots in place before sequence assignment; command results remain ordered.
	if kind == "room.snapshot" && len(o.queue) > 0 && o.queue[len(o.queue)-1].kind == kind {
		last := len(o.queue) - 1
		o.bytes -= len(o.queue[last].payload) + 200
		o.queue = o.queue[:last]
	}
	if len(o.queue) >= 64 || o.bytes+len(b)+200 > 256<<10 {
		o.closing = true
		o.signal()
		return false
	}
	o.queue = append(o.queue, outgoing{kind, epoch, b})
	o.bytes += len(b) + 200
	o.signal()
	return true
}
func (o *output) Close() { o.mu.Lock(); o.closing = true; o.mu.Unlock(); o.signal() }
func (o *output) next() (outgoing, bool, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.queue) == 0 {
		return outgoing{}, false, o.closing
	}
	v := o.queue[0]
	o.queue = o.queue[1:]
	o.bytes -= len(v.payload) + 200
	return v, true, false
}

// NewHandler authenticates and admits before upgrading; no bearer appears in URLs.
func NewHandler(origin string, identities *identity.Service, service *rooms.Service) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != origin {
			http.Error(w, "origin denied", 403)
			return
		}
		cookie, err := r.Cookie("ovs_session")
		if err != nil {
			http.Error(w, "session required", 401)
			return
		}
		admission, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		p, err := identities.Authenticate(admission, cookie.Value)
		if err != nil {
			cancel()
			http.Error(w, "session required", 401)
			return
		}
		out := newOutput()
		bound, err := service.Connect(admission, p, r.PathValue("roomId"), out)
		cancel()
		if err != nil {
			status := 404
			if err == contracts.Failure("capacity_reached") {
				status = 429
			}
			http.Error(w, "room unavailable", status)
			return
		}
		defer service.Disconnect(bound)
		conn, err := Accept(w, r, origin)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		ctx, stop := context.WithCancel(r.Context())
		defer stop()
		var last atomic.Int64
		last.Store(serviceTime(service))
		finished := make(chan struct{})
		go func() { defer close(finished); defer stop(); out.write(ctx, conn, &last, service.ServerTimeMs) }()
		defer func() { stop(); <-finished }()
		tokens := float64(20)
		at := time.Now()
		observation := time.Time{}
		for {
			kind, b, err := conn.Read(ctx)
			if err != nil {
				return
			}
			if kind != websocket.MessageText {
				_ = conn.Close(websocket.StatusUnsupportedData, "text JSON required")
				return
			}
			f, err := contracts.DecodeClientFrame(b)
			if err != nil {
				code := "invalid_command"
				if err == contracts.Failure("upgrade_required") {
					code = "upgrade_required"
				}
				requestID, _ := contracts.RandomID(rand.Reader)
				out.Offer("error", "", contracts.PublicError{Code: code, Message: "Unsupported room message.", RequestID: requestID})
				out.Close()
				<-finished
				return
			}
			last.Store(serviceTime(service))
			if f.Type == "clock.ping" {
				now := serviceTime(service)
				out.Offer("clock.pong", "", map[string]any{"requestId": f.RequestID, "payload": map[string]int64{"clientSendMs": f.ClientSendMs, "serverReceiveMs": now, "serverSendMs": serviceTime(service)}})
				continue
			}
			if f.Type == "heartbeat" {
				if !f.Reply {
					out.Offer("heartbeat", "", map[string]any{"requestId": f.RequestID, "payload": map[string]bool{"reply": true}})
				}
				continue
			}
			now := time.Now()
			tokens = min(20, tokens+now.Sub(at).Seconds()*10)
			at = now
			if tokens < 1 {
				out.Close()
				return
			}
			tokens--
			if f.Type == "member.observation" {
				if now.Sub(observation) < time.Second {
					continue
				}
				observation = now
			}
			_ = service.Handle(ctx, bound, f)
		}
	})
}
func serviceTime(s *rooms.Service) int64 { return s.ServerTimeMs() }
func (o *output) write(ctx context.Context, c *websocket.Conn, last *atomic.Int64, clock func() int64) {
	timer := time.NewTicker(250 * time.Millisecond)
	defer timer.Stop()
	seq := int64(0)
	heartbeatAt := clock()
	send := func(v any) error {
		b, err := json.Marshal(v)
		if err != nil {
			return err
		}
		deadline, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		return c.Write(deadline, websocket.MessageText, b)
	}
	for {
		for {
			v, ok, closed := o.next()
			if closed {
				return
			}
			if !ok {
				break
			}
			var frame any
			if v.kind == "clock.pong" || v.kind == "heartbeat" {
				var p map[string]any
				_ = json.Unmarshal(v.payload, &p)
				frame = map[string]any{"v": 1, "type": v.kind, "requestId": p["requestId"], "payload": p["payload"]}
			} else {
				seq++
				frame = map[string]any{"v": 1, "type": v.kind, "epoch": v.epoch, "eventSeq": seq, "payload": v.payload}
			}
			if send(frame) != nil {
				return
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-o.wake:
		case <-timer.C:
			if clock()-last.Load() >= 15000 {
				return
			}
			if clock()-heartbeatAt < 5000 {
				continue
			}
			heartbeatAt = clock()
			id, _ := contracts.RandomID(rand.Reader)
			if send(map[string]any{"v": 1, "type": "heartbeat", "requestId": id, "payload": map[string]bool{"reply": false}}) != nil {
				return
			}
		}
	}
}
