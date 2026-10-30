package main

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"net/url"
	"os"
	"strings"

	"github.com/swqa7697/open-video-sync/internal/rooms"
)

type config struct {
	listenAddr     string
	dataDir        string
	origin         *url.URL
	logLevel       slog.Level
	roomLimits     rooms.Limits
	trustedProxies []netip.Prefix
}

func loadConfig(getenv func(string) string) (config, error) {
	value := func(key, fallback string) string {
		if v := getenv(key); v != "" {
			return v
		}
		return fallback
	}
	c := config{
		listenAddr: value("OVS_LISTEN_ADDR", ":8080"),
		dataDir:    value("OVS_DATA_DIR", "/data"),
	}
	_, port, err := net.SplitHostPort(c.listenAddr)
	if err != nil || port == "" {
		return config{}, fmt.Errorf("OVS_LISTEN_ADDR must contain a host and port")
	}
	portNumber, err := net.LookupPort("tcp", port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return config{}, fmt.Errorf("OVS_LISTEN_ADDR must contain a valid nonzero port")
	}
	rawOrigin := getenv("OVS_PUBLIC_ORIGIN")
	origin, err := url.Parse(rawOrigin)
	if err != nil || origin == nil || (origin.Scheme != "http" && origin.Scheme != "https") || origin.Hostname() == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.ForceQuery || origin.Fragment != "" || origin.Opaque != "" {
		return config{}, fmt.Errorf("OVS_PUBLIC_ORIGIN must be an exact http:// or https:// origin without credentials, path, query, or fragment")
	}
	if strings.TrimPrefix(rawOrigin, origin.Scheme+"://") != origin.Host {
		return config{}, fmt.Errorf("OVS_PUBLIC_ORIGIN must contain only scheme and host")
	}
	// Browser origins use lowercase hosts and omit default ports.
	if origin.Host != strings.ToLower(origin.Host) || (origin.Scheme == "http" && origin.Port() == "80") || (origin.Scheme == "https" && origin.Port() == "443") {
		return config{}, fmt.Errorf("OVS_PUBLIC_ORIGIN must use the browser's canonical host and port")
	}
	if port := origin.Port(); port != "" {
		n, err := net.LookupPort("tcp", port)
		if err != nil || n < 1 || n > 65535 {
			return config{}, fmt.Errorf("OVS_PUBLIC_ORIGIN contains an invalid port")
		}
	}
	c.origin = origin
	c.roomLimits = rooms.DefaultLimits()
	level := strings.ToLower(value("OVS_LOG_LEVEL", "info"))
	switch level {
	case "debug", "info", "warn", "error":
	default:
		return config{}, fmt.Errorf("OVS_LOG_LEVEL must be debug, info, warn, or error")
	}
	if err := c.logLevel.UnmarshalText([]byte(level)); err != nil {
		return config{}, fmt.Errorf("parse log level: %w", err)
	}
	if c.trustedProxies, err = parseTrustedProxies(getenv("OVS_TRUSTED_PROXIES")); err != nil {
		return config{}, err
	}
	return c, nil
}

// parseTrustedProxies accepts comma-separated masked CIDRs. Empty input trusts no forwarding headers.
func parseTrustedProxies(raw string) ([]netip.Prefix, error) {
	if raw == "" {
		return nil, nil
	}
	invalid := errors.New("OVS_TRUSTED_PROXIES must list at most 64 comma-separated masked CIDRs, such as 172.30.0.2/32, without /0 or IPv4-mapped prefixes")
	parts := strings.Split(raw, ",")
	if len(parts) > 64 {
		return nil, invalid
	}
	prefixes := make([]netip.Prefix, 0, len(parts))
	for _, part := range parts {
		prefix, err := netip.ParsePrefix(strings.TrimSpace(part))
		if err != nil || prefix != prefix.Masked() || prefix.Bits() == 0 || prefix.Addr().Is4In6() {
			return nil, invalid
		}
		prefixes = append(prefixes, prefix)
	}
	return prefixes, nil
}

func environmentConfig() (config, error) {
	return loadConfig(os.Getenv)
}
