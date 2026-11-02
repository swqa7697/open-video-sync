// Command gofmt checks Go formatting and imports, or applies them with -write.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/tools/imports"
)

func main() {
	root := flag.String("root", ".", "repository root")
	write := flag.Bool("write", false, "apply formatting and organize imports")
	flag.Parse()
	if err := formatRepository(*root, *write); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func formatRepository(root string, write bool) error {
	root, err := filepath.Abs(root)
	if err != nil {
		return err
	}
	dirty := false
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if path != root && (strings.HasPrefix(entry.Name(), ".") || entry.Name() == "node_modules" || entry.Name() == "build" || entry.Name() == "vendor" || entry.Name() == "dist") {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		contents, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		formatted, err := imports.Process(path, contents, nil)
		if err != nil {
			return fmt.Errorf("format %s: %w", path, err)
		}
		if bytes.Equal(contents, formatted) {
			return nil
		}
		if write {
			return os.WriteFile(path, formatted, 0o644)
		}
		fmt.Fprintln(os.Stderr, path)
		dirty = true
		return nil
	})
	if err != nil {
		return err
	}
	if dirty {
		return fmt.Errorf("run make format")
	}
	return nil
}
