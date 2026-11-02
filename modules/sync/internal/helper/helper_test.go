package helper

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestInstanceDistribution(t *testing.T) {
	for _, origin := range []string{"http://ovs.example:8080", "https://ovs.example", "http://[::1]:8080"} {
		h, err := Handler(origin)
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest("GET", "http://attacker.invalid/userscripts/ovs-bilibili.user.js", nil)
		r.Header.Set("X-Forwarded-Host", "attacker.invalid")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		body := w.Body.String()
		if w.Code != 200 || !strings.HasPrefix(w.Header().Get("Content-Type"), "application/javascript") || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(body, "@name OVS Bilibili "+origin) || !strings.Contains(body, `const ORIGIN = "`+origin+`"`) || strings.Contains(body, "attacker.invalid") || strings.Contains(body, "{{") {
			t.Fatalf("incorrect scoped distribution for %s", origin)
		}
		w = httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("HEAD", "/", nil))
		if w.Code != 200 || w.Body.Len() != 0 {
			t.Fatal("HEAD returned a body")
		}
		w = httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("POST", "/", nil))
		if w.Code != 405 {
			t.Fatal("distribution accepted a mutation")
		}
	}
	for _, origin := range []string{"https://*.example", "https://ovs.example/", "https://user@ovs.example", "https://ovs.example?x=1", "javascript:alert(1)", "https://ovs.example\n// @connect *"} {
		if _, err := Handler(origin); err == nil {
			t.Fatalf("accepted unsafe origin %q", origin)
		}
	}
}
