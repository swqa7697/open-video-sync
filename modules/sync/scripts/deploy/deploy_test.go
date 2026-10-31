package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestDeploymentSettings(t *testing.T) {
	first, err := mergeSettings(settings{}, settings{URL: "https://WATCH.Example.com:443/"})
	if err != nil || first.URL != "https://watch.example.com" || !first.managedTLS() {
		t.Fatalf("normalize first deployment: %+v %v", first, err)
	}
	first.Image, first.Release = "ovs:deploy-existing", "existing"
	next, err := mergeSettings(first, settings{})
	if err != nil || next != first {
		t.Fatalf("update discarded saved settings: %+v %v", next, err)
	}
	for _, c := range []settings{
		{}, {URL: "https://127.0.0.1"}, {URL: "https://192.168.1.1"}, {URL: "https://[::1]"},
		{URL: "https://watch.example.com:8443"}, {URL: "http://host/path"}, {URL: "http://user:pass@host"},
		{URL: "http://host?secret=x"}, {URL: "http://host#x"}, {URL: "http://host:0"},
		{URL: "http://host", Proxy: "external", Network: "proxy"},
		{URL: "http://host", Proxy: "external", Trusted: "0.0.0.0/0"},
		{URL: "http://host", Subnet: "172.30.0.1/24"},
	} {
		if got, err := mergeSettings(settings{}, c); err == nil {
			t.Errorf("accepted invalid input %+v as %+v", c, got)
		}
	}
	for _, origin := range []string{"http://127.0.0.1:8080", "http://[::1]:8080", "https://8.8.8.8", "https://[2606:4700:4700::1111]"} {
		if _, err := mergeSettings(settings{}, settings{URL: origin}); err != nil {
			t.Errorf("%s: %v", origin, err)
		}
	}
}

func TestComposeExposure(t *testing.T) {
	for _, input := range []settings{
		{URL: "http://127.0.0.1:8080"},
		{URL: "https://8.8.8.8"},
		{URL: "https://watch.example.com", Proxy: "external", Trusted: "172.30.0.1/32"},
		{URL: "https://watch.example.com", Proxy: "external", Network: "existing-proxy", Trusted: "10.20.0.2/32"},
	} {
		c, err := mergeSettings(settings{}, input)
		if err != nil {
			t.Fatal(err)
		}
		c.Image, c.Release = "ovs:deploy-test", "test"
		b, err := composeConfig(c, "/srv/ovs")
		if err != nil {
			t.Fatal(err)
		}
		var doc struct {
			Services map[string]struct {
				Ports       []json.RawMessage
				Environment map[string]string
				Build       any
			}
			Volumes map[string]struct {
				External bool
				Name     string
			}
		}
		if err := json.Unmarshal(b, &doc); err != nil {
			t.Fatal(err)
		}
		ovs := doc.Services["ovs"]
		if ovs.Build != nil || ovs.Environment["OVS_PUBLIC_ORIGIN"] != c.URL {
			t.Fatalf("incorrect deployment service: %s", b)
		}
		if (len(ovs.Ports) == 0) != (c.managedTLS() || c.Network != "") {
			t.Fatalf("incorrect public OVS exposure: %s", b)
		}
		if c.managedTLS() && (len(doc.Services["caddy"].Ports) != 2 || ovs.Environment["OVS_TRUSTED_PROXIES"] != c.proxyIP()+"/32") {
			t.Fatalf("incorrect Caddy isolation: %s", b)
		}
		if doc.Volumes["data"].Name != dataVolume || !doc.Volumes["data"].External {
			t.Fatal("deployment can silently choose a new data volume")
		}
	}
}

func TestSSHInputAndQuoting(t *testing.T) {
	for _, host := range []string{"", "-oProxyCommand=bad", "host\ncommand", "user@host extra"} {
		if validateHost(host) == nil {
			t.Errorf("accepted host %q", host)
		}
	}
	for _, host := range []string{"ovs-prod", "deploy@192.0.2.1", "deploy@[2001:db8::1]"} {
		if err := validateHost(host); err != nil {
			t.Error(err)
		}
	}
	value := "path with 'quotes' and $(touch NEVER) `echo bad` $HOME; newline\n"
	cmd := exec.Command("sh", "-c", "printf '%s' "+shellQuote(value))
	got, err := cmd.Output()
	if err != nil || string(got) != value {
		t.Fatalf("shell quoting changed input: %q %v", got, err)
	}
}

func TestPublicVerification(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health/ready" {
			w.WriteHeader(204)
			return
		}
		_, _ = io.WriteString(w, "OVS")
	})
	srv := httptest.NewTLSServer(handler)
	defer srv.Close()
	ctx := context.Background()
	if err := checkPublic(ctx, srv.URL, srv.Client(), io.Discard); err != nil {
		t.Fatal(err)
	}
	if err := checkPublic(ctx, srv.URL, http.DefaultClient, io.Discard); err == nil {
		t.Fatal("untrusted certificate accepted")
	}
	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	wrong := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, ServerName: "wrong.example"}}}
	defer wrong.CloseIdleConnections()
	if err := checkPublic(ctx, srv.URL, wrong, io.Discard); err == nil {
		t.Fatal("certificate for wrong host accepted")
	}
	unsafe := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}}
	defer unsafe.CloseIdleConnections()
	if err := checkPublic(ctx, srv.URL, unsafe, io.Discard); err == nil {
		t.Fatal("unverified TLS connection accepted")
	}
	redirect := httptest.NewServer(http.RedirectHandler(srv.URL, 302))
	defer redirect.Close()
	if err := checkPublic(ctx, redirect.URL, srv.Client(), io.Discard); err == nil {
		t.Fatal("redirect accepted as deployment health")
	}
}

