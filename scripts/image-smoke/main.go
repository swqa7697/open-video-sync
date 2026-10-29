// Command image-smoke verifies the template container on an isolated volume.
package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/coder/websocket"
	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/rooms"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

func main() {
	image := flag.String("image", "ovs:dev", "application image")
	flag.Parse()
	if err := run(*image); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func docker(ctx context.Context, args ...string) (string, error) {
	output, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("docker %s: %w: %s", args[0], err, output)
	}
	return strings.TrimSpace(string(output)), nil
}

func run(image string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	name := "ovs-smoke-" + rand.Text()[:12]
	volume := name + "-data"
	if _, err := docker(ctx, "volume", "create", volume); err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_, _ = docker(cleanup, "rm", "-f", name)
		_, _ = docker(cleanup, "volume", "rm", volume)
	}()
	directory := filepath.Join(".misc", "image-smoke", name)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	user, err := docker(ctx, "image", "inspect", "--format", "{{.Config.User}}", image)
	if err != nil || user != "10001:10001" {
		return fmt.Errorf("image user %q, want 10001:10001: %w", user, err)
	}
	var previousLedger string
	var application applicationState
	for phase := 1; phase <= 2; phase++ {
		if _, err := docker(ctx, "run", "-d", "--name", name, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "-p", "127.0.0.1::8080", "--mount", "type=volume,src="+volume+",dst=/data", "-e", "OVS_PUBLIC_ORIGIN=http://ovs.example", image); err != nil {
			return err
		}
		if err := checkHTTP(ctx, name); err != nil {
			logs, _ := docker(ctx, "logs", name)
			return fmt.Errorf("%w\n%s", err, logs)
		}
		application, err = checkApplication(ctx, name, application)
		if err != nil {
			return err
		}
		if _, err := docker(ctx, "exec", name, "/ovs", "healthcheck"); err != nil {
			return err
		}
		// A second process must not become an independent data-directory owner.
		if _, err := docker(ctx, "exec", name, "/ovs"); err == nil || !strings.Contains(err.Error(), "already owned") {
			return fmt.Errorf("second process did not reject ownership: %v", err)
		}
		if _, err := docker(ctx, "stop", "--time", "15", name); err != nil {
			return err
		}
		exit, err := docker(ctx, "inspect", "--format", "{{.State.ExitCode}}", name)
		if err != nil || exit != "0" {
			return fmt.Errorf("container did not stop cleanly: exit=%s: %v", exit, err)
		}
		copyTo := filepath.Join(directory, fmt.Sprintf("phase-%d", phase))
		if err := os.MkdirAll(copyTo, 0o700); err != nil {
			return err
		}
		if _, err := docker(ctx, "cp", name+":/data/.", copyTo); err != nil {
			return err
		}
		ledger, err := inspectDatabase(ctx, filepath.Join(copyTo, "ovs.sqlite"))
		if err != nil {
			return err
		}
		if phase == 2 && previousLedger != ledger {
			return errors.New("container replacement changed the applied migration record")
		}
		previousLedger = ledger
		if _, err := docker(ctx, "rm", name); err != nil {
			return err
		}
	}
	fmt.Println("Image passed: non-root/read-only startup, embedded UI and scoped helper, reserved routes, ownership, clean stop, and identity/room persistence across replacement.")
	fmt.Printf("Isolated database copies: %s\n", directory)
	return nil
}

