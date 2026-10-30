// Command proxy-smoke verifies HTTPS through containerized Caddy with the shipped Compose
// overlay: public-origin cookies and helper scope, trusted-proxy client addresses, and room
// socket reconnect after a Caddy reload.
package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/swqa7697/open-video-sync/internal/contracts"
	"github.com/swqa7697/open-video-sync/internal/rooms"
	"github.com/swqa7697/open-video-sync/scripts/internal/smoke"
)

const (
	publicHost   = "ovs.test"
	publicOrigin = "https://" + publicHost
	exampleHost  = "watch.example.com"
	exampleProxy = "reverse_proxy ovs:8080"
)

func main() {
	image := flag.String("image", "ovs:dev", "application image")
	caddy := flag.String("caddy", "caddy:2", "Caddy image")
	flag.Parse()
	if err := run(*image, *caddy); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// summary is retained evidence. It contains no cookies, CSRF tokens, or invitation values.
type summary struct {
	Image, ImageID, Caddy, CaddyImageID, CaddyVersion string
	SecureCookie, ScopedHelper                        bool
	ReloadCloseCode                                   int
	ReloadToWelcomeMs                                 int64
	SameEpochAfterReload, PausedAfterReload           bool
	ProxyProbesBeforeLimit                            int
	DirectProbeCodes                                  []int
	CleanStop                                         bool
	DurationMs                                        int64
}

func run(image, caddyImage string) (err error) {
	started := time.Now()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	name := "ovs-proxy-smoke-" + strings.ToLower(rand.Text()[:10])
	network, caddy := name+"-proxy", name+"-caddy"
	directory, err := filepath.Abs(filepath.Join(".misc", "proxy-smoke", name))
	if err != nil {
		return err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	compose := []string{"compose", "-p", name, "-f", "deploy/compose.yaml", "-f", "deploy/compose.caddy.yaml", "-f", filepath.Join(directory, "override.yaml")}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if logs, logErr := smoke.Docker(cleanup, append(compose, "logs", "--no-color", "ovs")...); logErr == nil {
			_ = os.WriteFile(filepath.Join(directory, "ovs.log"), []byte(logs+"\n"), 0o600)
		}
		if logs, logErr := smoke.Docker(cleanup, "logs", caddy); logErr == nil {
			_ = os.WriteFile(filepath.Join(directory, "caddy.log"), []byte(logs+"\n"), 0o600)
		}
		_, _ = smoke.Docker(cleanup, append(compose, "down", "-v", "--remove-orphans")...)
		_, _ = smoke.Docker(cleanup, "rm", "-f", "-v", caddy)
		_, _ = smoke.Docker(cleanup, "network", "rm", network)
	}()
	result := summary{Image: image, Caddy: caddyImage}
	if result.ImageID, err = smoke.Docker(ctx, "image", "inspect", "--format", "{{.Id}}", image); err != nil {
		return err
	}
	if err := writeConfig(directory, image, network); err != nil {
		return err
	}
	if _, err := smoke.Docker(ctx, "network", "create", network); err != nil {
		return err
	}
	if _, err := smoke.Docker(ctx, "run", "-d", "--name", caddy, "--network", network, "-p", "127.0.0.1::443", "-v", filepath.Join(directory, "Caddyfile")+":/etc/caddy/Caddyfile:ro", caddyImage); err != nil {
		return err
	}
	if result.CaddyImageID, err = smoke.Docker(ctx, "inspect", "--format", "{{.Image}}", caddy); err != nil {
		return err
	}
	if result.CaddyVersion, err = smoke.Docker(ctx, "exec", caddy, "caddy", "version"); err != nil {
		return err
	}
	caddyIP, err := smoke.Docker(ctx, "inspect", "--format", fmt.Sprintf("{{(index .NetworkSettings.Networks %q).IPAddress}}", network), caddy)
	if err != nil || net.ParseIP(caddyIP) == nil {
		return fmt.Errorf("read Caddy address %q: %v", caddyIP, err)
	}
	// Trust only Caddy itself. Other peers on the network, including the gateway, stay untrusted.
	env := []string{"OVS_PUBLIC_ORIGIN=" + publicOrigin, "OVS_TRUSTED_PROXIES=" + caddyIP + "/32"}
	if _, err := smoke.Run(ctx, env, "docker", append(compose, "up", "-d", "--wait", "--wait-timeout", "60", "--no-build", "--pull", "never")...); err != nil {
		return err
	}
	httpsPort, err := smoke.Docker(ctx, "port", caddy, "443/tcp")
	if err != nil {
		return err
	}
	directPort, err := smoke.Docker(ctx, append(compose, "port", "ovs", "8080")...)
	if err != nil {
		return err
	}
	pool, err := caddyRoots(ctx, caddy)
	if err != nil {
		return err
	}
	dialer := &net.Dialer{}
	transport := &http.Transport{
		Proxy:           nil,
		TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: publicHost},
		// Browsers resolve the public host to Caddy; the harness dials Caddy's published port.
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, httpsPort)
		},
	}
	httpClient := &http.Client{Transport: transport}
	defer httpClient.CloseIdleConnections()
	if err := waitReady(ctx, httpClient); err != nil {
		return err
	}
	if result.ScopedHelper, err = checkPages(ctx, httpClient); err != nil {
		return err
	}
	if err := checkReconnect(ctx, httpClient, caddy, &result); err != nil {
		return err
	}
	if err := checkAddresses(ctx, httpClient, directPort, &result); err != nil {
		return err
	}
	container, err := smoke.Docker(ctx, append(compose, "ps", "-q", "ovs")...)
	if err != nil {
		return err
	}
	if _, err := smoke.Docker(ctx, append(compose, "stop", "--timeout", "15")...); err != nil {
		return err
	}
	exit, err := smoke.Docker(ctx, "inspect", "--format", "{{.State.ExitCode}}", container)
	if err != nil || exit != "0" {
		return fmt.Errorf("OVS did not stop cleanly behind Caddy: exit=%s: %v", exit, err)
	}
	result.CleanStop = true
	result.DurationMs = time.Since(started).Milliseconds()
	b, _ := json.MarshalIndent(result, "", "  ")
	if err := os.WriteFile(filepath.Join(directory, "summary.json"), append(b, '\n'), 0o600); err != nil {
		return err
	}
	fmt.Printf("Proxy passed: HTTPS through Caddy, Secure cookie, scoped helper, trusted-proxy client addresses, and same-epoch socket reconnect after reload (%d ms).\n", result.ReloadToWelcomeMs)
	fmt.Printf("Evidence: %s\n", directory)
	return nil
}

