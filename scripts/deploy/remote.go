package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/gofrs/flock"
)

type request struct {
	Action   string
	Settings settings
	Artifact string
	SHA256   string
}

type response struct {
	Error       string
	Settings    settings
	NeedCompose bool
	Text        string
	Progress    string `json:",omitempty"`
}

type remote struct {
	ctx         context.Context
	dir         string
	compose     []string
	pending     settings
	renderCaddy func(settings) string
	report      func(string)
}

func (r *remote) progress(message string) {
	if r.report != nil {
		r.report(message)
	}
}

func output(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	b, err := cmd.CombinedOutput()
	if err != nil {
		if len(b) > 8192 {
			b = b[len(b)-8192:]
		}
		return "", fmt.Errorf("%s: %w: %s", name, err, b)
	}
	return strings.TrimSpace(string(b)), nil
}

func (r *remote) docker(args ...string) (string, error) { return output(r.ctx, "docker", args...) }
func (r *remote) composeRun(c settings, args ...string) (string, error) {
	a := append([]string{}, r.compose[1:]...)
	a = append(a, "-p", project, "-f", filepath.Join(r.dir, "releases", c.Release, "compose.json"))
	a = append(a, args...)
	return output(r.ctx, r.compose[0], a...)
}

func compatibleCompose(v string) bool {
	parts := strings.Split(strings.TrimPrefix(strings.TrimSpace(v), "v"), ".")
	if len(parts) < 2 {
		return false
	}
	major, _ := strconv.Atoi(parts[0])
	minor, _ := strconv.Atoi(parts[1])
	return major > 2 || major == 2 && minor >= 24
}

func (r *remote) findCompose() bool {
	for _, command := range [][]string{{"docker", "compose"}, {filepath.Join(r.dir, "bin", "docker-compose")}} {
		args := append(append([]string{}, command[1:]...), "version", "--short")
		v, err := output(r.ctx, command[0], args...)
		if err == nil && compatibleCompose(v) {
			r.compose = command
			return true
		}
	}
	return false
}

func readSettings(path string) (settings, error) {
	var c settings
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("read deployment state: %w", err)
	}
	if c.Release != "" && !safeName.MatchString(c.Release) {
		return c, errors.New("invalid saved release")
	}
	return c, nil
}