func checkHTTP(ctx context.Context, name string) error {
	port, err := docker(ctx, "port", name, "8080/tcp")
	if err != nil {
		return err
	}
	client := &http.Client{Timeout: time.Second}
	defer client.CloseIdleConnections()
	base := "http://" + port
	deadline := time.Now().Add(15 * time.Second)
	for {
		err = request(ctx, client, base, "/health/ready", 204)
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	for path, code := range map[string]int{"/": 200, "/join": 200, "/userscripts/ovs-bilibili.user.js": 200, "/userscripts/absent.user.js": 404, "/api/v2/session": 404, "/api/v2/rooms/test/ws": 404, "/api/v1/rooms": 409, "/ws/v1/rooms/test": 409} {
		if err := request(ctx, client, base, path, code); err != nil {
			return err
		}
	}
	return nil
}

func request(ctx context.Context, client *http.Client, base, path string, code int) error {
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, base+path, nil)
	if err != nil {
		return err
	}
	r.Host = "ovs.example"
	response, err := client.Do(r)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return err
	}
	validBody := code != 200 || strings.Contains(string(body), `<div id="app">`)
	if path == "/userscripts/ovs-bilibili.user.js" {
		validBody = strings.Contains(string(body), "@name OVS Bilibili http://ovs.example") && strings.Contains(string(body), `const ORIGIN = "http://ovs.example"`) && strings.HasPrefix(response.Header.Get("Content-Type"), "application/javascript") && !strings.Contains(string(body), "{{")
	}
	if response.StatusCode != code || !validBody {
		return fmt.Errorf("%s returned %d; want %d with expected content", path, response.StatusCode, code)
	}
	return nil
}

func inspectDatabase(ctx context.Context, path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	dsn := url.URL{Scheme: "file", Path: absolute, RawQuery: "mode=ro"}
	db, err := sql.Open("sqlite", dsn.String())
	if err != nil {
		return "", err
	}
	defer db.Close()
	var checksum, applied string
	if err := db.QueryRowContext(ctx, "SELECT checksum, applied_at FROM schema_migrations WHERE version=1").Scan(&checksum, &applied); err != nil {
		return "", err
	}
	return checksum + ":" + applied, nil
}

// State uses only isolated test credentials. Do not print bearer or invitation values.
type applicationState struct{ token, csrf, identityID, roomID, epoch, invitation string }