// writeConfig renders the shipped container Caddyfile with a local CA and a harness-only
// Compose override that selects the image, network, and a loopback port for direct probes.
func writeConfig(directory, image, network string) error {
	example, err := os.ReadFile(filepath.Join("deploy", "Caddyfile.container.example"))
	if err != nil {
		return err
	}
	if !strings.Contains(string(example), exampleHost) || !strings.Contains(string(example), exampleProxy) {
		return errors.New("deploy/Caddyfile.container.example no longer contains the expected site and upstream")
	}
	caddyfile := "{\n\tlocal_certs\n\tskip_install_trust\n}\n\n" + strings.ReplaceAll(string(example), exampleHost, publicHost)
	if err := os.WriteFile(filepath.Join(directory, "Caddyfile"), []byte(caddyfile), 0o644); err != nil {
		return err
	}
	override := fmt.Sprintf("services:\n  ovs:\n    image: %s\n    ports: !override [\"127.0.0.1::8080\"]\nnetworks:\n  proxy:\n    name: %s\n", image, network)
	return os.WriteFile(filepath.Join(directory, "override.yaml"), []byte(override), 0o600)
}

func caddyRoots(ctx context.Context, caddy string) (*x509.CertPool, error) {
	deadline := time.Now().Add(15 * time.Second)
	for {
		root, err := smoke.Docker(ctx, "exec", caddy, "cat", "/data/caddy/pki/authorities/local/root.crt")
		if err == nil {
			pool := x509.NewCertPool()
			if !pool.AppendCertsFromPEM([]byte(root)) {
				return nil, errors.New("Caddy local root is not a PEM certificate")
			}
			return pool, nil
		}
		if time.Now().After(deadline) {
			return nil, err
		}
		if err := pause(ctx, 250*time.Millisecond); err != nil {
			return nil, err
		}
	}
}

