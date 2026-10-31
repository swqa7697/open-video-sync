package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
