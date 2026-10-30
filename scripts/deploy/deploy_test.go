package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	out := &strings.Builder{}
	done := make(chan error, 1)
	go func() { done <- serve(context.Background(), dir, in, out) }()
	deadline := time.Now().Add(3 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(dir, ".deploy.lock")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("lock not created")
		}
		time.Sleep(time.Millisecond)
	}
	// The first server may be between creating and acquiring the lock. Wait until
	// a real request confirms it owns the session, without Docker dependencies.
	_, _ = writer.Write([]byte("{\"Action\":\"invalid\"}\n"))
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
