// Command gofmt checks repository Go formatting, or applies it with -write.
package main

import (
	"bytes"
	"flag"
	"fmt"
	"go/format"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

func main() {
	root := flag.String("root", ".", "repository root")
	write := flag.Bool("write", false, "apply formatting")
	flag.Parse()
	dirty := false
	err := filepath.WalkDir(*root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			if path != *root && (strings.HasPrefix(entry.Name(), ".") || entry.Name() == "node_modules" || entry.Name() == "build") {
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
		formatted, err := format.Source(contents)
		if err != nil {
			return fmt.Errorf("format %s: %w", path, err)
		}
		if bytes.Equal(contents, formatted) {
			return nil
		}
		if *write {
			return os.WriteFile(path, formatted, 0o644)
		}
		fmt.Fprintln(os.Stderr, path)
		dirty = true
		return nil
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if dirty {
		fmt.Fprintln(os.Stderr, "run make format")
		os.Exit(1)
	}
}
