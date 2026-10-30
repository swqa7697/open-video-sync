package main

import (
	"strings"
	"testing"
)

func TestConfigValidation(t *testing.T) {
	for _, origin := range []string{"http://localhost:8080", "https://watch.example.com", "http://[::1]:8080"} {
		t.Run(origin, func(t *testing.T) {
			cfg, err := loadConfig(func(key string) string {
				if key == "OVS_PUBLIC_ORIGIN" {
					return origin
				}
				return ""
			})
			if err != nil || cfg.origin.String() != origin {
				t.Fatalf("valid origin rejected: %v", err)
			}
		})
	}
	for _, origin := range []string{"", "file:///data", "http://user:secret@example.com", "https://example.com/", "https://example.com?", "https://example.com?q=secret", "https://example.com#", "https://example.com#secret", "http://example.com:99999", "https://EXAMPLE.com", "http://example.com:80"} {
		t.Run("invalid_"+origin, func(t *testing.T) {
			if _, err := loadConfig(func(key string) string {
				if key == "OVS_PUBLIC_ORIGIN" {
					return origin
				}
				return ""
			}); err == nil {
				t.Fatal("invalid origin accepted")
			}
		})
	}
	load := func(key, value string) (config, error) {
		return loadConfig(func(name string) string {
			if name == "OVS_PUBLIC_ORIGIN" {
				return "http://localhost:8080"
			}
			if name == key {
				return value
			}
			return ""
		})
	}
	for _, invalid := range []struct{ key, value string }{
		{"OVS_LISTEN_ADDR", "127.0.0.1:0"},
		{"OVS_LOG_LEVEL", "info+4"},
		{"OVS_TRUSTED_PROXIES", "10.0.0.1/8"},
		{"OVS_TRUSTED_PROXIES", "0.0.0.0/0"},
		{"OVS_TRUSTED_PROXIES", "::/0"},
		{"OVS_TRUSTED_PROXIES", "10.0.0.0/8,"},
		{"OVS_TRUSTED_PROXIES", "10.0.0.1"},
		{"OVS_TRUSTED_PROXIES", "::ffff:10.0.0.0/104"},
		{"OVS_TRUSTED_PROXIES", "fe80::1%eth0/128"},
		{"OVS_TRUSTED_PROXIES", "proxy.example"},
		{"OVS_TRUSTED_PROXIES", strings.Repeat("10.0.0.0/8,", 64) + "10.0.0.0/8"},
	} {
		t.Run(invalid.key+"="+invalid.value, func(t *testing.T) {
			if _, err := load(invalid.key, invalid.value); err == nil {
				t.Fatal("invalid deployment configuration accepted")
			}
		})
	}
	if cfg, err := load("OVS_TRUSTED_PROXIES", ""); err != nil || cfg.trustedProxies != nil {
		t.Fatalf("unset proxy trust = %v, %v", cfg.trustedProxies, err)
	}
	cfg, err := load("OVS_TRUSTED_PROXIES", "172.30.0.2/32, ::1/128")
	if err != nil || len(cfg.trustedProxies) != 2 || cfg.trustedProxies[0].String() != "172.30.0.2/32" || cfg.trustedProxies[1].String() != "::1/128" {
		t.Fatalf("valid proxy trust = %v, %v", cfg.trustedProxies, err)
	}
}
