package main

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The notices command runs from the tools module but must inspect only the
// application's compiled dependencies. All fixture dependencies stay local.
func TestApplicationNoticesFromSeparateModule(t *testing.T) {
	root := t.TempDir()
	for name, content := range map[string]string{
		"go.mod":             "module example.invalid/app\n\ngo 1.23.0\n\nrequire (\n example.invalid/runtime v0.0.0\n example.invalid/tool v0.0.0\n)\n\nreplace example.invalid/runtime => ./runtime\nreplace example.invalid/tool => ./tool\n",
		"cmd/ovs/main.go":    "package main\n\nimport _ \"example.invalid/runtime\"\n\nfunc main() {}\n",
		"automation/main.go": "package main\n\nimport _ \"example.invalid/tool\"\n\nfunc main() {}\n",
		"runtime/go.mod":     "module example.invalid/runtime\n\ngo 1.23.0\n",
		"runtime/runtime.go": "package dependency\n",
		"runtime/LICENSE":    "synthetic application dependency license\n",
		"tool/go.mod":        "module example.invalid/tool\n\ngo 1.23.0\n",
		"tool/tool.go":       "package tool\n",
		"tool/LICENSE":       "synthetic tool dependency license\n",
	} {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	var out bytes.Buffer
	if err := run(&out, root, ""); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "example.invalid/runtime v0.0.0") || !strings.Contains(out.String(), "synthetic application dependency license") {
		t.Fatalf("application dependency notice missing: %s", out.String())
	}
	if strings.Contains(out.String(), "example.invalid/tool") || strings.Contains(out.String(), "synthetic tool dependency license") {
		t.Fatal("notices included a dependency outside the application")
	}
	if err := run(io.Discard, filepath.Join(root, "missing"), ""); err == nil {
		t.Fatal("missing application module accepted")
	}
}

// pnpm groups versions under one name. Notices must label each actual version and
// cover the upstream tarball omission without accepting unrelated missing licenses.
func TestFrontendNoticesWithMultipleVersions(t *testing.T) {
	root := t.TempDir()
	paths := make([]string, 2)
	for index, version := range []string{"6.6.4", "8.2.1"} {
		directory := filepath.Join(root, version)
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
		manifest, err := json.Marshal(map[string]string{"name": "@vue/devtools-api", "version": version})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, "package.json"), manifest, 0600); err != nil {
			t.Fatal(err)
		}
		paths[index] = directory
	}
	if err := os.WriteFile(filepath.Join(paths[1], "LICENSE"), []byte("synthetic packaged license"), 0600); err != nil {
		t.Fatal(err)
	}
	metadata, err := json.Marshal(map[string]any{"MIT": []any{map[string]any{
		"name": "@vue/devtools-api", "versions": []string{"6.6.4", "8.2.1"}, "paths": paths,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(root, "frontend.json")
	if err := os.WriteFile(path, metadata, 0600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := printFrontend(&output, path); err != nil {
		t.Fatal(err)
	}
	text := output.String()
	if !strings.Contains(text, "=== @vue/devtools-api 6.6.4 / LICENSE ===") ||
		!strings.Contains(text, "Copyright (c) 2014-present Evan You") ||
		!strings.Contains(text, "=== @vue/devtools-api 8.2.1 / LICENSE ===\nsynthetic packaged license") {
		t.Fatalf("notices did not preserve both versions: %s", text)
	}
	if err := os.Remove(filepath.Join(paths[1], "LICENSE")); err != nil {
		t.Fatal(err)
	}
	output.Reset()
	if err := printFrontend(&output, path); err == nil || !strings.Contains(err.Error(), "license file missing for @vue/devtools-api 8.2.1") {
		t.Fatalf("an unrecognized omission must fail the build: %v", err)
	}
}
