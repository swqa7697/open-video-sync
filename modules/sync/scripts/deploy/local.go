package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type sshTarget struct {
	host    string
	options []string
}

func (s sshTarget) command(ctx context.Context, command string) *exec.Cmd {
	args := append([]string{"-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"}, s.options...)
	args = append(args, "--", s.host, command)
	return exec.CommandContext(ctx, "ssh", args...)
}

func (s sshTarget) output(ctx context.Context, command string) (string, error) {
	cmd := s.command(ctx, command)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	b, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("SSH: %w: %s", err, stderr.String())
	}
	return strings.TrimSpace(string(b)), nil
}

func (s sshTarget) upload(ctx context.Context, local, remote string, executable bool, p *progress) (err error) {
	f, err := os.Open(local)
	if err != nil {
		return err
	}
	defer f.Close()
	command := "umask 077; mkdir -p " + shellQuote(filepath.Dir(remote)) + " && cat > " + shellQuote(remote)
	if executable {
		command += " && chmod 700 " + shellQuote(remote)
	}
	cmd := s.command(ctx, command)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = f, os.Stderr, os.Stderr
	if p != nil {
		info, err := f.Stat()
		if err != nil {
			return err
		}
		transfer := p.transfer("Upload "+filepath.Base(local), info.Size())
		defer func() { transfer.finish(err) }()
		cmd.Stdin = transfer.reader(f)
	}
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("upload: %w", err)
	}
	return nil
}

type session struct {
	cmd      *exec.Cmd
	in       io.WriteCloser
	encoder  *json.Encoder
	decoder  *json.Decoder
	progress func(string)
}

func openSession(ctx context.Context, target sshTarget, helper, dir string) (*session, error) {
	// Remove the uniquely named bootstrap executable after the session exits.
	command := shellQuote(helper) + " remote " + shellQuote(dir) + "; result=$?; rm -f " + shellQuote(helper) + "; exit \"$result\""
	cmd := target.command(ctx, command)
	cmd.Stderr = os.Stderr
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		_ = in.Close()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = in.Close()
		return nil, err
	}
	return &session{cmd: cmd, in: in, encoder: json.NewEncoder(in), decoder: json.NewDecoder(out)}, nil
}

func (s *session) call(req request) (response, error) {
	var res response
	if err := s.encoder.Encode(req); err != nil {
		return res, err
	}
	for {
		res = response{}
		if err := s.decoder.Decode(&res); err != nil {
			return res, fmt.Errorf("remote helper connection: %w (check SSH output above)", err)
		}
		if res.Progress == "" {
			break
		}
		if s.progress != nil {
			s.progress(res.Progress)
		}
	}
	if res.Error != "" {
		return res, errors.New(res.Error)
	}
	return res, nil
}

func (s *session) close() { _ = s.in.Close(); _ = s.cmd.Wait() }

func runLocal(ctx context.Context, action string) error {
	return runTarget(ctx, action, sshTarget{host: os.Getenv("HOST")}, http.DefaultClient)
}

