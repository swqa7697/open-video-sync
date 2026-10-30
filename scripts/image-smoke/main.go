// Command image-smoke verifies the template container on an isolated volume.
package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/rooms"
	"github.com/swqa7697/open-video-sync/scripts/internal/smoke"
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

var docker = smoke.Docker

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
	fmt.Println("Image passed: non-root/read-only startup, embedded UI and scoped helper, reserved routes, ownership, clean stop, and identity/name/room/membership persistence across replacement.")
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
type applicationState struct {
	host, guest                    smoke.Client
	hostID, guestID, guestMemberID string
	roomID, epoch, invitation      string
}

const (
	roomTitle = "Container persistence"
	hostName  = "Container host"
	guestName = "Container guest"
)

func checkApplication(ctx context.Context, name string, previous applicationState) (applicationState, error) {
	port, err := docker(ctx, "port", name, "8080/tcp")
	if err != nil {
		return previous, err
	}
	httpClient := &http.Client{}
	defer httpClient.CloseIdleConnections()
	for _, client := range []*smoke.Client{&previous.host, &previous.guest} {
		client.HTTP, client.Base, client.Host, client.Origin = httpClient, "http://"+port, "ovs.example", "http://ovs.example"
	}
	initial := previous.hostID == ""
	if initial {
		if previous.hostID, err = previous.host.Bootstrap(ctx); err != nil {
			return previous, err
		}
		if _, err := previous.host.Call(ctx, "PATCH", "/me", map[string]any{"displayName": hostName}); err != nil {
			return previous, err
		}
		value, err := previous.host.Call(ctx, "POST", "/rooms", map[string]any{"title": roomTitle, "settings": map[string]any{"controllers": "everyone", "waitForAll": false}})
		if err != nil {
			return previous, err
		}
		var created rooms.Result
		raw, _ := json.Marshal(value)
		if err := json.Unmarshal(raw, &created); err != nil || created.Invitation == nil {
			return previous, errors.New("room creation returned no host invitation")
		}
		previous.roomID = created.Snapshot.RoomID
		if previous.guestID, err = previous.guest.Bootstrap(ctx); err != nil {
			return previous, err
		}
		if _, err := previous.guest.Call(ctx, "PATCH", "/me", map[string]any{"displayName": guestName}); err != nil {
			return previous, err
		}
		value, err = previous.guest.Call(ctx, "POST", "/invitations/redeem", map[string]any{"code": created.Invitation.Code})
		if err != nil {
			return previous, err
		}
		var joined rooms.Result
		raw, _ = json.Marshal(value)
		if err := json.Unmarshal(raw, &joined); err != nil || joined.Snapshot.SelfMemberID == "" {
			return previous, errors.New("guest redemption returned no membership")
		}
		previous.guestMemberID = joined.Snapshot.SelfMemberID
	} else {
		for _, profile := range []struct {
			client   *smoke.Client
			id, name string
		}{{&previous.host, previous.hostID, hostName}, {&previous.guest, previous.guestID, guestName}} {
			id, displayName, err := profile.client.Me(ctx)
			if err != nil {
				return previous, err
			}
			if id != profile.id || displayName != profile.name {
				return previous, errors.New("container replacement lost identity or display name")
			}
		}
		guestView, err := previous.guest.Snapshot(ctx, previous.roomID)
		if err != nil || guestView.SelfMemberID != previous.guestMemberID {
			return previous, fmt.Errorf("container replacement lost guest membership: %v", err)
		}
	}
	snap, err := previous.host.Snapshot(ctx, previous.roomID)
	if err != nil {
		return previous, err
	}
	if snap.RoomID != previous.roomID || snap.Title != roomTitle {
		return previous, errors.New("container replacement lost room")
	}
	if snap.Settings.Controllers != "everyone" || snap.Settings.WaitForAll {
		return previous, errors.New("container lost settings")
	}
	names := map[string]string{}
	for _, member := range snap.Members {
		names[member.MemberID] = member.DisplayName
	}
	if len(snap.Members) != 2 || names[previous.guestMemberID] != guestName || names[snap.HostMemberID] != hostName {
		return previous, errors.New("container lost membership or roster names")
	}
	inv, err := previous.host.Call(ctx, "GET", "/rooms/"+previous.roomID+"/invitations", nil)
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
		conn, err := previous.host.Dial(ctx, previous.roomID)
		if err != nil {
			return previous, err
		}
		defer conn.CloseNow()
		for _, intent := range []struct {
			kind    string
			payload map[string]any
		}{
			{"media.select", map[string]any{"media": contracts.MediaDescriptor{Kind: "bilibili", BVID: "BV1hf4y1N75G", CID: "400306737", Part: 1, DurationMs: 60000}}},
			{"playback.command", map[string]any{"action": "seek", "positionMs": 12000}},
			{"playback.command", map[string]any{"action": "play"}},
		} {
			result, err := smoke.Command(ctx, conn, snap, intent.kind, intent.payload)
			if err != nil {
				return previous, err
			}
			if !result.Accepted {
				return previous, errors.New("image socket rejected control")
			}
			if snap, err = previous.host.Snapshot(ctx, previous.roomID); err != nil {
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
	if previous.hostID == "" || previous.guestID == "" || previous.roomID == "" || previous.host.Token == "" || previous.guest.Token == "" {
		return previous, errors.New("application persistence setup incomplete")
	}
	return previous, nil
}
