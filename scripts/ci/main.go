// Command ci selects and records full or release validation in one GitHub Actions job.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const workflow = ".github/workflows/ci.yaml"

type record struct {
	Schema     int    `json:"schema"`
	Mode       string `json:"mode"`
	Repository string `json:"repository"`
	PR         int64  `json:"pr"`
	SourceSHA  string `json:"source_sha"`
	BaseSHA    string `json:"base_sha"`
	MergeSHA   string `json:"merge_sha"`
	Workflow   string `json:"workflow"`
	RunID      int64  `json:"run_id"`
	RunAttempt int64  `json:"run_attempt"`
}

type plan struct {
	Record         record `json:"record"`
	Reason         string `json:"reason"`
	FullRunID      int64  `json:"full_run_id,omitempty"`
	FullRunAttempt int64  `json:"full_run_attempt,omitempty"`
}

type pullEvent struct {
	Number     int64 `json:"number"`
	Repository struct {
		FullName string `json:"full_name"`
	} `json:"repository"`
	Pull struct {
		Head branch `json:"head"`
		Base branch `json:"base"`
	} `json:"pull_request"`
}

type branch struct {
	SHA  string `json:"sha"`
	Ref  string `json:"ref"`
	Repo struct {
		FullName string `json:"full_name"`
	} `json:"repo"`
}

type app struct {
	root   string
	env    func(string) string
	github githubClient
}

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	ctx, timeout := context.WithTimeout(ctx, 2*time.Minute)
	defer timeout()
	a := app{root: ".", env: os.Getenv, github: githubClient{base: os.Getenv("GITHUB_API_URL"), token: os.Getenv("GITHUB_TOKEN"), client: &http.Client{Timeout: 15 * time.Second}}}
	if err := a.run(ctx, os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "ci:", err)
		os.Exit(1)
	}
}

func (a *app) run(ctx context.Context, args []string) error {
	if len(args) != 1 || (args[0] != "plan" && args[0] != "finish") {
		return errors.New("usage: ci {plan | finish}; requires a GitHub pull_request checkout")
	}
	root, err := a.git(ctx, "rev-parse", "--show-toplevel")
	if err != nil {
		return err
	}
	a.root = strings.TrimSpace(root)
	current, event, err := a.snapshot(ctx)
	if err != nil {
		return err
	}
	if args[0] == "finish" {
		return a.finish(ctx, current, event)
	}
	p, err := a.choose(ctx, current, event)
	if err != nil {
		return err
	}
	if err := a.writeJSON("plan.json", p); err != nil {
		return err
	}
	if err := appendFile(a.env("GITHUB_OUTPUT"), "mode="+p.Record.Mode+"\n"); err != nil {
		return err
	}
	fmt.Printf("CI mode: %s (%s)\n", p.Record.Mode, p.Reason)
	return nil
}

var shaPattern = regexp.MustCompile(`^[a-f0-9]{40}$`)
var repositoryPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

