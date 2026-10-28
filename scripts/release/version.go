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
)

var stableVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)

type version [3]uint64

func parseVersion(raw string) (version, error) {
	var v version
	raw = strings.TrimSpace(raw)
	if !stableVersion.MatchString(raw) {
		return v, errors.New("VERSION must contain MAJOR.MINOR.PATCH without a prefix or leading zeroes")
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
	raw, err := os.ReadFile(filepath.Join(a.root, "VERSION"))
	if err != nil {
		return version{}, err
	}
	return parseVersion(string(raw))
}

func (a *app) bump(part string) error {
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
		return errors.New("bump VERSION on dev or a release topic branch")
	}
	status, err := a.git("status", "--porcelain=v1", "--", "VERSION")
	if err != nil {
		return err
	}
	if status != "" {
		return errors.New("VERSION already modified; review the prepared bump before changing it again")
	}
	old, err := a.version()
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
	if err := os.WriteFile(filepath.Join(a.root, "VERSION"), []byte(next.String()+"\n"), 0o644); err != nil {
		return err
	}
	fmt.Fprintf(a.out, "Bumped %s -> %s. Review release notes and validation before make release-commit.\n", old, next)
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