func get(ctx context.Context, client *http.Client, path string) (int, string, error) {
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, publicOrigin+path, nil)
	if err != nil {
		return 0, "", err
	}
	response, err := client.Do(r)
	if err != nil {
		return 0, "", err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	return response.StatusCode, string(body), err
}

func waitReady(ctx context.Context, client *http.Client) error {
	deadline := time.Now().Add(30 * time.Second)
	for {
		attempt, cancel := context.WithTimeout(ctx, 2*time.Second)
		code, _, err := get(attempt, client, "/health/ready")
		cancel()
		if err == nil && code == http.StatusNoContent {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("HTTPS readiness through Caddy: code=%d: %v", code, err)
		}
		if err := pause(ctx, 250*time.Millisecond); err != nil {
			return err
		}
	}
}

func checkPages(ctx context.Context, client *http.Client) (bool, error) {
	code, body, err := get(ctx, client, "/")
	if err != nil || code != 200 || !strings.Contains(body, `<div id="app">`) {
		return false, fmt.Errorf("SPA through Caddy: %d: %v", code, err)
	}
	code, body, err = get(ctx, client, "/userscripts/ovs-bilibili.user.js")
	scoped := strings.Contains(body, "@name OVS Bilibili "+publicOrigin) && strings.Contains(body, `const ORIGIN = "`+publicOrigin+`"`)
	if err != nil || code != 200 || !scoped {
		return false, fmt.Errorf("helper is not scoped to the HTTPS origin: %d: %v", code, err)
	}
	return true, nil
}

func checkReconnect(ctx context.Context, httpClient *http.Client, caddy string, result *summary) error {
	host := &smoke.Client{HTTP: httpClient, Base: publicOrigin, Host: publicHost, Origin: publicOrigin}
	if _, err := host.Bootstrap(ctx); err != nil {
		return err
	}
	result.SecureCookie = host.Cookie != nil && host.Cookie.Secure && host.Cookie.HttpOnly
	if !result.SecureCookie {
		return errors.New("HTTPS origin did not set a Secure HttpOnly session cookie")
	}
	value, err := host.Call(ctx, "POST", "/rooms", map[string]any{"title": "Proxy smoke", "settings": map[string]any{"controllers": "everyone", "waitForAll": false}})
	if err != nil {
		return err
	}
	var created rooms.Result
	raw, _ := json.Marshal(value)
	if err := json.Unmarshal(raw, &created); err != nil {
		return err
	}
	roomID := created.Snapshot.RoomID
	conn, err := host.Dial(ctx, roomID)
	if err != nil {
		return fmt.Errorf("room socket through Caddy: %w", err)
	}
	defer conn.CloseNow()
	snap, err := smoke.Welcome(ctx, conn)
	if err != nil {
		return err
	}
	epoch := snap.Epoch
	for _, intent := range []struct {
		kind    string
		payload map[string]any
	}{
		{"media.select", map[string]any{"media": contracts.MediaDescriptor{Kind: "bilibili", BVID: "BV1hf4y1N75G", CID: "400306737", Part: 1, DurationMs: 60000}}},
		{"playback.command", map[string]any{"action": "seek", "positionMs": 12000}},
		{"playback.command", map[string]any{"action": "play"}},
	} {
		accepted, err := smoke.Command(ctx, conn, snap, intent.kind, intent.payload)
		if err != nil || !accepted.Accepted {
			return fmt.Errorf("control through Caddy was not accepted: %v", err)
		}
		if snap, err = host.Snapshot(ctx, roomID); err != nil {
			return err
		}
	}
	if snap.Playback.Phase != "playing" {
		return errors.New("playback did not start through Caddy")
	}
	before := snap
	reloaded := time.Now()
	if _, err := smoke.Docker(ctx, "exec", caddy, "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile", "--force"); err != nil {
		return err
	}
	closed, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		if _, err := smoke.Next(closed, conn); err != nil {
			if closed.Err() != nil {
				return errors.New("Caddy reload did not close the room socket")
			}
			result.ReloadCloseCode = int(websocket.CloseStatus(err))
			break
		}
	}
	// Without stream_close_delay, unloading the old Caddy config closes streams with Going Away.
	if result.ReloadCloseCode != int(websocket.StatusGoingAway) {
		return fmt.Errorf("Caddy reload closed the room socket with %d, want 1001", result.ReloadCloseCode)
	}
	// With no connection left, the room pauses on its next tick; wait past it before redialing.
	if err := pause(ctx, 1500*time.Millisecond); err != nil {
		return err
	}
	again, err := host.Dial(ctx, roomID)
	if err != nil {
		return fmt.Errorf("room socket after Caddy reload: %w", err)
	}
	defer again.CloseNow()
	snap, err = smoke.Welcome(ctx, again)
	if err != nil {
		return err
	}
	result.ReloadToWelcomeMs = time.Since(reloaded).Milliseconds()
	result.SameEpochAfterReload = snap.Epoch == epoch
	result.PausedAfterReload = snap.Playback.Phase == "paused" && snap.Playback.PositionMs >= before.Playback.PositionMs && snap.Revision >= before.Revision
	if !result.SameEpochAfterReload || !result.PausedAfterReload {
		return fmt.Errorf("reconnect after reload: epoch kept=%t phase=%s position=%d revision=%d", result.SameEpochAfterReload, snap.Playback.Phase, snap.Playback.PositionMs, snap.Revision)
	}
	accepted, err := smoke.Command(ctx, again, snap, "playback.command", map[string]any{"action": "play"})
	if err != nil || !accepted.Accepted {
		return fmt.Errorf("play after reconnect was not accepted: %v", err)
	}
	return nil
}