func checkApplication(ctx context.Context, name string, previous applicationState) (applicationState, error) {
	port, err := docker(ctx, "port", name, "8080/tcp")
	if err != nil {
		return previous, err
	}
	client := &http.Client{Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	call := func(method, path string, payload any) (map[string]json.RawMessage, error) {
		b, err := json.Marshal(payload)
		if err != nil {
			return nil, err
		}
		r, err := http.NewRequestWithContext(ctx, method, "http://"+port+"/api/v2"+path, strings.NewReader(string(b)))
		if err != nil {
			return nil, err
		}
		r.Host = "ovs.example"
		r.Header.Set("Origin", "http://ovs.example")
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-OVS-CSRF", previous.csrf)
		if previous.token != "" {
			r.AddCookie(&http.Cookie{Name: "ovs_session", Value: previous.token})
		}
		random := make([]byte, 16)
		if _, err := rand.Read(random); err != nil {
			return nil, err
		}
		r.Header.Set("Idempotency-Key", hex.EncodeToString(random))
		response, err := client.Do(r)
		if err != nil {
			return nil, err
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return nil, fmt.Errorf("application %s %s returned %d", method, path, response.StatusCode)
		}
		for _, cookie := range response.Cookies() {
			if cookie.Name == "ovs_session" {
				previous.token = cookie.Value
			}
		}
		var value map[string]json.RawMessage
		err = json.NewDecoder(io.LimitReader(response.Body, 65536)).Decode(&value)
		return value, err
	}
	initial := previous.identityID == ""
	if initial {
		value, err := call("POST", "/session", struct{}{})
		if err != nil {
			return previous, err
		}
		var profile struct{ IdentityID string }
		if err := json.Unmarshal(value["identity"], &profile); err != nil {
			return previous, err
		}
		previous.identityID = profile.IdentityID
		if err := json.Unmarshal(value["csrfToken"], &previous.csrf); err != nil {
			return previous, err
		}
		value, err = call("POST", "/rooms", map[string]any{"title": "Container persistence", "settings": map[string]any{"controllers": "everyone", "waitForAll": false}})
		if err != nil {
			return previous, err
		}
		var snapshot struct{ RoomID string }
		if err := json.Unmarshal(value["snapshot"], &snapshot); err != nil {
			return previous, err
		}
		previous.roomID = snapshot.RoomID
	} else {
		value, err := call("GET", "/me", nil)
		if err != nil {
			return previous, err
		}
		var profile struct{ IdentityID string }
		if err := json.Unmarshal(value["identity"], &profile); err != nil {
			return previous, err
		}
		if profile.IdentityID != previous.identityID {
			return previous, errors.New("container replacement lost identity")
		}
		value, err = call("GET", "/rooms/"+previous.roomID, nil)
		if err != nil {
			return previous, err
		}
		var id, title string
		_ = json.Unmarshal(value["roomId"], &id)
		_ = json.Unmarshal(value["title"], &title)
		if id != previous.roomID || title != "Container persistence" {
			return previous, errors.New("container replacement lost room")
		}
	}
	value, err := call("GET", "/rooms/"+previous.roomID, nil)
	if err != nil {
		return previous, err
	}
	raw, _ := json.Marshal(value)
	var snap rooms.Snapshot
	if err := json.Unmarshal(raw, &snap); err != nil {
		return previous, err
	}
	if snap.Settings.Controllers != "everyone" || snap.Settings.WaitForAll {
		return previous, errors.New("container lost settings")
	}
	inv, err := call("GET", "/rooms/"+previous.roomID+"/invitations", nil)
	if err != nil {
		return previous, err
	}
	var invitation rooms.Invitation
	if err := json.Unmarshal(inv["invitation"], &invitation); err != nil {
		return previous, err
	}
	if initial {
		previous.epoch = snap.Epoch
		previous.invitation = invitation.LinkSecret
		address := "ws://" + port + "/ws/v2/rooms/" + previous.roomID
		conn, _, err := websocket.Dial(ctx, address, &websocket.DialOptions{Host: "ovs.example", HTTPHeader: http.Header{"Origin": {"http://ovs.example"}, "Cookie": {"ovs_session=" + previous.token}}})
		if err != nil {
			return previous, err
		}
		defer conn.CloseNow()
		for _, intent := range []contracts.ClientFrame{{Type: "media.select", Media: contracts.MediaDescriptor{Kind: "bilibili", BVID: "BV1hf4y1N75G", CID: "400306737", Part: 1, DurationMs: 60000}}, {Type: "playback.command", Action: "seek", PositionMs: 12000}, {Type: "playback.command", Action: "play"}} {
			key, _ := contracts.RandomID(rand.Reader)
			payload := map[string]any{"action": intent.Action}
			if intent.Type == "media.select" {
				payload = map[string]any{"media": intent.Media}
			} else if intent.Action == "seek" {
				payload["positionMs"] = intent.PositionMs
			}
			frame := map[string]any{"v": 2, "type": intent.Type, "commandId": key, "epoch": snap.Epoch, "expectedRevision": snap.Revision, "mediaGeneration": snap.MediaGeneration, "payload": payload}
			b, _ := json.Marshal(frame)
			if err := conn.Write(ctx, websocket.MessageText, b); err != nil {
				return previous, err
			}
			for {
				_, b, err := conn.Read(ctx)
				if err != nil {
					return previous, err
				}
				var f struct {
					Type    string
					Payload json.RawMessage
				}
				if json.Unmarshal(b, &f) != nil {
					return previous, errors.New("invalid socket frame")
				}
				if f.Type == "command.result" {
					var result rooms.CommandResult
					json.Unmarshal(f.Payload, &result)
					if !result.Accepted {
						return previous, errors.New("image socket rejected control")
					}
					break
				}
			}
			value, err = call("GET", "/rooms/"+previous.roomID, nil)
			if err != nil {
				return previous, err
			}
			raw, _ = json.Marshal(value)
			if err := json.Unmarshal(raw, &snap); err != nil {
				return previous, err
			}
		}
		if snap.Playback.Phase != "playing" || snap.Playback.PositionMs != 12000 {
			return previous, errors.New("image playback controls did not apply")
		}
	} else {
		if snap.Epoch == previous.epoch || snap.Revision != 1 || snap.MediaGeneration != 1 || snap.Media == nil || snap.Playback.Phase != "paused" || snap.Playback.PositionMs != 0 || snap.Barrier != nil || invitation.LinkSecret != previous.invitation {
			return previous, errors.New("replacement lost selection/invitation or retained playback runtime")
		}
	}
	if previous.identityID == "" || previous.roomID == "" || previous.token == "" {
		return previous, errors.New("application persistence setup incomplete")
	}
	return previous, nil
}
