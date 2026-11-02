package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFormatRepositoryImports(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "main.go")
	source := `package main

import (
	"strings"
	"os"
	"fmt"
	_ "net/http/pprof"
)

func main() {
	fmt.Fprintln(os.Stdout, "hello")
}
`
	if err := os.WriteFile(path, []byte(source), 0o644); err != nil {
		t.Fatal(err)
	}
	// Excluded dependency, generated-output, and scratch directories may contain invalid Go.
	for _, name := range []string{"node_modules", "vendor", "build", "dist", ".misc"} {
		dir := filepath.Join(root, name)
		if err := os.Mkdir(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "invalid.go"), []byte("not Go"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := formatRepository(root, false); err == nil {
		t.Fatal("check accepted unsorted and unused imports")
	}
	read := func() string {
		t.Helper()
		contents, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return string(contents)
	}
	if got := read(); got != source {
		t.Fatalf("check modified source:\n%s", got)
	}
	if err := formatRepository(root, true); err != nil {
		t.Fatal(err)
	}
	want := `package main

import (
	"fmt"
	_ "net/http/pprof"
	"os"
)

func main() {
	fmt.Fprintln(os.Stdout, "hello")
}
`
	if got := read(); got != want {
		t.Fatalf("imports were not organized or a side-effect import was lost:\n%s", got)
	}
	if err := formatRepository(root, false); err != nil {
		t.Fatalf("check rejected formatted source: %v", err)
	}
}
