package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"github.com/swqa7697/open-video-sync/scripts/internal/versions"
)

func (a *app) branch() (string, error) {
	raw, err := a.git("symbolic-ref", "--quiet", "--short", "HEAD")
	if err != nil {
		return "", errors.New("release commands require an attached branch")
	}
	return strings.TrimSpace(raw), nil
}

func (a *app) changed(untracked bool) ([]string, error) {
	mode := "no"
	if untracked {
		mode = "all"
	}
	raw, err := a.git("status", "--porcelain=v1", "-z", "--untracked-files="+mode)
	if err != nil {
		return nil, err
	}
	records := strings.Split(raw, "\x00")
	var paths []string
	for i := 0; i < len(records); i++ {
		record := records[i]
		if record == "" {
			continue
		}
		if len(record) < 4 {
			return nil, errors.New("invalid git status record")
		}
		paths = append(paths, record[3:])
		if strings.ContainsAny(record[:2], "RC") {
			i++
			if i >= len(records) || records[i] == "" {
				return nil, errors.New("invalid git rename record")
			}
			paths = append(paths, records[i])
		}
	}
	return paths, nil
}

type commitPlan struct {
	branch, head, subject, diff string
	files                       []string
}

func (a *app) prepareCommit() (commitPlan, error) {
	var plan commitPlan
	branch, err := a.branch()
	if err != nil {
		return plan, err
	}
	if branch == "main" || branch == "master" {
		return plan, errors.New("release commits require dev or a release topic branch")
	}
	paths, err := a.changed(false)
	if err != nil {
		return plan, err
	}
	if len(paths) == 0 {
		return plan, errors.New("nothing changed; prepare a versions.toml bump first")
	}
	for _, path := range paths {
		if path != "versions.toml" && path != "CHANGELOG.md" {
			return plan, fmt.Errorf("unrelated tracked or staged change: %q", path)
		}
	}
	oldRaw, err := a.git("show", "HEAD:versions.toml")
	if err != nil {
		return plan, err
	}
	previous, err := versions.Parse(oldRaw)
	if err != nil {
		return plan, err
	}
	currentRaw, err := os.ReadFile(filepath.Join(a.root, "versions.toml"))
	if err != nil {
		return plan, err
	}
	current, modules, err := versions.ParseOrdered(string(currentRaw))
	if err != nil {
		return plan, err
	}
	var changed []string
	for _, module := range modules {
		before, err := parseVersion(previous[module])
		if err != nil {
			return plan, err
		}
		after, err := parseVersion(current[module])
		if err != nil {
			return plan, err
		}
		if before.after(after) {
			return plan, fmt.Errorf("%s version must not decrease", module)
		}
		if after.after(before) {
			changed = append(changed, module+" "+after.String())
		}
	}
	if len(changed) == 0 {
		return plan, errors.New("at least one module version must increase relative to HEAD")
	}
	v, err := parseVersion(current["sync"])
	if err != nil {
		return plan, err
	}
	files := []string{"versions.toml"}
	_, changelogExists, err := a.notes(v)
	if err != nil {
		return plan, err
	}
	for _, path := range paths {
		if path == "CHANGELOG.md" && !changelogExists {
			return plan, errors.New("restore CHANGELOG.md and prepare matching release notes before committing")
		}
	}
	if changelogExists {
		if _, err := a.git("ls-files", "--error-unmatch", "--", "CHANGELOG.md"); err != nil {
			return plan, errors.New("untracked CHANGELOG.md must be reviewed and committed separately before release-commit")
		}
		files = append(files, "CHANGELOG.md")
	}
	head, err := a.git("rev-parse", "HEAD^{commit}")
	if err != nil {
		return plan, err
	}
	head = strings.TrimSpace(head)
	remote, err := a.git("ls-remote", "--heads", "origin", "refs/heads/"+branch)
	if err != nil {
		return plan, err
	}
	if remote != "" && strings.Fields(remote)[0] != head {
		return plan, errors.New("HEAD differs from origin branch; push or reconcile existing commits separately before release-commit")
	}
	diff, err := a.git(append([]string{"diff", "HEAD", "--"}, files...)...)
	if err != nil {
		return plan, err
	}
	subject := "release open-video-sync: " + strings.Join(changed, " | ")
	return commitPlan{branch, head, subject, diff, files}, nil
}