func writeJSON(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(path+".new", append(b, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(path+".new", path)
}

func serve(ctx context.Context, dir string, in io.Reader, out io.Writer) error {
	return serveWithCaddy(ctx, dir, in, out, caddyConfig)
}

func serveWithCaddy(ctx context.Context, dir string, in io.Reader, out io.Writer, render func(settings) string) error {
	var err error
	dir, err = filepath.Abs(dir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	dir, err = filepath.EvalSymlinks(dir)
	if err != nil {
		return err
	}
	lock := flock.New(filepath.Join(dir, ".deploy.lock"))
	ok, err := lock.TryLock()
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("another deployment or management operation holds this directory lock")
	}
	defer lock.Close()
	r := &remote{ctx: ctx, dir: dir, renderCaddy: render}
	decoder, encoder := json.NewDecoder(in), json.NewEncoder(out)
	r.report = func(message string) {
		// A failed event write is reported by the final response write. Progress
		// must never change the outcome of a deployment operation.
		_ = encoder.Encode(response{Progress: message})
	}
	for {
		var req request
		if err := decoder.Decode(&req); errors.Is(err, io.EOF) {
			return nil
		} else if err != nil {
			return err
		}
		res, err := r.handle(req)
		if err != nil {
			res.Error = err.Error()
		}
		if err := encoder.Encode(res); err != nil {
			return err
		}
	}
}

func (r *remote) handle(req request) (response, error) {
	var res response
	saved, err := readSettings(filepath.Join(r.dir, "active.json"))
	if err != nil {
		return res, err
	}
	switch req.Action {
	case "prepare":
		r.progress("Read saved settings and validate deployment configuration.")
		c, err := mergeSettings(saved, req.Settings)
		if err != nil {
			return res, err
		}
		r.progress("Check deployment ownership and existing containers.")
		if err := r.checkOwnership(true); err != nil {
			return res, err
		}
		r.progress("Check proxy network, subnet and published ports.")
		if err := r.preflight(c); err != nil {
			return res, err
		}
		r.pending = c
		r.progress("Detect a compatible Docker Compose installation.")
		res.Settings, res.NeedCompose = c, !r.findCompose()
		if saved.URL != "" && saved.URL != c.URL {
			res.Text = "Public origin changes browser identity, invitations and helper installation scope."
		}
	case "install-compose":
		if err := r.installCompose(req.Artifact, req.SHA256); err != nil {
			return res, err
		}
	case "activate":
		if r.pending.URL == "" {
			return res, errors.New("prepare must succeed before activation")
		}
		c := r.pending
		c.Image, c.ImageID, c.CaddyID, c.Release = req.Settings.Image, req.Settings.ImageID, req.Settings.CaddyID, req.Settings.Release
		c.ImageContent, c.CaddyContent = req.Settings.ImageContent, req.Settings.CaddyContent
		if err := r.activate(c, saved); err != nil {
			return res, err
		}
		res.Settings, err = readSettings(filepath.Join(r.dir, "active.json"))
		if err != nil {
			return res, err
		}
	case "commit":
		if saved.Release == "" {
			return res, errors.New("no active deployment")
		}
		r.progress("Save successful release metadata.")
		if err := writeJSON(filepath.Join(r.dir, "successful.json"), saved); err != nil {
			return res, err
		}
	case "status", "stop", "restart", "logs-info":
		if saved.Release == "" {
			return res, errors.New("no managed deployment in this directory")
		}
		r.progress("Check deployment ownership and Docker Compose.")
		if err := r.checkOwnership(false); err != nil {
			return res, err
		}
		if !r.findCompose() {
			return res, errors.New("Compose unavailable; run deploy to prepare it")
		}
		res.Settings = saved
		switch req.Action {
		case "status":
			r.progress("Inspect containers, running image digests and application version.")
			res.Text, err = r.status(saved)
		case "stop":
			r.progress("Stop managed containers (15s shutdown timeout); preserve volumes.")
			res.Text, err = r.composeRun(saved, "stop", "--timeout", "15")
		case "restart":
			r.progress("Restart OVS (15s shutdown timeout).")
			res.Text, err = r.composeRun(saved, "restart", "--timeout", "15", "ovs")
			if err == nil {
				r.progress("Wait for OVS container health (up to 90s).")
				_, err = r.composeRun(saved, "up", "-d", "--wait", "--wait-timeout", "90", "--no-build", "--pull", "never", "ovs")
			}
		case "logs-info":
			args := append(append([]string{}, r.compose...), "-p", project, "-f", filepath.Join(r.dir, "releases", saved.Release, "compose.json"), "logs", "--follow", "--tail", "100", "--no-color")
			for i := range args {
				args[i] = shellQuote(args[i])
			}
			res.Text = strings.Join(args, " ")
		}
		if err != nil {
			return res, err
		}
	default:
		return res, errors.New("unknown remote operation")
	}
	return res, nil
}

func (r *remote) volumeExists(name string) (bool, error) {
	list, err := r.docker("volume", "ls", "--format", "{{.Name}}")
	if err != nil {
		return false, err
	}
	for _, v := range strings.Fields(list) {
		if v == name {
			return true, nil
		}
	}
	return false, nil
}

func (r *remote) checkOwnership(create bool) error {
	exists, err := r.volumeExists(ownerVolume)
	if err != nil {
		return err
	}
	if !exists {
		if !create {
			return errors.New("deployment ownership volume missing; refusing to adopt existing data")
		}
		for _, name := range []string{dataVolume, "ovs-managed-caddy-data", "ovs-managed-caddy-config", "ovs_ovs-data", "deploy_ovs-data"} {
			present, err := r.volumeExists(name)
			if err != nil {
				return err
			}
			if present {
				return fmt.Errorf("existing volume %s needs an explicit manual migration; no data was adopted", name)
			}
		}
		if err := r.checkContainers(); err != nil {
			return err
		}
		if _, err := r.docker("volume", "create", "--label", ownerLabel+"="+r.dir, ownerVolume); err != nil {
			return err
		}
	}
	label, err := r.docker("volume", "inspect", "--format", "{{index .Labels \""+ownerLabel+"\"}}", ownerVolume)
	if err != nil {
		return err
	}
	if label != r.dir {
		return fmt.Errorf("this Docker engine belongs to deployment directory %q; use that DEPLOY_DIR", label)
	}
	return r.checkContainers()
}

type containerInfo struct {
	ID     string
	Image  string
	Config struct {
		Labels     map[string]string
		Entrypoint []string
	}
	State struct {
		Running bool
		Health  *struct{ Status string }
	}
	HostConfig struct {
		PortBindings map[string][]struct{ HostIp, HostPort string }
	}
}

func (r *remote) containers() ([]containerInfo, error) {
	ids, err := r.docker("ps", "-aq")
	if err != nil {
		return nil, err
	}
	if ids == "" {
		return nil, nil
	}
	b, err := r.docker(append([]string{"inspect"}, strings.Fields(ids)...)...)
	if err != nil {
		return nil, err
	}
	var list []containerInfo
	err = json.Unmarshal([]byte(b), &list)
	return list, err
}

func (r *remote) checkContainers() error {
	list, err := r.containers()
	if err != nil {
		return err
	}
	for _, c := range list {
		ovs := len(c.Config.Entrypoint) > 0 && c.Config.Entrypoint[0] == "/ovs"
		if (ovs || c.Config.Labels["com.docker.compose.project"] == project) && c.Config.Labels[ownerLabel] != r.dir {
			return errors.New("unmanaged OVS containers exist; stop and migrate the old installation explicitly before using remote deployment")
		}
	}
	return nil
}

type networkInfo struct {
	Name   string
	Labels map[string]string
	IPAM   struct {
		Config []struct{ Subnet, Gateway string }
	}
}

func (r *remote) networks() ([]networkInfo, error) {
	ids, err := r.docker("network", "ls", "-q")
	if err != nil {
		return nil, err
	}
	if ids == "" {
		return nil, nil
	}
	b, err := r.docker(append([]string{"network", "inspect"}, strings.Fields(ids)...)...)
	if err != nil {
		return nil, err
	}
	var list []networkInfo
	err = json.Unmarshal([]byte(b), &list)
	return list, err
}

func (r *remote) preflight(c settings) error {
	if err := r.checkContainers(); err != nil {
		return err
	}
	list, err := r.networks()
	if err != nil {
		return err
	}
	if c.Network != "" {
		for _, n := range list {
			if n.Name == c.Network {
				return nil
			}
		}
		return errors.New("PROXY_NETWORK does not exist")
	}
	want, _ := netip.ParsePrefix(c.Subnet)
	owned := false
	for _, n := range list {
		if n.Name == managedNetwork {
			if n.Labels[ownerLabel] != r.dir {
				return errors.New("managed network name is occupied by another installation")
			}
			owned = true
			if len(n.IPAM.Config) != 1 || n.IPAM.Config[0].Subnet != c.Subnet {
				return errors.New("PROXY_SUBNET cannot change while the deployment network exists")
			}
			continue
		}
		for _, entry := range n.IPAM.Config {
			p, err := netip.ParsePrefix(entry.Subnet)
			if err == nil && p.Overlaps(want) {
				return fmt.Errorf("PROXY_SUBNET overlaps Docker network %s; select another private /24", n.Name)
			}
		}
	}
	if !owned {
		addresses, err := net.InterfaceAddrs()
		if err != nil {
			return err
		}
		for _, a := range addresses {
			p, err := netip.ParsePrefix(a.String())
			if err == nil && p.Overlaps(want) {
				return errors.New("PROXY_SUBNET overlaps a host interface; select another private /24")
			}
		}
	}
	ports := []string{c.port()}
	if c.managedTLS() {
		ports = []string{"80", "443"}
	}
	containers, err := r.containers()
	if err != nil {
		return err
	}
	for _, port := range ports {
		ours := false
		for _, item := range containers {
			if !item.State.Running {
				continue
			}
			for key, bindings := range item.HostConfig.PortBindings {
				if !strings.HasSuffix(key, "/tcp") {
					continue
				}
				for _, b := range bindings {
					if b.HostPort == port {
						if item.Config.Labels[ownerLabel] != r.dir {
							return fmt.Errorf("TCP port %s is used by another container; use PROXY=external or another HTTP port", port)
						}
						ours = true
					}
				}
			}
		}
		if ours {
			continue
		}
		bind := ":" + port
		if c.Proxy == "external" {
			bind = "127.0.0.1:" + port
		}
		listener, err := net.Listen("tcp", bind)
		if err != nil {
			// Docker may publish privileged ports even when the SSH user cannot bind
			// them. Inspect Linux listeners in that case; Docker remains authoritative
			// about permission and races when it starts the container.
			if errors.Is(err, os.ErrPermission) {
				busy, scanErr := tcpListening(port)
				if scanErr != nil {
					return scanErr
				}
				if !busy {
					continue
				}
			}
			return fmt.Errorf("TCP port %s is unavailable: %w", port, err)
		}
		_ = listener.Close()
	}
	return nil
}

func tcpListening(port string) (bool, error) {
	n, _ := strconv.Atoi(port)
	for _, file := range []string{"/proc/net/tcp", "/proc/net/tcp6"} {
		b, err := os.ReadFile(file)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return false, err
		}
		for _, line := range strings.Split(string(b), "\n") {
			fields := strings.Fields(line)
			if len(fields) < 4 || fields[3] != "0A" {
				continue
			}
			_, p, found := strings.Cut(fields[1], ":")
			value, err := strconv.ParseInt(p, 16, 32)
			if found && err == nil && value == int64(n) {
				return true, nil
			}
		}
	}
	return false, nil
}

func (r *remote) ensureResources(c *settings) error {
	for _, name := range []string{dataVolume, "ovs-managed-caddy-data", "ovs-managed-caddy-config"} {
		if name != dataVolume && !c.managedTLS() {
			continue
		}
		exists, err := r.volumeExists(name)
		if err != nil {
			return err
		}
		if !exists {
			if _, err := r.docker("volume", "create", "--label", ownerLabel+"="+r.dir, name); err != nil {
				return err
			}
		}
		label, err := r.docker("volume", "inspect", "--format", "{{index .Labels \""+ownerLabel+"\"}}", name)
		if err != nil {
			return err
		}
		if label != r.dir {
			return fmt.Errorf("volume %s is not owned by this deployment", name)
		}
	}
	if c.Network != "" {
		return nil
	}
	list, err := r.networks()
	if err != nil {
		return err
	}
	found := false
	for _, n := range list {
		if n.Name == managedNetwork {
			found = true
		}
	}
	if !found {
		p, _ := netip.ParsePrefix(c.Subnet)
		octets := p.Addr().As4()
		octets[3] = 128
		if _, err := r.docker("network", "create", "--label", ownerLabel+"="+r.dir, "--subnet", c.Subnet, "--ip-range", netip.PrefixFrom(netip.AddrFrom4(octets), 25).String(), managedNetwork); err != nil {
			return err
		}
	}
	if c.Proxy == "external" {
		gateway, err := r.docker("network", "inspect", "--format", "{{(index .IPAM.Config 0).Gateway}}", managedNetwork)
		if err != nil {
			return err
		}
		if c.Trusted == "" {
			c.Trusted = gateway + "/32"
		}
	}
	return nil
}

func (r *remote) activate(c, previous settings) error {
	if !safeName.MatchString(c.Release) || c.Image == "" || strings.HasPrefix(c.Image, "-") || strings.ContainsAny(c.Image, " \n\r\t$\x00") {
		return errors.New("invalid release image or identifier")
	}
	if !r.findCompose() {
		return errors.New("Compose is not prepared")
	}
	r.progress("Verify transferred image configuration and layer digests.")
	for _, image := range []struct{ name, content string }{{c.Image, c.ImageContent}, {caddyImage, c.CaddyContent}} {
		if image.name == caddyImage && !c.managedTLS() {
			continue
		}
		id, content, err := inspectImage(r.ctx, image.name, "")
		if err != nil {
			return fmt.Errorf("image transfer incomplete: %w", err)
		}
		if content != image.content || id == "" {
			return fmt.Errorf("image content mismatch for %s", image.name)
		}
		if image.name == c.Image {
			c.ImageID = id
		} else {
			c.CaddyID = id
		}
	}
	r.progress("Recheck network and ports before activation.")
	if err := r.preflight(c); err != nil {
		return err
	}
	r.progress("Prepare persistent volumes and deployment network.")
	if err := r.ensureResources(&c); err != nil {
		return err
	}
	r.progress("Write release configuration and validate Docker Compose.")
	releaseDir := filepath.Join(r.dir, "releases", c.Release)
	if err := os.MkdirAll(releaseDir, 0o700); err != nil {
		return err
	}
	b, err := composeConfig(c, r.dir)
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(releaseDir, "compose.json"), b, 0o600); err != nil {
		return err
	}
	if _, err := r.composeRun(c, "config", "--quiet"); err != nil {
		return fmt.Errorf("Compose configuration: %w", err)
	}
	if c.managedTLS() {
		r.progress("Validate Caddy configuration without contacting a certificate authority.")
		if err := os.WriteFile(filepath.Join(releaseDir, "Caddyfile"), []byte(r.renderCaddy(c)), 0o600); err != nil {
			return err
		}
		if _, err := r.docker("run", "--rm", "--network", "none", "--entrypoint", "caddy", "--mount", "type=bind,src="+releaseDir+",dst=/config-check,readonly", caddyImage, "validate", "--config", "/config-check/Caddyfile", "--adapter", "caddyfile"); err != nil {
			return fmt.Errorf("Caddy configuration: %w", err)
		}
	}
	// Everything above is preparatory. From here, a failed start needs operator repair,
	// never an automatic downgrade of a database that may have been migrated.
	r.progress("Record the active release.")
	if err := writeJSON(filepath.Join(r.dir, "active.json"), c); err != nil {
		return err
	}
	if previous.Release != "" {
		r.progress("Stop previous OVS container (15s shutdown timeout).")
		if _, err := r.composeRun(previous, "stop", "--timeout", "15", "ovs"); err != nil {
			return err
		}
		if previous.managedTLS() && !c.managedTLS() {
			r.progress("Stop previous managed Caddy container (15s shutdown timeout).")
			if _, err := r.composeRun(previous, "stop", "--timeout", "15", "caddy"); err != nil {
				return err
			}
		}
	}
	r.progress("Prepare the database with the verified release image.")
	if _, err := r.docker("run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--no-healthcheck", "--mount", "type=volume,src="+dataVolume+",dst=/data", "--entrypoint", "/ovs", c.ImageID, "migrate"); err != nil {
		return fmt.Errorf("database migration failed; attempted release recorded in active.json, data preserved and OVS not started: %w", err)
	}
	r.progress("Start release containers and wait for health (up to 90s).")
	if _, err := r.composeRun(c, "up", "-d", "--wait", "--wait-timeout", "90", "--no-build", "--pull", "never", "--remove-orphans"); err != nil {
		return fmt.Errorf("container startup failed; attempted release recorded in active.json, data preserved: %w", err)
	}
	return nil
}

