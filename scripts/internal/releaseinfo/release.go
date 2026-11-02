// Package releaseinfo validates the metadata shared by release preparation and CI.
package releaseinfo

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/swqa7697/open-video-sync/scripts/internal/versions"
)

// Version is a stable numeric MAJOR.MINOR.PATCH version.
type Version [3]uint64

// ParseVersion rejects prefixes, leading zeroes, and overflowing components.
func ParseVersion(raw string) (Version, error) {
	var v Version
	parts := strings.Split(strings.TrimSpace(raw), ".")
	if len(parts) != len(v) {
		return v, errors.New("version must contain MAJOR.MINOR.PATCH without a prefix or leading zeroes")
	}
	for i, part := range parts {
		if part == "" || (len(part) > 1 && part[0] == '0') || strings.ContainsAny(part, "+- ") {
			return v, errors.New("invalid version component")
		}
		n, err := strconv.ParseUint(part, 10, 64)
		if err != nil {
			return v, fmt.Errorf("version component: %w", err)
		}
		v[i] = n
	}
	return v, nil
}

// String formats a stable numeric version.
func (v Version) String() string { return fmt.Sprintf("%d.%d.%d", v[0], v[1], v[2]) }

// After compares versions numerically.
func (v Version) After(old Version) bool {
	for i := range v {
		if v[i] != old[i] {
			return v[i] > old[i]
		}
	}
	return false
}

// Subject validates a bump and lists only increased modules in manifest order.
func Subject(previousRaw, currentRaw string) (string, error) {
	previous, err := versions.Parse(previousRaw)
	if err != nil {
		return "", err
	}
	current, modules, err := versions.ParseOrdered(currentRaw)
	if err != nil {
		return "", err
	}
	var changed []string
	for _, module := range modules {
		before, err := ParseVersion(previous[module])
		if err != nil {
			return "", err
		}
		after, err := ParseVersion(current[module])
		if err != nil {
			return "", err
		}
		if before.After(after) {
			return "", fmt.Errorf("%s version must not decrease", module)
		}
		if after.After(before) {
			changed = append(changed, module+" "+after.String())
		}
	}
	if len(changed) == 0 {
		return "", errors.New("at least one module version must increase relative to HEAD")
	}
	return "release open-video-sync: " + strings.Join(changed, " | "), nil
}

// Notes contains the newest dated release section.
type Notes struct{ Date, Text string }

// ValidDate accepts date-only release headings and tags.
func ValidDate(date string) bool {
	_, err := time.Parse(time.DateOnly, date)
	return err == nil
}

// ParseNotes validates release headings and requires a nonempty newest section.
func ParseNotes(raw string) (Notes, error) {
	var notes Notes
	var lines []string
	dates := make(map[string]bool)
	collect := false
	for _, line := range strings.Split(raw, "\n") {
		if strings.HasPrefix(line, "## ") {
			collect = false
			if line != "## [Unreleased]" {
				date := strings.TrimSuffix(strings.TrimPrefix(line, "## ["), "]")
				if line != "## ["+date+"]" || !ValidDate(date) {
					return notes, errors.New("CHANGELOG.md release headings must use only ## [YYYY-MM-DD]")
				}
				if dates[date] {
					return notes, fmt.Errorf("CHANGELOG.md has duplicate release date %s", date)
				}
				dates[date] = true
				if notes.Date == "" {
					notes.Date = date
					collect = true
				}
			}
		}
		if collect {
			lines = append(lines, line)
		}
	}
	notes.Text = strings.TrimSpace(strings.Join(lines, "\n"))
	if notes.Date == "" || !strings.Contains("\n"+notes.Text, "\n- ") {
		return notes, errors.New("CHANGELOG.md needs a nonempty latest ## [YYYY-MM-DD] release section")
	}
	return notes, nil
}
