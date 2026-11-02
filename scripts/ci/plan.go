package main

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/swqa7697/open-video-sync/scripts/internal/releaseinfo"
)

func (a *app) choose(ctx context.Context, current record, event pullEvent) (plan, error) {
	p := plan{Record: current, Reason: "ordinary pull request"}
	if event.Pull.Base.Ref != "main" || event.Pull.Head.Repo.FullName != current.Repository {
		return p, nil
	}
	message, err := a.git(ctx, "show", "-s", "--format=%B", current.SourceSHA)
	if err != nil {
		return p, err
	}
	if !strings.HasPrefix(message, "release open-video-sync: ") {
		return p, nil
	}
	p.Reason = "release commit is not an isolated metadata update"
	raw, err := a.git(ctx, "rev-list", "--parents", "-n", "1", current.SourceSHA)
	if err != nil {
		return p, err
	}
	parents := strings.Fields(raw)
	if len(parents) != 2 {
		return p, nil
	}
	parent := parents[1]
	// Raw, NUL-delimited records expose deletion, renames, and mode changes.
	raw, err = a.git(ctx, "diff-tree", "--no-commit-id", "--raw", "--no-abbrev", "--no-renames", "-r", "-z", parent, current.SourceSHA)
	if err != nil {
		return p, err
	}
	items := strings.Split(strings.TrimSuffix(raw, "\x00"), "\x00")
	versionChanged := false
	for i := 0; i+1 < len(items); i += 2 {
		fields := strings.Fields(items[i])
		path := items[i+1]
		if len(fields) != 5 || fields[0] != ":100644" || fields[1] != "100644" || fields[4] != "M" ||
			(path != "versions.toml" && path != "CHANGELOG.md") {
			return p, nil
		}
		versionChanged = versionChanged || path == "versions.toml"
	}
	if !versionChanged || len(items)%2 != 0 {
		return p, nil
	}
	previous, err := a.git(ctx, "show", parent+":versions.toml")
	if err != nil {
		return p, err
	}
	currentRaw, err := a.git(ctx, "show", current.SourceSHA+":versions.toml")
	if err != nil {
		return p, err
	}
	subject, err := releaseinfo.Subject(previous, currentRaw)
	if err != nil {
		return p, fmt.Errorf("release metadata: %w", err)
	}
	if strings.TrimRight(message, "\n") != subject {
		return p, errors.New("release commit message does not match the bumped modules and versions")
	}
	// The checkout is the tested merge, so this also validates the merged metadata.
	merged, err := a.git(ctx, "show", "HEAD:versions.toml")
	if err != nil || merged != currentRaw {
		return p, errors.New("merged release versions differ from the source commit")
	}
	notesTree, err := a.git(ctx, "ls-tree", "HEAD", "--", "CHANGELOG.md")
	if err != nil {
		return p, err
	}
	if notesTree != "" {
		if !strings.HasPrefix(notesTree, "100644 blob ") {
			return p, errors.New("release changelog must be a regular file")
		}
		notes, err := a.git(ctx, "show", "HEAD:CHANGELOG.md")
		if err != nil {
			return p, err
		}
		if _, err := releaseinfo.ParseNotes(notes); err != nil {
			return p, err
		}
	}
	if _, err := a.git(ctx, "diff", "--check", parent, current.SourceSHA); err != nil {
		return p, errors.New("release metadata has whitespace errors")
	}
	// History lookup failure costs a full run; it must never authorize a shortcut.
	full, err := a.github.fullRun(ctx, current, parent)
	if err != nil {
		p.Reason = fmt.Sprintf("full CI evidence unavailable (%v); running all checks", err)
		return p, nil
	}
	p.Record.Mode, p.Reason = "release", "isolated release metadata with matching full CI"
	p.FullRunID, p.FullRunAttempt = full.RunID, full.RunAttempt
	return p, nil
}