func (r *remote) status(c settings) (string, error) {
	list, err := r.containers()
	if err != nil {
		return "", err
	}
	states := map[string]string{}
	var imageErr error
	for _, item := range list {
		if item.Config.Labels[ownerLabel] != r.dir {
			continue
		}
		state := "stopped"
		if item.State.Running {
			state = "running"
		}
		if item.State.Running && item.State.Health != nil {
			state = item.State.Health.Status
		}
		states[item.Config.Labels["com.docker.compose.service"]] = state
		if item.State.Running {
			service := item.Config.Labels["com.docker.compose.service"]
			expected := c.ImageContent
			if service == "caddy" {
				expected = c.CaddyContent
			}
			if service == "ovs" || service == "caddy" && c.managedTLS() {
				_, digest, err := inspectImage(r.ctx, item.Image, "")
				if err != nil {
					imageErr = err
				} else if digest != expected {
					imageErr = fmt.Errorf("running %s image differs from the active deployment", service)
				}
			}
		}
	}
	b, _ := json.Marshal(states)
	summary := fmt.Sprintf("Release: %s\nImage: %s (%s)\nURL: %s\nContainers: %s", c.Release, c.Image, c.ImageID, c.URL, b)
	if imageErr != nil {
		return summary, imageErr
	}
	if states["ovs"] != "healthy" || c.managedTLS() && states["caddy"] != "running" {
		return summary, fmt.Errorf("containers are not healthy: %s", b)
	}
	v, err := r.composeRun(c, "exec", "-T", "ovs", "/ovs", "version")
	if err != nil {
		return summary, err
	}
	return summary + "\nVersion: " + v, nil
}

