package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/modules/sync/internal/rooms"
	"github.com/swqa7697/open-video-sync/modules/sync/scripts/internal/smoke"
)

// TestRemoteHelper exists only in the test executable. No production environment
// variable or command-line flag enables internal certificates.
func TestRemoteHelper(t *testing.T) {
	mode := os.Getenv("OVS_TEST_REMOTE_HELPER")
	if mode == "" {
		return
	}
	dir := os.Args[len(os.Args)-1]
	render := func(c settings) string {
		if mode == "invalid" {
			return "this is not a Caddyfile {"
		}
		return "{\n local_certs\n skip_install_trust\n default_sni 8.8.8.8\n}\n" + c.URL + " {\n tls internal\n reverse_proxy ovs:8080\n}\n"
	}
	if err := serveWithCaddy(context.Background(), dir, os.Stdin, os.Stdout, render); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}

func TestDeploymentSmoke(t *testing.T) {
	if os.Getenv("OVS_DEPLOY_SMOKE") != "1" {
		t.Skip("requires make deploy-smoke: Docker with privileged containers, SSH tools and prepared application/Caddy images")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 9*time.Minute)
	defer cancel()
	root, err := filepath.Abs("../../../..")
	if err != nil {
		t.Fatal(err)
	}
	name := "ovs-deploy-smoke-" + strings.ToLower(rand.Text()[:10])
	dir := filepath.Join(root, ".misc", "deploy-smoke", name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Logf("Evidence: %s", dir)
	run := func(program string, args ...string) string {
		t.Helper()
		result, err := output(ctx, program, args...)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	docker := func(args ...string) string { t.Helper(); return run("docker", args...) }
	for _, key := range []string{"client", "host"} {
		run("ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", filepath.Join(dir, key))
	}
	// Build the SSH fixture separately from production images. Its Docker daemon
	// owns an isolated data directory; the host Docker socket is never mounted.
	docker("build", "-t", "ovs-deploy-fixture:dev", "testdata")
	docker("run", "-d", "--privileged", "--name", name, "-v", dir+":/fixture:ro", "-p", "127.0.0.1::22", "-p", "127.0.0.1::8080", "-p", "127.0.0.1::443", "ovs-deploy-fixture:dev")
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 30*time.Second)
		defer stop()
		logs, _ := output(cleanup, "docker", "logs", name)
		_ = os.WriteFile(filepath.Join(dir, "fixture.log"), []byte(logs), 0o600)
		_, _ = output(cleanup, "docker", "rm", "-fv", name)
		// Do not retain synthetic private keys after the fixture is removed.
		_ = os.Remove(filepath.Join(dir, "client"))
		_ = os.Remove(filepath.Join(dir, "host"))
	})
	sshAddr := docker("port", name, "22/tcp")
	_, sshPort, _ := net.SplitHostPort(sshAddr)
	hostKey, err := os.ReadFile(filepath.Join(dir, "host.pub"))
	if err != nil {
		t.Fatal(err)
	}
	known := filepath.Join(dir, "known_hosts")
	if err := os.WriteFile(known, []byte("[127.0.0.1]:"+sshPort+" "+string(hostKey)), 0o600); err != nil {
		t.Fatal(err)
	}
	target := sshTarget{host: "root@127.0.0.1", options: []string{"-F", "/dev/null", "-p", sshPort, "-i", filepath.Join(dir, "client"), "-o", "UserKnownHostsFile=" + known, "-o", "StrictHostKeyChecking=yes"}}
	deadline := time.Now().Add(45 * time.Second)
	for {
		if _, err := target.output(ctx, "docker info >/dev/null"); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("isolated SSH/Docker fixture did not start")
		}
		time.Sleep(time.Second)
	}
	if _, err := target.output(ctx, "docker compose version"); err == nil {
		t.Fatal("fixture unexpectedly includes Compose")
	}
	remoteDir := "/root/.local/share/ovs"
	helper := filepath.Join(dir, "helper")
	cmd := exec.CommandContext(ctx, "go", "build", "-o", helper, ".")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=linux", "GOARCH="+runtime.GOARCH)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build helper: %v %s", err, b)
	}
	testHelper := filepath.Join(dir, "test-helper")
	cmd = exec.CommandContext(ctx, "go", "test", "-c", "-o", testHelper, ".")
	cmd.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=linux", "GOARCH="+runtime.GOARCH)
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build test helper: %v %s", err, b)
	}
	if err := target.upload(ctx, helper, remoteDir+"/bin/helper", true); err != nil {
		t.Fatal(err)
	}
	if err := target.upload(ctx, testHelper, remoteDir+"/bin/test-helper", true); err != nil {
		t.Fatal(err)
	}
	open := func(mode string) *session {
		t.Helper()
		command := shellQuote(remoteDir+"/bin/helper") + " remote " + shellQuote(remoteDir)
		if mode != "" {
			command = "OVS_TEST_REMOTE_HELPER=" + shellQuote(mode) + " " + shellQuote(remoteDir+"/bin/test-helper") + " -test.run=TestRemoteHelper -- " + shellQuote(remoteDir)
		}
		cmd := target.command(ctx, command)
		cmd.Stderr = os.Stderr
		in, err := cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
		out, err := cmd.StdoutPipe()
		if err != nil {
			t.Fatal(err)
		}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		return &session{cmd: cmd, in: in, encoder: json.NewEncoder(in), decoder: json.NewDecoder(out)}
	}
	s := open("")
	call := func(req request) response {
		t.Helper()
		res, err := s.call(req)
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	prepared := call(request{Action: "prepare", Settings: settings{URL: "http://127.0.0.1:8080"}})
	if !prepared.NeedCompose {
		t.Fatal("missing Compose was not detected")
	}
	// downloadCompose caches under the repository, not inside the package.
	oldDir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	artifact, digest, downloadErr := downloadCompose(ctx, runtime.GOARCH)
	artifact, _ = filepath.Abs(artifact)
	if err := os.Chdir(oldDir); err != nil {
		t.Fatal(err)
	}
	if downloadErr != nil {
		t.Fatal(downloadErr)
	}
	if err := target.upload(ctx, artifact, remoteDir+"/bin/compose-upload-test", false); err != nil {
		t.Fatal(err)
	}
	call(request{Action: "install-compose", Artifact: "compose-upload-test", SHA256: digest})
	baseImage, err := smoke.ApplicationImage(filepath.Join(root, "versions.toml"))
	if err != nil {
		t.Fatal(err)
	}
	image := "ovs:deploy-" + name
	docker("tag", baseImage, image)
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		_, _ = output(cleanup, "docker", "image", "rm", image)
	})
	if err := transferImages(ctx, target, []string{image, caddyImage}, "linux/"+runtime.GOARCH); err != nil {
		t.Fatal(err)
	}
	// Validate the actual production ACME configuration without starting Caddy
	// or contacting any public issuer, including the IPv6 site-address syntax.
	for _, origin := range []string{"https://8.8.8.8", "https://[2606:4700:4700::1111]", "https://watch.example.com"} {
		config, err := mergeSettings(settings{}, settings{URL: origin})
		if err != nil {
			t.Fatal(err)
		}
		file := filepath.Join(dir, "Caddyfile-public")
		if err := os.WriteFile(file, []byte(caddyConfig(config)), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := target.output(ctx, "docker run --rm --network none --mount type=bind,src=/fixture/Caddyfile-public,dst=/check/Caddyfile,readonly "+shellQuote(caddyImage)+" caddy validate --config /check/Caddyfile --adapter caddyfile"); err != nil {
			t.Fatal("production ACME configuration:", err)
		}
	}
	c := prepared.Settings
	c.Image, c.Release = image, "first"
	c.ImageID, c.ImageContent, err = inspectImage(ctx, image, "linux/"+runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	c.CaddyID, c.CaddyContent, err = inspectImage(ctx, caddyImage, "linux/"+runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	call(request{Action: "activate", Settings: c})
	call(request{Action: "commit"})
	address := docker("port", name, "8080/tcp")
	transport := &http.Transport{DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, address)
	}}
	httpClient := &http.Client{Transport: transport}
	defer httpClient.CloseIdleConnections()
	if err := checkPublic(ctx, c.URL, httpClient, io.Discard); err != nil {
		t.Fatal(err)
	}
	client := &smoke.Client{HTTP: httpClient, Base: c.URL, Host: "127.0.0.1:8080", Origin: c.URL}
	identity, err := client.Bootstrap(ctx)
	if err != nil {
		t.Fatal(err)
	}
	room, err := client.Call(ctx, "POST", "/rooms", map[string]any{"title": "Deployment persistence", "settings": map[string]any{"controllers": "everyone", "waitForAll": false}, "media": map[string]any{"kind": "bilibili", "bvid": "BV1hf4y1N75G", "cid": "1", "part": 1, "durationMs": 100000}})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(room)
	var created rooms.Result
	if err := json.Unmarshal(b, &created); err != nil {
		t.Fatal(err)
	}
	// Incomplete image transfer must leave both serving state and active release intact.
	call(request{Action: "prepare"})
	bad := c
	bad.ImageContent = "sha256:wrong"
	bad.Release = "failed-transfer"
	if _, err := s.call(request{Action: "activate", Settings: bad}); err == nil {
		t.Fatal("wrong transferred image accepted")
	}
	if got := call(request{Action: "status"}).Settings.Release; got != "first" {
		t.Fatalf("failed prepare replaced %s", got)
	}
	if _, err := s.call(request{Action: "prepare", Settings: settings{Subnet: "172.31.0.0/24"}}); err == nil {
		t.Fatal("live deployment network was silently changed")
	}
	if _, _, err := client.Me(ctx); err != nil {
		t.Fatal("failed transfer disrupted application:", err)
	}
	c.Release = "second"
	call(request{Action: "activate", Settings: c})
	call(request{Action: "commit"})
	if got, _, err := client.Me(ctx); err != nil || got != identity {
		t.Fatalf("identity lost after deployment: %v", err)
	}
	if _, err := client.Snapshot(ctx, created.Snapshot.RoomID); err != nil {
		t.Fatal("room lost after deployment:", err)
	}
	s.close()
	// Exercise the actual local orchestration as well as the remote protocol.
	// Only public endpoint dialing and SSH config are redirected to the fixture.
	t.Setenv("DEPLOY_DIR", remoteDir)
	for _, key := range []string{"URL", "PROXY", "PROXY_NETWORK", "TRUSTED_PROXIES", "PROXY_SUBNET"} {
		t.Setenv(key, "")
	}
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	deployErr := runTarget(ctx, "deploy", target, httpClient)
	if deployErr == nil {
		deployErr = runTarget(ctx, "status", target, httpClient)
	}
	if err := os.Chdir(oldDir); err != nil {
		t.Fatal(err)
	}
	if deployErr != nil {
		t.Fatal("full local deployment flow:", deployErr)
	}
	if got, _, err := client.Me(ctx); err != nil || got != identity {
		t.Fatalf("full deployment lost identity: %v", err)
	}
	s = open("")
	fullImage := call(request{Action: "status"}).Settings.Image
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), 15*time.Second)
		defer stop()
		_, _ = output(cleanup, "docker", "image", "rm", fullImage)
	})
	call(request{Action: "stop"})
	if _, err := s.call(request{Action: "status"}); err == nil {
		t.Fatal("stopped service reported healthy")
	}
	call(request{Action: "restart"})
	if got, _, err := client.Me(ctx); err != nil || got != identity {
		t.Fatalf("identity lost after restart: %v", err)
	}
	s.close()
	// A malformed Caddy configuration is rejected before stopping existing HTTP.
	s = open("invalid")
	prepared = call(request{Action: "prepare", Settings: settings{URL: "https://8.8.8.8"}})
	c.URL, c.Release = prepared.Settings.URL, "invalid-caddy"
	if _, err := s.call(request{Action: "activate", Settings: c}); err == nil {
		t.Fatal("invalid Caddy configuration accepted")
	}
	if err := checkPublic(ctx, "http://127.0.0.1:8080", httpClient, io.Discard); err != nil {
		t.Fatal("invalid Caddy configuration stopped old service:", err)
	}
	s.close()
	// Only the test executable substitutes a local CA. The IP never receives a
	// network request: the test transport dials the isolated fixture's mapped port.
	s = open("internal")
	defer s.close()
	call(request{Action: "prepare", Settings: settings{URL: "https://8.8.8.8"}})
	c.Release = "https"
	call(request{Action: "activate", Settings: c})
	remoteExec := func(command string) string {
		t.Helper()
		value, err := target.output(ctx, command)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	caddy := remoteExec("docker ps -q --filter label=com.docker.compose.service=caddy")
	var pem string
	deadline = time.Now().Add(20 * time.Second)
	for {
		pem, err = target.output(ctx, "docker exec "+shellQuote(caddy)+" cat /data/caddy/pki/authorities/local/root.crt")
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal(err)
		}
		time.Sleep(time.Second)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM([]byte(pem)) {
		t.Fatal("invalid fixture CA")
	}
	tlsAddress := docker("port", name, "443/tcp")
	tlsTransport := &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}, DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, tlsAddress)
	}}
	tlsClient := &http.Client{Transport: tlsTransport}
	defer tlsClient.CloseIdleConnections()
	if err := waitPublic(ctx, c.URL, 20*time.Second, tlsClient, io.Discard); err != nil {
		t.Fatal("IP HTTPS without SNI:", err)
	}
	client.HTTP, client.Base, client.Host, client.Origin = tlsClient, c.URL, "8.8.8.8", c.URL
	if got, _, err := client.Me(ctx); err != nil || got != identity {
		t.Fatalf("identity lost through Caddy: %v", err)
	}
	conn, err := client.Dial(ctx, created.Snapshot.RoomID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := smoke.Welcome(ctx, conn); err != nil {
		t.Fatal(err)
	}
	_ = conn.CloseNow()
	call(request{Action: "commit"})
	call(request{Action: "status"})
	if err := os.WriteFile(filepath.Join(dir, "summary.json"), []byte(`{"ssh":true,"composeBootstrap":true,"imageTransfer":true,"httpUpdatePersistence":true,"failedPreparePreservesService":true,"stopRestart":true,"testCAIPWithoutSNI":true,"websocket":true,"publicACME":"unverified"}`), 0o600); err != nil {
		t.Fatal(err)
	}
}