func TestRemoteLockAndState(t *testing.T) {
	dir := t.TempDir()
	in, writer := io.Pipe()
	reader, out := io.Pipe()
	done := make(chan error, 1)
	go func() {
		defer out.Close()
		defer in.Close()
		done <- serve(context.Background(), dir, in, out)
	}()
	t.Cleanup(func() { _ = writer.Close(); _ = reader.Close() })
	var events []string
	s := &session{encoder: json.NewEncoder(writer), decoder: json.NewDecoder(reader), progress: func(message string) { events = append(events, message) }}
	// Invalid settings need no Docker. They still send a progress event before
	// the final error, and the next call must receive its own response.
	if _, err := s.call(request{Action: "prepare"}); err == nil || len(events) == 0 {
		t.Fatalf("progress or final validation error missing: %v, %v", events, err)
	}
	if _, err := s.call(request{Action: "invalid"}); err == nil || err.Error() != "unknown remote operation" {
		t.Fatalf("progress displaced the next operation response: %v", err)
	}
	if err := serve(context.Background(), dir, strings.NewReader(""), io.Discard); err == nil {
		t.Fatal("concurrent deployment accepted")
	}
	_ = writer.Close()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	c := settings{URL: "http://127.0.0.1:8080", Release: "valid"}
	path := filepath.Join(dir, "active.json")
	if err := writeJSON(path, c); err != nil {
		t.Fatal(err)
	}
	got, err := readSettings(path)
	if err != nil || got != c {
		t.Fatalf("state not preserved: %+v %v", got, err)
	}
	if err := os.WriteFile(path, []byte(`{"Release":"../escape"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readSettings(path); err == nil {
		t.Fatal("unsafe saved release accepted")
	}
}

func TestDeploymentProgress(t *testing.T) {
	for _, tc := range []struct {
		name     string
		terminal bool
		total    int64
		failed   bool
	}{
		{"terminal upload", true, 4096, false},
		{"failed upload log", false, 4096, true},
		{"stream log", false, 0, false},
		{"failed terminal stream", true, 0, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var out strings.Builder
			p := &progress{out: &out, terminal: tc.terminal, total: 2}
			p.begin("Prepare")
			p.begin("Transfer")
			transfer := p.transfer("Archive", tc.total)
			payload := strings.Repeat("data", 1024)
			var copied strings.Builder
			if _, err := io.Copy(&copied, transfer.reader(strings.NewReader(payload))); err != nil || copied.String() != payload {
				t.Fatalf("progress changed transferred bytes: %v", err)
			}
			var err error
			if tc.failed {
				err = errors.New("connection lost after reading local bytes")
			}
			transfer.finish(err)
			p.finish(err)
			got := out.String()
			if !strings.Contains(got, "[ 1/2] OK Prepare") || !strings.Contains(got, "4.0 KiB") || !strings.Contains(got, "/s") {
				t.Fatalf("step or transfer details missing: %s", got)
			}
			if !tc.terminal && strings.ContainsAny(got, "\r\x1b") {
				t.Fatalf("terminal control codes in redirected output: %q", got)
			}
			if tc.total == 0 && strings.Contains(got, "%") {
				t.Fatalf("unknown stream size has a fabricated percentage: %s", got)
			}
			if tc.failed {
				if !strings.Contains(got, "FAIL Transfer") || !strings.Contains(got, "failed") || strings.Contains(got, "100%") {
					t.Fatalf("failed transfer reported success: %s", got)
				}
			} else if !strings.Contains(got, "OK Transfer") || tc.total > 0 && !strings.Contains(got, "100%") {
				t.Fatalf("completed transfer missing: %s", got)
			}
		})
	}
}

func TestComposeDownloadProgress(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "4096")
		if r.URL.Path == "/cancel" {
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		if r.URL.Path == "/short" {
			_, _ = io.WriteString(w, "partial")
			return
		}
		_, _ = io.WriteString(w, strings.Repeat("data", 1024))
	}))
	defer server.Close()
	for _, tc := range []struct {
		path  string
		limit int64
		fail  bool
	}{{"/complete", 4096, false}, {"/short", 4096, true}, {"/oversize", 1024, true}, {"/cancel", 4096, true}} {
		t.Run(tc.path, func(t *testing.T) {
			var out strings.Builder
			p := &progress{out: &out}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if tc.path == "/cancel" {
				// Cancel after the response headers arrive and progress starts.
				p.out = progressOutput(func(b []byte) (int, error) {
					cancel()
					return out.Write(b)
				})
			}
			b, err := fetch(ctx, server.URL+tc.path, tc.limit, p)
			if (err != nil) != tc.fail {
				t.Fatalf("unexpected download result: %v", err)
			}
			if tc.path == "/cancel" && !errors.Is(err, context.Canceled) {
				t.Fatalf("download did not stop on cancellation: %v", err)
			}
			got := out.String()
			if tc.fail {
				if !strings.Contains(got, "failed") || strings.Contains(got, "100%") {
					t.Fatalf("failed download reported success: %s", got)
				}
			} else if len(b) != 4096 || !strings.Contains(got, "100%") {
				t.Fatalf("download data or completion missing: %d, %s", len(b), got)
			}
		})
	}
}

type progressOutput func([]byte) (int, error)

func (write progressOutput) Write(b []byte) (int, error) { return write(b) }

func TestTCPListenerProbe(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	busy, err := tcpListening(port)
	if err != nil || !busy {
		t.Fatalf("listening port missed: %v %v", busy, err)
	}
}