func runTarget(ctx context.Context, action string, target sshTarget, publicClient *http.Client) (err error) {
	if action != "deploy" && action != "status" && action != "logs" && action != "restart" && action != "stop" {
		return errors.New("unknown deploy action")
	}
	if err := validateHost(target.host); err != nil {
		return err
	}
	image := os.Getenv("IMAGE")
	if action == "deploy" && image == "" {
		return errors.New("IMAGE is required; use make deploy to select the application image tag")
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Minute)
	defer cancel()
	p := newProgress(action, target.host)
	defer func() { p.finish(err) }()
	p.begin("Check SSH and remote Docker")
	info, err := target.output(ctx, "docker info --format '{{.OSType}} {{.Architecture}}' && printf '%s\\n' \"$HOME\"")
	if err != nil {
		return err
	}
	lines := strings.Split(info, "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "linux ") || !filepath.IsAbs(lines[1]) {
		return errors.New("remote Docker must run Linux; unexpected Docker or login-shell output")
	}
	arch := strings.TrimPrefix(lines[0], "linux ")
	switch arch {
	case "x86_64", "amd64":
		arch = "amd64"
	case "aarch64", "arm64":
		arch = "arm64"
	default:
		return fmt.Errorf("unsupported remote architecture %q", arch)
	}
	p.note("Remote platform: linux/" + arch)
	p.begin("Prepare remote deployment directory")
	dir := os.Getenv("DEPLOY_DIR")
	if dir == "" {
		dir = filepath.Join(lines[1], ".local", "share", "ovs")
	}
	if !filepath.IsAbs(dir) || strings.ContainsAny(dir, "\r\n\x00,") {
		return errors.New("DEPLOY_DIR must be absolute and cannot contain newlines, NUL or commas")
	}
	// Canonicalize once so symlinked homes do not produce mismatched ownership labels.
	dir, err = target.output(ctx, "umask 077; mkdir -p "+shellQuote(dir)+" && cd "+shellQuote(dir)+" && pwd -P")
	if err != nil {
		return err
	}
	p.note(dir)
	if err := os.MkdirAll("/tmp/codex", 0o700); err != nil {
		return err
	}
	scratch, err := os.MkdirTemp("/tmp/codex", "ovs-deploy-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(scratch)
	helper := filepath.Join(scratch, "remote")
	p.begin("Build remote helper")
	build := exec.CommandContext(ctx, "go", "-C", "modules/sync", "build", "-trimpath", "-o", helper, "./scripts/deploy")
	build.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=linux", "GOARCH="+arch)
	build.Stdout, build.Stderr = os.Stderr, os.Stderr
	if err := build.Run(); err != nil {
		return fmt.Errorf("build remote helper: %w", err)
	}
	id := time.Now().UTC().Format("20060102t150405") + "-" + strings.ToLower(rand.Text()[:10])
	remoteHelper := filepath.Join(dir, "bin", "helper-"+id)
	p.begin("Upload remote helper")
	if err := target.upload(ctx, helper, remoteHelper, true, p); err != nil {
		return err
	}
	p.begin("Open remote management session")
	s, err := openSession(ctx, target, remoteHelper, dir)
	if err != nil {
		return err
	}
	defer s.close()
	s.progress = p.note
	if action != "deploy" {
		remoteAction := action
		if action == "logs" {
			remoteAction = "logs-info"
		}
		titles := map[string]string{"status": "Inspect remote deployment", "restart": "Restart OVS and wait for container health", "stop": "Stop managed services", "logs": "Prepare service logs"}
		p.begin(titles[action])
		res, err := s.call(request{Action: remoteAction})
		if action != "logs" && res.Text != "" {
			fmt.Println(res.Text)
		}
		if err != nil {
			return err
		}
		if action == "logs" {
			p.finish(nil)
			p.note("Following the last 100 service log lines; press Ctrl+C to stop.")
			// Release the management lock before following an unbounded log stream.
			_ = s.in.Close()
			cmd := target.command(ctx, res.Text)
			cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
			return cmd.Run()
		}
		if action == "status" || action == "restart" {
			p.begin("Verify public UI and readiness (up to 30s)")
			return waitPublic(ctx, res.Settings.URL, 30*time.Second, publicClient, os.Stdout)
		}
		return nil
	}
	input := settings{URL: os.Getenv("URL"), Proxy: os.Getenv("PROXY"), Network: os.Getenv("PROXY_NETWORK"), Trusted: os.Getenv("TRUSTED_PROXIES"), Subnet: os.Getenv("PROXY_SUBNET")}
	p.begin("Check remote settings, ownership, network and ports")
	prepared, err := s.call(request{Action: "prepare", Settings: input})
	if err != nil {
		return err
	}
	if prepared.Text != "" {
		fmt.Fprintln(os.Stderr, prepared.Text)
	}
	c := prepared.Settings
	p.note("Public URL: " + c.URL + " | Proxy: " + c.Proxy)
	p.begin("Prepare Docker Compose")
	if prepared.NeedCompose {
		artifact, digest, err := downloadCompose(ctx, arch, p)
		if err != nil {
			return err
		}
		name := "compose-upload-" + id
		if err := target.upload(ctx, artifact, filepath.Join(dir, "bin", name), false, p); err != nil {
			return err
		}
		if _, err := s.call(request{Action: "install-compose", Artifact: name, SHA256: digest}); err != nil {
			return err
		}
	} else {
		p.note("Reuse compatible remote Compose; download and installation skipped.")
	}
	c.Release, c.Image = id, image
	p.begin("Build OVS image for linux/" + arch)
	p.note("Image: " + c.Image)
	channel := os.Getenv("CHANNEL")
	if channel == "" {
		channel = "dev"
	}
	buildInfo, err := output(ctx, "node", "scripts/versions.mjs", "build-info")
	if err != nil {
		return fmt.Errorf("read build metadata: %w", err)
	}
	if err := runVisible(ctx, "docker", "buildx", "build", "--pull", "--load", "--platform", "linux/"+arch, "--build-arg", "CHANNEL="+channel, "--build-arg", "OVS_BUILD_INFO="+buildInfo, "-t", c.Image, "."); err != nil {
		return fmt.Errorf("build image: %w", err)
	}
	images := []string{c.Image}
	p.begin("Prepare Caddy image")
	if c.managedTLS() {
		if err := runVisible(ctx, "docker", "pull", "--platform", "linux/"+arch, caddyImage); err != nil {
			return err
		}
		images = append(images, caddyImage)
	} else {
		p.note("Managed HTTPS is disabled; Caddy image skipped.")
	}
	p.begin("Inspect local image IDs and content digests")
	if c.managedTLS() {
		c.CaddyID, c.CaddyContent, err = inspectImage(ctx, caddyImage, "linux/"+arch)
		if err != nil {
			return err
		}
	}
	c.ImageID, c.ImageContent, err = inspectImage(ctx, c.Image, "linux/"+arch)
	if err != nil {
		return err
	}
	p.begin("Stream images over SSH and load into remote Docker")
	if err := transferImages(ctx, target, images, "linux/"+arch, p); err != nil {
		return err
	}
	p.begin("Validate remote images and configuration, then activate release")
	activated, err := s.call(request{Action: "activate", Settings: c})
	if err != nil {
		return err
	}
	p.begin("Verify public UI and readiness (up to 5m, including HTTPS certificates)")
	if err := waitPublic(ctx, c.URL, 5*time.Minute, publicClient, os.Stdout); err != nil {
		return fmt.Errorf("public verification failed; containers and data remain available for diagnosis: %w", err)
	}
	p.begin("Record successful deployment")
	if _, err := s.call(request{Action: "commit"}); err != nil {
		return err
	}
	p.finish(nil)
	fmt.Printf("Deployed %s to %s\nRemote directory: %s\n", activated.Settings.Image, c.URL, dir)
	return nil
}

func runVisible(ctx context.Context, name string, args ...string) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdout, cmd.Stderr = os.Stderr, os.Stderr
	return cmd.Run()
}