func (a *app) snapshot(ctx context.Context) (record, pullEvent, error) {
	r := record{Schema: 1, Mode: "full", Workflow: workflow, Repository: a.env("GITHUB_REPOSITORY"), MergeSHA: a.env("GITHUB_SHA")}
	var event pullEvent
	if a.env("GITHUB_EVENT_NAME") != "pull_request" || !repositoryPattern.MatchString(r.Repository) {
		return r, event, errors.New("CI requires a pull_request event and repository")
	}
	file, err := os.Open(a.env("GITHUB_EVENT_PATH"))
	if err != nil {
		return r, event, err
	}
	defer file.Close()
	if err := json.NewDecoder(io.LimitReader(file, 1<<20)).Decode(&event); err != nil {
		return r, event, fmt.Errorf("read pull request event: %w", err)
	}
	r.PR, r.SourceSHA, r.BaseSHA = event.Number, event.Pull.Head.SHA, event.Pull.Base.SHA
	r.RunID, err = strconv.ParseInt(a.env("GITHUB_RUN_ID"), 10, 64)
	if err != nil {
		return r, event, err
	}
	r.RunAttempt, err = strconv.ParseInt(a.env("GITHUB_RUN_ATTEMPT"), 10, 64)
	if err != nil {
		return r, event, err
	}
	if r.PR <= 0 || r.RunID <= 0 || r.RunAttempt <= 0 || event.Repository.FullName != r.Repository || event.Pull.Base.Repo.FullName != r.Repository ||
		!shaPattern.MatchString(r.SourceSHA) || !shaPattern.MatchString(r.BaseSHA) || !shaPattern.MatchString(r.MergeSHA) ||
		!strings.HasPrefix(a.env("GITHUB_WORKFLOW_REF"), r.Repository+"/"+workflow+"@") {
		return r, event, errors.New("incomplete or mismatched CI identity")
	}
	parents, err := a.git(ctx, "rev-list", "--parents", "-n", "1", "HEAD")
	if err != nil {
		return r, event, err
	}
	fields := strings.Fields(parents)
	if len(fields) != 3 || fields[0] != r.MergeSHA || fields[1] != r.BaseSHA || fields[2] != r.SourceSHA {
		return r, event, errors.New("checkout must be the event's exact base/source test merge; refresh the PR if its base changed")
	}
	return r, event, nil
}

func (a *app) git(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = a.root
	raw, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("git %s failed: %w", args[0], err)
	}
	return string(raw), nil
}

func (a *app) writeJSON(name string, value any) error {
	directory := filepath.Join(a.root, ".misc", "ci")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(directory, name), append(raw, '\n'), 0o600)
}

func appendFile(path, value string) error {
	if path == "" {
		return errors.New("GitHub Actions output path is missing")
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := io.WriteString(file, value)
	return errors.Join(writeErr, file.Close())
}

func (a *app) finish(ctx context.Context, current record, event pullEvent) error {
	raw, err := os.ReadFile(filepath.Join(a.root, ".misc", "ci", "plan.json"))
	if err != nil {
		return err
	}
	var p plan
	if err := json.Unmarshal(raw, &p); err != nil {
		return err
	}
	current.Mode = p.Record.Mode
	if current != p.Record || (current.Mode != "full" && current.Mode != "release") {
		return errors.New("CI snapshot changed after planning")
	}
	if _, err := a.git(ctx, "diff", "--exit-code", "HEAD"); err != nil {
		return errors.New("validation modified tracked files")
	}
	summary := fmt.Sprintf("### CI validation: %s\n\nSource: `%s`\n\nBase: `%s`\n\n", current.Mode, current.SourceSHA, current.BaseSHA)
	if current.Mode == "full" {
		if err := a.writeJSON("full-validation.json", current); err != nil {
			return err
		}
		summary += "All static, unit, race, browser, image, and proxy checks passed.\n"
	} else {
		baseRef := "refs/heads/" + event.Pull.Base.Ref
		headRef := fmt.Sprintf("refs/pull/%d/head", current.PR)
		if _, err := a.git(ctx, "check-ref-format", baseRef); err != nil {
			return err
		}
		remote, err := a.git(ctx, "ls-remote", "--exit-code", "origin", baseRef, headRef)
		if err != nil {
			return err
		}
		refs := make(map[string]string)
		for line := range strings.SplitSeq(remote, "\n") {
			fields := strings.Fields(line)
			if len(fields) == 2 {
				refs[fields[1]] = fields[0]
			}
		}
		if refs[baseRef] != current.BaseSHA || refs[headRef] != current.SourceSHA || p.FullRunID <= 0 || p.FullRunAttempt <= 0 {
			return errors.New("release source/base moved or full CI evidence is missing; refresh validation")
		}
		summary += fmt.Sprintf("Release metadata, static checks, production image, and image smoke passed.\n\nReused full CI: %s/%s/actions/runs/%d/attempts/%d\n", a.env("GITHUB_SERVER_URL"), current.Repository, p.FullRunID, p.FullRunAttempt)
	}
	fmt.Print(summary)
	return appendFile(a.env("GITHUB_STEP_SUMMARY"), summary)
}
