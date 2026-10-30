package main

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/swqa7697/open-video-sync/modules/sync/scripts/internal/versions"
)

var stableVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

type version [3]uint64

func parseVersion(raw string) (version, error) {
	var v version
	raw = strings.TrimSpace(raw)
	if !stableVersion.MatchString(raw) {
		return v, errors.New("version must contain MAJOR.MINOR.PATCH without a prefix or leading zeroes")
	}
	for i, part := range strings.Split(raw, ".") {
		n, err := strconv.ParseUint(part, 10, 64)
		if err != nil {
			return v, fmt.Errorf("version component: %w", err)
		}
		v[i] = n
	}
	return v, nil
}

func (v version) String() string { return fmt.Sprintf("%d.%d.%d", v[0], v[1], v[2]) }

func (v version) after(old version) bool {
	for i := range v {
		if v[i] != old[i] {
			return v[i] > old[i]
		}
	}
	return false
}

func (a *app) version() (version, error) {
	manifest, err := versions.Read(filepath.Join(a.root, "versions.toml"))
	if err != nil {
		return version{}, err
	}
	return parseVersion(manifest["sync"])
}

func (a *app) bump(part string, modules ...string) error {
	module := "sync"
	if len(modules) == 1 {
		module = modules[0]
	}
	if len(modules) > 1 || (module != "sync" && module != "web" && module != "helper") {
		return errors.New("module must be sync, web, or helper")
	}
	index := -1
	for i, name := range []string{"major", "minor", "patch"} {
		if part == name {
			index = i
		}
	}
	if index < 0 {
		return errors.New("bump must be major, minor, or patch")
	}
	branch, err := a.branch()
	if err != nil {
		return err
	}
	if branch == "main" || branch == "master" {
		return errors.New("bump versions.toml on dev or a release topic branch")
	}
	status, err := a.git("status", "--porcelain=v1", "--", "versions.toml")
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(filepath.Join(a.root, "versions.toml"))
	if err != nil {
		return err
	}
	manifest, err := versions.Parse(string(raw))
	if err != nil {
		return err
	}
	if status != "" {
		prior, err := a.git("show", "HEAD:versions.toml")
		if err != nil {
			return err
		}
		previous, err := versions.Parse(prior)
		if err != nil {
			return err
		}
		if previous[module] != manifest[module] {
			return fmt.Errorf("%s version already modified; review the prepared bump before changing it again", module)
		}
	}
	old, err := parseVersion(manifest[module])
	if err != nil {
		return err
	}

	next := old
	if next[index] == math.MaxUint64 {
		return errors.New("version component overflow")
	}
	next[index]++
	for i := index + 1; i < len(next); i++ {
		next[i] = 0
	}
	updated, err := versions.Replace(string(raw), module, next.String())
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(a.root, "versions.toml"), []byte(updated), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(a.out, "Bumped %s %s -> %s. Review release notes and validation before make release-commit.\n", module, old, next)
	return nil
}

// notes validates an existing changelog without introducing one into a repository.
func (a *app) notes(v version) (string, bool, error) {
	raw, err := os.ReadFile(filepath.Join(a.root, "CHANGELOG.md"))
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	var lines []string
	var matches int
	collect := false
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.HasPrefix(line, "## ") {
			heading := "## [" + v.String() + "]"
			collect = line == heading || strings.HasPrefix(line, heading+" - ")
			if collect {
				matches++
			}
		}
		if collect {
			lines = append(lines, line)
		}
	}
	notes := strings.TrimSpace(strings.Join(lines, "\n"))
	if matches != 1 || !strings.Contains("\n"+notes, "\n- ") {
		return "", true, fmt.Errorf("CHANGELOG.md needs one nonempty [%s] release section", v)
	}
	return notes, true, nil
}