func transferImages(ctx context.Context, target sshTarget, images []string, platform string, p *progress) (err error) {
	transferCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	save := exec.CommandContext(transferCtx, "docker", append([]string{"image", "save", "--platform", platform}, images...)...)
	pipe, err := save.StdoutPipe()
	if err != nil {
		return err
	}
	defer pipe.Close()
	save.Stderr = os.Stderr
	load := target.command(transferCtx, "docker image load --quiet")
	load.Stdin, load.Stdout, load.Stderr = pipe, os.Stderr, os.Stderr
	var loaded strings.Builder
	if p != nil {
		p.note("Archive size is unknown; bytes measure the local stream. Completion also waits for remote image loading.")
		transfer := p.transfer("Image stream", 0)
		defer func() {
			transfer.finish(err)
			if loaded.Len() > 0 {
				p.note(strings.TrimSpace(loaded.String()))
			}
		}()
		load.Stdin, load.Stdout = transfer.reader(pipe), &loaded
	}
	if err := save.Start(); err != nil {
		return err
	}
	if err := load.Start(); err != nil {
		cancel()
		_ = save.Wait()
		return err
	}
	loadErr := load.Wait()
	if loadErr != nil {
		cancel()
		_ = pipe.Close()
	}
	saveErr := save.Wait()
	if loadErr != nil {
		return fmt.Errorf("remote image load: %w", loadErr)
	}
	if saveErr != nil {
		return fmt.Errorf("local image save: %w", saveErr)
	}
	return nil
}