func (a *app) commit(yes bool) error {
	plan, err := a.prepareCommit()
	if err != nil {
		return err
	}
	fmt.Fprintf(a.out, "%s\n%s\n", plan.subject, plan.diff)
	if !yes {
		if err := a.confirm("Stage release files, commit, and push origin/"+plan.branch+"? Type yes: ", "yes"); err != nil {
			return err
		}
	}
	current, err := a.prepareCommit()
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(plan, current) {
		return errors.New("release changed during confirmation; review it again")
	}
	if _, err := a.git(append([]string{"add", "--"}, plan.files...)...); err != nil {
		return err
	}
	if _, err := a.git("commit", "-m", plan.subject); err != nil {
		return fmt.Errorf("release files remain staged; inspect Git state before retrying: %w", err)
	}
	if _, err := a.git("push", "--no-follow-tags", "-u", "origin", "HEAD:refs/heads/"+plan.branch); err != nil {
		return fmt.Errorf("release commit retained locally; inspect origin and explicitly retry only the branch push; do not bump again: %w", err)
	}
	fmt.Fprintf(a.out, "Pushed %s. Next: $release-pr (Codex) or /release-pr (Claude Code).\n", plan.subject)
	return nil
}

type tagPlan struct{ head, name, message string }

func (a *app) prepareTag() (tagPlan, error) {
	var plan tagPlan
	branch, err := a.branch()
	if err != nil {
		return plan, err
	}
	if branch != "main" {
		return plan, errors.New("release tags require main")
	}
	paths, err := a.changed(true)
	if err != nil {
		return plan, err
	}
	if len(paths) != 0 {
		return plan, errors.New("release tagging requires a clean checkout, including untracked files")
	}
	head, err := a.git("rev-parse", "HEAD^{commit}")
	if err != nil {
		return plan, err
	}
	head = strings.TrimSpace(head)
	remote, err := a.git("ls-remote", "--heads", "origin", "refs/heads/main")
	if err != nil {
		return plan, err
	}
	if remote == "" || strings.Fields(remote)[0] != head {
		return plan, errors.New("HEAD must equal current origin/main")
	}
	v, err := a.version()
	if err != nil {
		return plan, err
	}
	if v == (version{}) {
		return plan, errors.New("bump the initial 0.0.0 version before tagging a release")
	}
	notes, _, err := a.notes(v)
	if err != nil {
		return plan, err
	}
	name := "v" + v.String()
	local, err := a.git("tag", "--list", name)
	if err != nil {
		return plan, err
	}
	if strings.TrimSpace(local) != "" {
		return plan, fmt.Errorf("%s already exists locally; inspect it rather than recreating it", name)
	}
	remote, err = a.git("ls-remote", "--tags", "origin")
	if err != nil {
		return plan, err
	}
	for line := range strings.SplitSeq(remote, "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		tag := strings.TrimSuffix(strings.TrimPrefix(fields[1], "refs/tags/"), "^{}")
		if tag == name || (strings.HasPrefix(tag, "v") && stableVersion.MatchString(tag[1:]) && fields[0] == head) {
			return plan, fmt.Errorf("release tag %s already exists on origin", tag)
		}
	}
	local, err = a.git("tag", "--points-at", head)
	if err != nil {
		return plan, err
	}
	for tag := range strings.FieldsSeq(local) {
		if strings.HasPrefix(tag, "v") && stableVersion.MatchString(tag[1:]) {
			return plan, fmt.Errorf("HEAD already has release tag %s", tag)
		}
	}
	message := "Release " + name
	if notes != "" {
		message += "\n\n" + notes
	}
	return tagPlan{head, name, message}, nil
}

func (a *app) tag() error {
	if !a.terminal {
		return errors.New("release-tag requires an interactive terminal; YES=1 cannot bypass tag confirmation")
	}
	plan, err := a.prepareTag()
	if err != nil {
		return err
	}
	fmt.Fprintf(a.out, "%s -> %s\n%s\n", plan.name, plan.head, plan.message)
	if err := a.confirm("Type "+plan.name+" to create and push this tag: ", plan.name); err != nil {
		return err
	}
	current, err := a.prepareTag()
	if err != nil {
		return err
	}
	if plan != current {
		return errors.New("release changed during confirmation; review it again")
	}
	if _, err := a.git("tag", "-a", plan.name, plan.head, "-m", plan.message); err != nil {
		return err
	}
	if _, err := a.git("push", "--no-follow-tags", "origin", "refs/tags/"+plan.name); err != nil {
		return fmt.Errorf("local tag %s retained; inspect origin and explicitly retry only that tag push; do not recreate it: %w", plan.name, err)
	}
	fmt.Fprintf(a.out, "Pushed %s. OVS has no automated publication workflow.\n", plan.name)
	return nil
}
