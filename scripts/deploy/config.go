package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const (
	composeVersion = "v5.6.1"
	caddyImage     = "caddy:alpine"
	project        = "ovs"
	ownerLabel     = "io.open-video-sync.deployment"
	dataVolume     = "ovs-managed-data"
	ownerVolume    = "ovs-managed-owner"
	managedNetwork = "ovs-managed-network"
)

var safeName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)

type settings struct {
	URL          string
	Proxy        string
	Network      string
	Trusted      string
	Subnet       string
	Image        string
	ImageID      string
	CaddyID      string
	ImageContent string
	CaddyContent string
	Release      string
}

func mergeSettings(old, input settings) (settings, error) {
	c := old
	for _, field := range []struct {
		dst *string
		src string
	}{
		{&c.URL, input.URL}, {&c.Proxy, input.Proxy}, {&c.Network, input.Network},
		{&c.Trusted, input.Trusted}, {&c.Subnet, input.Subnet},
	} {
		if field.src != "" {
			*field.dst = field.src
		}
	}
	if c.Proxy == "" {
		c.Proxy = "auto"
	}
	if c.Subnet == "" {
		c.Subnet = "172.30.0.0/24"
	}
	if c.Proxy != "auto" && c.Proxy != "external" {
		return c, errors.New("PROXY must be auto or external")
	}
	u, err := url.Parse(c.URL)
	if err != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" {
		return c, errors.New("URL must be an http:// or https:// origin, without credentials, path, query or fragment; required on first deployment")
	}
	host := strings.ToLower(u.Hostname())
	ip, ipErr := netip.ParseAddr(host)
	if ipErr != nil {
		if len(host) > 253 {
			return c, errors.New("URL host is too long")
		}
		for _, label := range strings.Split(host, ".") {
			if len(label) == 0 || len(label) > 63 || !regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`).MatchString(label) {
				return c, errors.New("URL must use an ASCII DNS name or IP address")
			}
		}
	} else if ip.Zone() != "" || ip.Is4In6() {
		return c, errors.New("scoped and IPv4-mapped addresses are not supported")
	}
	port := u.Port()
	if port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return c, errors.New("URL port must be between 1 and 65535")
		}
		port = strconv.Itoa(n)
	}
	if (u.Scheme == "http" && port == "80") || (u.Scheme == "https" && port == "443") {
		port = ""
	}
	authority := host
	if ipErr == nil && ip.Is6() {
		authority = "[" + host + "]"
	}
	if port != "" {
		authority = net.JoinHostPort(host, port)
	}
	c.URL = u.Scheme + "://" + authority
	if c.managedTLS() {
		if port != "" {
			return c, errors.New("managed HTTPS requires standard port 443")
		}
		if ipErr == nil && (!ip.IsGlobalUnicast() || ip.IsPrivate() || ip.IsLoopback() || ip.IsLinkLocalUnicast()) {
			return c, errors.New("managed HTTPS requires a public IP; private addresses need an external proxy")
		}
		if ipErr != nil && (!strings.Contains(host, ".") || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local")) {
			return c, errors.New("managed HTTPS requires a public DNS name")
		}
	}
	if c.Proxy == "auto" {
		c.Network, c.Trusted = "", ""
	}
	if c.Network != "" && !safeName.MatchString(c.Network) {
		return c, errors.New("invalid PROXY_NETWORK")
	}
	if c.Network != "" && c.Trusted == "" {
		return c, errors.New("TRUSTED_PROXIES is required with PROXY_NETWORK")
	}
	if input.Network != "" && input.Network != old.Network && input.Trusted == "" {
		return c, errors.New("changing PROXY_NETWORK requires explicit TRUSTED_PROXIES")
	}
	if c.Trusted != "" {
		parts := strings.Split(c.Trusted, ",")
		if len(parts) > 64 {
			return c, errors.New("too many trusted proxies")
		}
		for i, raw := range parts {
			p, err := netip.ParsePrefix(strings.TrimSpace(raw))
			if err != nil || p != p.Masked() || p.Bits() == 0 || p.Addr().Is4In6() {
				return c, errors.New("TRUSTED_PROXIES must contain masked CIDRs without /0")
			}
			parts[i] = p.String()
		}
		c.Trusted = strings.Join(parts, ",")
	}
	p, err := netip.ParsePrefix(c.Subnet)
	if err != nil || !p.Addr().Is4() || !p.Addr().IsPrivate() || p.Bits() != 24 || p != p.Masked() {
		return c, errors.New("PROXY_SUBNET must be a masked private IPv4 /24")
	}
	return c, nil
}

func (c settings) managedTLS() bool { return c.Proxy == "auto" && strings.HasPrefix(c.URL, "https://") }
func (c settings) proxyIP() string {
	p, _ := netip.ParsePrefix(c.Subnet)
	return p.Addr().Next().Next().String()
}
func (c settings) port() string {
	u, _ := url.Parse(c.URL)
	if c.Proxy == "external" {
		return "8080"
	}
	if u.Port() != "" {
		return u.Port()
	}
	if u.Scheme == "https" {
		return "443"
	}
	return "80"
}

func caddyConfig(c settings) string {
	u, _ := url.Parse(c.URL)
	global, tls := "", ""
	if _, err := netip.ParseAddr(u.Hostname()); err == nil {
		global = "{\n default_sni " + u.Hostname() + "\n}\n"
		tls = " tls {\n  issuer acme {\n   dir https://acme-v02.api.letsencrypt.org/directory\n   profile shortlived\n  }\n }\n"
	}
	return global + c.URL + " {\n" + tls + " reverse_proxy ovs:8080\n}\n"
}

// composeConfig uses JSON (a supported Compose input) to avoid YAML quoting rules.
func composeConfig(c settings, dir string) ([]byte, error) {
	labels := map[string]string{ownerLabel: dir}
	network := managedNetwork
	if c.Network != "" {
		network = c.Network
	}
	trusted := c.Trusted
	if c.managedTLS() {
		trusted = c.proxyIP() + "/32"
	}
	ovs := map[string]any{
		"image": c.Image, "pull_policy": "never", "labels": labels,
		"environment": map[string]string{"OVS_PUBLIC_ORIGIN": c.URL, "OVS_TRUSTED_PROXIES": trusted},
		"volumes":     []string{"data:/data"}, "read_only": true, "cap_drop": []string{"ALL"},
		"security_opt": []string{"no-new-privileges:true"}, "restart": "unless-stopped", "stop_grace_period": "15s",
		"networks": []string{"app"},
	}
	if !c.managedTLS() && c.Network == "" {
		bind := "0.0.0.0"
		if c.Proxy == "external" {
			bind = "127.0.0.1"
		} else {
			u, _ := url.Parse(c.URL)
			if ip, err := netip.ParseAddr(u.Hostname()); err == nil && ip.Is6() {
				bind = "::"
			}
		}
		ovs["ports"] = []any{map[string]any{"target": 8080, "published": c.port(), "host_ip": bind, "protocol": "tcp"}}
	}
	services := map[string]any{"ovs": ovs}
	volumes := map[string]any{"data": map[string]any{"external": true, "name": dataVolume}}
	if c.managedTLS() {
		services["caddy"] = map[string]any{
			"image": caddyImage, "pull_policy": "never", "labels": labels, "restart": "unless-stopped",
			"ports":    []string{"80:80", "443:443"},
			"volumes":  []any{"caddy-data:/data", "caddy-config:/config", map[string]any{"type": "bind", "source": filepath.Join(dir, "releases", c.Release, "Caddyfile"), "target": "/etc/caddy/Caddyfile", "read_only": true}},
			"networks": map[string]any{"app": map[string]string{"ipv4_address": c.proxyIP()}},
		}
		for _, v := range []string{"caddy-data", "caddy-config"} {
			volumes[v] = map[string]any{"external": true, "name": "ovs-managed-" + v}
		}
	}
	doc := map[string]any{"name": project, "services": services, "volumes": volumes, "networks": map[string]any{"app": map[string]any{"external": true, "name": network}}}
	b, err := json.MarshalIndent(doc, "", "  ")
	// Compose interpolation applies to values, including bind paths and labels.
	return []byte(strings.ReplaceAll(string(b), "$", "$$")), err
}

func validateHost(host string) error {
	if host == "" || strings.HasPrefix(host, "-") || strings.ContainsAny(host, " \t\r\n\x00") {
		return fmt.Errorf("HOST must be an SSH alias or user@host")
	}
	return nil
}

func shellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'" }