// checkAddresses exhausts the bootstrap address bucket through Caddy with spoofed headers,
// then probes OVS directly from the same host. Both paths reach containers from the bridge
// gateway, so an immediate 429 shows that OVS keyed the proxied requests by the forwarded
// client and ignored both the spoofed hops and the untrusted direct peer's header.
func checkAddresses(ctx context.Context, httpClient *http.Client, directPort string, result *summary) error {
	probe := func(client *http.Client, base, spoofed string) (int, error) {
		r, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/api/v2/session", strings.NewReader("{}"))
		if err != nil {
			return 0, err
		}
		r.Host = publicHost
		r.Header.Set("Origin", publicOrigin)
		r.Header.Set("Content-Type", "text/plain")
		r.Header.Set("X-Forwarded-For", spoofed)
		response, err := client.Do(r)
		if err != nil {
			return 0, err
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, contracts.MaxMessageBytes))
		response.Body.Close()
		return response.StatusCode, nil
	}
	for i := range 12 {
		code, err := probe(httpClient, publicOrigin, fmt.Sprintf("203.0.113.%d", i+1))
		if err != nil {
			return err
		}
		if code == http.StatusTooManyRequests {
			result.ProxyProbesBeforeLimit = i
			break
		}
		if code != http.StatusUnsupportedMediaType || i == 11 {
			return fmt.Errorf("proxied probe %d returned %d", i, code)
		}
	}
	direct := &http.Client{Transport: &http.Transport{Proxy: nil}}
	defer direct.CloseIdleConnections()
	// The second probe absorbs at most one refilled token (0.5/s) between the two paths.
	for range 2 {
		code, err := probe(direct, "http://"+directPort, "198.51.100.77")
		if err != nil {
			return err
		}
		result.DirectProbeCodes = append(result.DirectProbeCodes, code)
		if code == http.StatusTooManyRequests {
			return nil
		}
	}
	return fmt.Errorf("direct probes %v did not share the proxied client's bucket", result.DirectProbeCodes)
}

func pause(ctx context.Context, d time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(d):
		return nil
	}
}
