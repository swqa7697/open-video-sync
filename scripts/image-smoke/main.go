// Command image-smoke verifies the template container on an isolated volume.
package main

import (
	"context"
	"crypto/rand"
	"database/sql"
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
	for phase := 1; phase <= 2; phase++ {
		if _, err := docker(ctx, "run", "-d", "--name", name, "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "-p", "127.0.0.1::8080", "--mount", "type=volume,src="+volume+",dst=/data", "-e", "OVS_PUBLIC_ORIGIN=http://ovs.example", image); err != nil {
			return err
		}
		if err := checkHTTP(ctx, name); err != nil {
			logs, _ := docker(ctx, "logs", name)
			return fmt.Errorf("%w\n%s", err, logs)
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
	fmt.Println("Image passed: non-root/read-only startup, embedded UI, reserved routes, ownership, clean stop, and volume persistence.")
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
	for path, code := range map[string]int{"/": 200, "/join": 200, "/api/v1/session": 404, "/api/v1/rooms/test/ws": 404} {
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
	if response.StatusCode != code || (code == 200 && !strings.Contains(string(body), `<div id="app">`)) {
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