func downloadCompose(ctx context.Context, arch string, p *progress) (string, string, error) {
	assetArch := "x86_64"
	if arch == "arm64" {
		assetArch = "aarch64"
	}
	asset := "docker-compose-linux-" + assetArch
	base := "https://github.com/docker/compose/releases/download/" + composeVersion + "/"
	dir := filepath.Join(".misc", "deploy", "cache", composeVersion)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", "", err
	}
	checksumPath := filepath.Join(dir, asset+".sha256")
	checksum, err := os.ReadFile(checksumPath)
	if errors.Is(err, os.ErrNotExist) {
		if p != nil {
			p.note("Download official Compose SHA-256 checksum.")
		}
		checksum, err = fetch(ctx, base+asset+".sha256", 4096, nil)
		if err == nil {
			err = os.WriteFile(checksumPath, checksum, 0o600)
		}
	}
	if err != nil {
		return "", "", fmt.Errorf("download official Compose checksum: %w", err)
	}
	fields := strings.Fields(string(checksum))
	if len(fields) < 1 {
		return "", "", errors.New("empty Compose checksum")
	}
	digest, err := hex.DecodeString(fields[0])
	if err != nil || len(digest) != sha256.Size {
		return "", "", errors.New("invalid Compose SHA-256 checksum")
	}
	path := filepath.Join(dir, asset)
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if p != nil {
			p.note("Download Compose " + composeVersion + " for linux/" + arch + ".")
		}
		b, err = fetch(ctx, base+asset, 150<<20, p)
		if err == nil {
			h := sha256.Sum256(b)
			if hex.EncodeToString(h[:]) != fields[0] {
				return "", "", errors.New("Compose download checksum mismatch")
			}
			err = os.WriteFile(path, b, 0o600)
		}
	} else if err == nil && p != nil {
		p.note("Reuse cached Compose " + composeVersion + "; verify SHA-256 checksum.")
	}
	if err != nil {
		return "", "", err
	}
	h := sha256.Sum256(b)
	if hex.EncodeToString(h[:]) != fields[0] {
		return "", "", fmt.Errorf("cached Compose checksum mismatch; remove %s and retry", path)
	}
	return path, fields[0], nil
}

func fetch(ctx context.Context, address string, limit int64, p *progress) (b []byte, err error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, address, nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, fmt.Errorf("download returned HTTP %d", res.StatusCode)
	}
	var body io.Reader = res.Body
	if p != nil {
		transfer := p.transfer("Download Compose", res.ContentLength)
		defer func() { transfer.finish(err) }()
		body = transfer.reader(body)
	}
	b, err = io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errors.New("download exceeded size limit")
	}
	return b, nil
}

func waitPublic(ctx context.Context, origin string, timeout time.Duration, client *http.Client, out io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var last error
	for {
		last = checkPublic(ctx, origin, client, out)
		if last == nil {
			return nil
		}
		fmt.Fprintf(out, "Waiting for %s: %v\n", origin, last)
		timer := time.NewTimer(10 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return fmt.Errorf("endpoint verification timed out: %w", last)
		case <-timer.C:
		}
	}
}

func checkPublic(ctx context.Context, origin string, client *http.Client, out io.Writer) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	// Do not accept a redirect to a different service or a downgrade to HTTP.
	copyClient := *client
	copyClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	for _, endpoint := range []struct {
		path   string
		status int
	}{{"/health/ready", 204}, {"/", 200}} {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin+endpoint.path, nil)
		if err != nil {
			return err
		}
		res, err := copyClient.Do(req)
		if err != nil {
			return err
		}
		_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<20))
		_ = res.Body.Close()
		if res.StatusCode != endpoint.status {
			return fmt.Errorf("%s returned HTTP %d, expected %d", endpoint.path, res.StatusCode, endpoint.status)
		}
		if strings.HasPrefix(origin, "https://") {
			if res.TLS == nil || len(res.TLS.VerifiedChains) == 0 {
				return errors.New("HTTPS certificate has no verified trust chain")
			}
			if endpoint.path == "/" {
				fmt.Fprintf(out, "HTTPS certificate valid until %s\n", res.TLS.PeerCertificates[0].NotAfter.UTC().Format(time.RFC3339))
			}
		}
	}
	fmt.Fprintln(out, "Public UI and readiness checks passed.")
	return nil
}
