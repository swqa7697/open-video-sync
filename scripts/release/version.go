package main

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"

	"github.com/swqa7697/open-video-sync/scripts/internal/releaseinfo"
	"github.com/swqa7697/open-video-sync/scripts/internal/versions"
)

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
	old, err := releaseinfo.ParseVersion(manifest[module])
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

// notes validates dated release sections and selects the first, newest entry.
func (a *app) notes() (releaseinfo.Notes, bool, error) {
	raw, err := os.ReadFile(filepath.Join(a.root, "CHANGELOG.md"))
	if errors.Is(err, os.ErrNotExist) {
		return releaseinfo.Notes{}, false, nil
	}
	if err != nil {
		return releaseinfo.Notes{}, false, err
	}
	notes, err := releaseinfo.ParseNotes(string(raw))
	return notes, true, err
}