func (r *remote) installCompose(artifact, digest string) error {
	if !safeName.MatchString(artifact) || !strings.HasPrefix(artifact, "compose-upload-") {
		return errors.New("invalid Compose artifact")
	}
	src := filepath.Join(r.dir, "bin", artifact)
	r.progress("Verify uploaded Compose SHA-256 checksum and executable version.")
	defer os.Remove(src)
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, copyErr := io.Copy(h, f)
	closeErr := f.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if hex.EncodeToString(h.Sum(nil)) != digest {
		return errors.New("uploaded Compose checksum mismatch")
	}
	if err := os.Chmod(src, 0o700); err != nil {
		return err
	}
	v, err := output(r.ctx, src, "version", "--short")
	if err != nil {
		return err
	}
	if strings.TrimPrefix(v, "v") != strings.TrimPrefix(composeVersion, "v") {
		return errors.New("unexpected Compose version")
	}
	r.progress("Install verified Compose executable; preserve existing plugins.")
	target := filepath.Join(r.dir, "bin", "docker-compose")
	if _, err := r.docker("compose", "version", "--short"); err != nil {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		config := os.Getenv("DOCKER_CONFIG")
		if config == "" {
			config = filepath.Join(home, ".docker")
		}
		plugin := filepath.Join(config, "cli-plugins", "docker-compose")
		if _, err := os.Lstat(plugin); errors.Is(err, os.ErrNotExist) {
			if err := os.MkdirAll(filepath.Dir(plugin), 0o700); err != nil {
				return err
			}
			target = plugin
		}
	}
	if err := os.Rename(src, target); err != nil {
		// The Docker config directory can be on another filesystem.
		b, readErr := os.ReadFile(src)
		if readErr != nil {
			return readErr
		}
		if writeErr := os.WriteFile(target+".new", b, 0o700); writeErr != nil {
			return writeErr
		}
		if renameErr := os.Rename(target+".new", target); renameErr != nil {
			return renameErr
		}
	}
	if !r.findCompose() {
		return errors.New("installed Compose could not be invoked")
	}
	return nil
}

func remoteContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, 45*time.Minute)
}
