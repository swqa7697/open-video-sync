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
	for path, code := range map[string]int{"/": 200, "/join": 200, "/userscripts/ovs-bilibili.user.js": 200, "/userscripts/absent.user.js": 404, "/api/v1/session": 404, "/api/v1/rooms/test/ws": 404} {
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
type applicationState struct{ token, csrf, identityID, roomID string }

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
		r, err := http.NewRequestWithContext(ctx, method, "http://"+port+"/api/v1"+path, strings.NewReader(string(b)))
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
	if previous.identityID == "" {
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
		value, err = call("POST", "/rooms", map[string]any{"title": "Container persistence", "settings": map[string]any{"controllers": "host", "syncMode": "adaptive", "waitMode": "all", "waitOnBuffering": true, "waitTimeoutMs": 30000, "lateJoin": "catch_up", "softDriftMs": 100, "hardDriftMs": 750}})
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
	if previous.identityID == "" || previous.roomID == "" || previous.token == "" {
		return previous, errors.New("application persistence setup incomplete")
	}
	return previous, nil
}
