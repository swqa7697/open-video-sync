package main

import "testing"

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
	for key, invalid := range map[string]string{"OVS_LISTEN_ADDR": "127.0.0.1:0", "OVS_LOG_LEVEL": "info+4"} {
		t.Run(key, func(t *testing.T) {
			_, err := loadConfig(func(name string) string {
				if name == "OVS_PUBLIC_ORIGIN" {
					return "http://localhost:8080"
				}
				if name == key {
					return invalid
				}
				return ""
			})
			if err == nil {
				t.Fatal("invalid deployment configuration accepted")
			}
		})
	}
}
