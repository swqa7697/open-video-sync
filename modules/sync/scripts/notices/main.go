// Command notices collects license files for compiled Go dependencies and the
// frontend production dependencies identified by pnpm during the build.
package main

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// The @vue/devtools-api 6.6.4 tarball omits the upstream license.
// See licenses/README.md for the exact source.
//
//go:embed licenses/vue-devtools-api-6.6.4.txt
var devtoolsAPILicense string

func main() {
	frontend := flag.String("frontend", "", "pnpm production license metadata")
	flag.Parse()
	if err := run(os.Stdout, *frontend); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(out io.Writer, frontend string) error {
	output, err := exec.Command("go", "list", "-deps", "-json", "./cmd/ovs").Output()
	if err != nil {
		return fmt.Errorf("list Go modules: %w", err)
	}
	fmt.Fprintln(out, "Go runtime dependencies")
	if err := printFile(out, "Go toolchain", filepath.Join(runtime.GOROOT(), "LICENSE")); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	seen := make(map[string]bool)
	for {
		var pkg struct {
			Module *struct {
				Path, Version, Dir string
				Main               bool
			}
		}
		if err := decoder.Decode(&pkg); errors.Is(err, io.EOF) {
			break
		} else if err != nil {
			return err
		}
		module := pkg.Module
		if module == nil || module.Main || seen[module.Path] {
			continue
		}
		seen[module.Path] = true
		if err := printLicenses(out, module.Path+" "+module.Version, module.Dir); err != nil {
			return err
		}
	}
	if frontend != "" {
		return printFrontend(out, frontend)
	}
	return nil
}

func printLicenses(out io.Writer, label, directory string) error {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return fmt.Errorf("read notices for %s: %w", label, err)
	}
	found := false
	for _, entry := range entries {
		name := strings.ToUpper(entry.Name())
		if !entry.IsDir() && (strings.HasPrefix(name, "LICENSE") || strings.HasPrefix(name, "COPYING") || strings.HasPrefix(name, "NOTICE")) {
			if err := printFile(out, label, filepath.Join(directory, entry.Name())); err != nil {
				return err
			}
			found = true
		}
	}
	if !found {
		if label == "@vue/devtools-api 6.6.4" {
			fmt.Fprintf(out, "\n=== %s / LICENSE ===\n%s\n", label, devtoolsAPILicense)
			return nil
		}
		return fmt.Errorf("license file missing for %s", label)
	}
	return nil
}

func printFrontend(out io.Writer, path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	type dependency struct {
		Name  string
		Paths []string
	}
	var groups map[string][]dependency
	if err := json.Unmarshal(data, &groups); err != nil {
		return err
	}
	var dependencies []dependency
	for _, packages := range groups {
		dependencies = append(dependencies, packages...)
	}
	sort.Slice(dependencies, func(i, j int) bool { return dependencies[i].Name < dependencies[j].Name })
	fmt.Fprintln(out, "\nFrontend production dependencies")
	for _, dependency := range dependencies {
		for _, directory := range dependency.Paths {
			data, err := os.ReadFile(filepath.Join(directory, "package.json"))
			if err != nil {
				return fmt.Errorf("read package version for %s: %w", dependency.Name, err)
			}
			var manifest struct{ Name, Version string }
			if err := json.Unmarshal(data, &manifest); err != nil {
				return fmt.Errorf("read package version for %s: %w", dependency.Name, err)
			}
			if manifest.Name != dependency.Name || manifest.Version == "" {
				return fmt.Errorf("invalid package manifest for %s", dependency.Name)
			}
			if err := printLicenses(out, dependency.Name+" "+manifest.Version, directory); err != nil {
				return err
			}
		}
	}
	return nil
}

func printFile(out io.Writer, label, path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	fmt.Fprintf(out, "\n=== %s / %s ===\n%s\n", label, filepath.Base(path), data)
	return nil
}
