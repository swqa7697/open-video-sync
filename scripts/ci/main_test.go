package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

type fixtureSpec struct {
	version, message, notes, mode string
	extra, removeNotes, merge     bool
}

type fixture struct {
	app
	envMap                    map[string]string
	event                     pullEvent
	parent, parentMerge, head string
}

const oldManifest = "[versions]\nsync = \"1.0.0\"\nweb = \"2.0.0\"\nhelper = \"3.0.0\"\n"
const newManifest = "[versions]\nsync = \"1.1.0\"\nweb = \"2.0.0\"\nhelper = \"3.0.0\"\n"
const fixtureNotes = "# Changelog\n\n## [Unreleased]\n\n## [2026-11-02]\n\n- Release behavior.\n"

func testGit(t *testing.T, root, input string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir, cmd.Stdin = root, strings.NewReader(input)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	raw, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, raw)
	}
	return strings.TrimSpace(string(raw))
}

func newFixture(t *testing.T, change func(*fixtureSpec)) *fixture {
	t.Helper()
	spec := fixtureSpec{version: newManifest, message: "release open-video-sync: sync 1.1.0", notes: fixtureNotes, mode: "100644"}
	if change != nil {
		change(&spec)
	}
	root := t.TempDir()
	testGit(t, root, "", "init", "--quiet", "--initial-branch=main")
	var stream strings.Builder
	commit := func(mark int, ref, parent, merge, message string, files map[string]string) {
		fmt.Fprintf(&stream, "commit %s\nmark :%d\ncommitter CI Test <ci@example.invalid> %d +0000\ndata %d\n%s\n", ref, mark, mark, len(message), message)
		if parent != "" {
			fmt.Fprintf(&stream, "from %s\n", parent)
		}
		if merge != "" {
			fmt.Fprintf(&stream, "merge %s\n", merge)
		}
		stream.WriteString("deleteall\n")
		paths := make([]string, 0, len(files))
		for path := range files {
			paths = append(paths, path)
		}
		slices.Sort(paths)
		for _, path := range paths {
			mode := "100644"
			if mark >= 4 && path == "versions.toml" {
				mode = spec.mode
			}
			fmt.Fprintf(&stream, "M %s inline %s\ndata %d\n%s\n", mode, path, len(files[path]), files[path])
		}
		stream.WriteString("\n")
	}
	files := map[string]string{"versions.toml": oldManifest, "CHANGELOG.md": fixtureNotes, "README.md": "base\n"}
	commit(1, "refs/heads/main", "", "", "base", files)
	files["README.md"] = "feature already tested by full CI\n"
	commit(2, "refs/heads/dev", ":1", "", "feat: change behavior", files)
	commit(3, "refs/heads/parent-merge", ":1", ":2", "parent test merge", files)
	files["versions.toml"], files["CHANGELOG.md"] = spec.version, spec.notes
	if spec.removeNotes {
		delete(files, "CHANGELOG.md")
	}
	if spec.extra {
		files["README.md"] = "untested new behavior\n"
	}
	merge := ""
	if spec.merge {
		merge = ":1"
	}
	commit(4, "refs/heads/dev", ":2", merge, spec.message, files)
	commit(5, "refs/heads/test-merge", ":1", ":4", "current test merge", files)
	stream.WriteString("reset refs/pull/42/head\nfrom :4\n\ndone\n")
	// Seed real histories without staging, commit, or push commands.
	testGit(t, root, stream.String(), "fast-import", "--quiet")
	testGit(t, root, "", "checkout", "--quiet", "--detach", "refs/heads/test-merge")
	testGit(t, root, "", "remote", "add", "origin", root)
	f := &fixture{parent: testGit(t, root, "", "rev-parse", "refs/heads/dev^"), parentMerge: testGit(t, root, "", "rev-parse", "refs/heads/parent-merge"), head: testGit(t, root, "", "rev-parse", "HEAD")}
	f.event.Number, f.event.Repository.FullName = 42, "example/ovs"
	f.event.Pull.Head.SHA, f.event.Pull.Head.Ref, f.event.Pull.Head.Repo.FullName = testGit(t, root, "", "rev-parse", "refs/heads/dev"), "dev", "example/ovs"
	f.event.Pull.Base.SHA, f.event.Pull.Base.Ref, f.event.Pull.Base.Repo.FullName = testGit(t, root, "", "rev-parse", "refs/heads/main"), "main", "example/ovs"
	f.envMap = map[string]string{
		"GITHUB_EVENT_NAME": "pull_request", "GITHUB_REPOSITORY": "example/ovs", "GITHUB_SHA": f.head,
		"GITHUB_RUN_ID": "500", "GITHUB_RUN_ATTEMPT": "1", "GITHUB_WORKFLOW_REF": "example/ovs/" + workflow + "@refs/pull/42/merge",
		"GITHUB_EVENT_PATH": filepath.Join(root, ".misc", "event.json"), "GITHUB_OUTPUT": filepath.Join(root, ".misc", "output"),
		"GITHUB_STEP_SUMMARY": filepath.Join(root, ".misc", "summary"), "GITHUB_SERVER_URL": "https://github.com",
	}
	f.app = app{root: root, env: func(key string) string { return f.envMap[key] }}
	f.saveEvent(t)
	return f
}

func (f *fixture) saveEvent(t *testing.T) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(f.root, ".misc"), 0o700); err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(f.event)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.envMap["GITHUB_EVENT_PATH"], raw, 0o600); err != nil {
		t.Fatal(err)
	}
}

type history struct {
	evidence                            record
	status, conclusion                  string
	missing, expired, badDigest, broken bool
	rerun, newerFailure, forbidden      bool
	noPRAssociation                     bool
}

func (f *fixture) serveHistory(t *testing.T, change func(*history)) {
	t.Helper()
	h := history{status: "completed", conclusion: "success", evidence: record{Schema: 1, Mode: "full", Repository: "example/ovs", PR: 42, SourceSHA: f.parent, BaseSHA: f.event.Pull.Base.SHA, MergeSHA: f.parentMerge, Workflow: workflow, RunID: 400, RunAttempt: 1}}
	if change != nil {
		change(&h)
	}
	var archive bytes.Buffer
	w := zip.NewWriter(&archive)
	file, err := w.Create("full-validation.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(file).Encode(h.evidence); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	data := archive.Bytes()
	if h.broken {
		data = []byte("invalid archive")
	}
	sum := sha256.Sum256(data)
	digest := "sha256:" + hex.EncodeToString(sum[:])
	if h.badDigest {
		digest = "sha256:wrong"
	}
	run := workflowRun{ID: 400, RunAttempt: 1, HeadSHA: f.parent, Path: workflow, Event: "pull_request", Status: h.status, Conclusion: h.conclusion}
	run.Repository.FullName, run.HeadRepo.FullName = "example/ovs", "example/ovs"
	run.PullRequests = append(run.PullRequests, struct {
		Number int64 `json:"number"`
	}{42})
	if h.noPRAssociation {
		run.PullRequests = nil
	}
	details := 0
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/download" {
			if r.Header.Get("Authorization") != "" {
				t.Error("artifact redirect received the Actions token")
			}
			_, _ = w.Write(data)
			return
		}
		if r.Header.Get("Authorization") != "Bearer synthetic-ci-token" {
			t.Error("GitHub request is missing its synthetic token")
		}
		if h.forbidden {
			w.WriteHeader(http.StatusForbidden)
			return
		}
		var value any
		switch r.URL.Path {
		case "/repos/example/ovs/actions/workflows/ci.yaml/runs":
			runs := []workflowRun{run}
			if h.newerFailure {
				failed := run
				failed.ID, failed.Conclusion = 401, "failure"
				runs = append(runs, failed)
			}
			value = map[string]any{"total_count": len(runs), "workflow_runs": runs}
		case "/repos/example/ovs/actions/runs/400", "/repos/example/ovs/actions/runs/401":
			details++
			latest := run
			if strings.HasSuffix(r.URL.Path, "/401") {
				latest.ID, latest.Conclusion = 401, "failure"
			}
			if h.rerun && details > 1 {
				latest.RunAttempt, latest.Status = 2, "in_progress"
			}
			value = latest
		case "/repos/example/ovs/actions/runs/400/artifacts":
			items := []any{}
			if !h.missing {
				items = append(items, map[string]any{"id": 9, "name": "full-ci-400-1", "digest": digest, "expired": h.expired})
			}
			value = map[string]any{"total_count": len(items), "artifacts": items}
		case "/repos/example/ovs/actions/artifacts/9/zip":
			http.Redirect(w, r, server.URL+"/download", http.StatusFound)
			return
		default:
			t.Errorf("unexpected history endpoint: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(value)
	}))
	t.Cleanup(server.Close)
	f.github = githubClient{base: server.URL, token: "synthetic-ci-token", client: server.Client()}
}

func (f *fixture) readPlan(t *testing.T) plan {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(f.root, ".misc", "ci", "plan.json"))
	if err != nil {
		t.Fatal(err)
	}
	var p plan
	if err := json.Unmarshal(raw, &p); err != nil {
		t.Fatal(err)
	}
	return p
}

// These cases own the shortcut contract: all uncertainty must execute the full suite.
func TestCIValidationModes(t *testing.T) {
	for _, tc := range []struct {
		name    string
		spec    func(*fixtureSpec)
		event   func(*fixture)
		history func(*history)
		want    string
	}{
		{name: "release-after-full", want: "release"},
		{name: "historical-pr-association-empty", history: func(h *history) { h.noPRAssociation = true }, want: "release"},
		{name: "ordinary-commit", spec: func(s *fixtureSpec) { s.message = "docs: update release notes" }},
		{name: "dev-target", event: func(f *fixture) { f.event.Pull.Base.Ref = "dev" }},
		{name: "fork", event: func(f *fixture) { f.event.Pull.Head.Repo.FullName = "fork/ovs" }},
		{name: "code-mixed-in", spec: func(s *fixtureSpec) { s.extra = true }},
		{name: "file-mode-changed", spec: func(s *fixtureSpec) { s.mode = "100755" }},
		{name: "changelog-deleted", spec: func(s *fixtureSpec) { s.removeNotes = true }},
		{name: "merge-commit", spec: func(s *fixtureSpec) { s.merge = true }},
		{name: "api-unavailable", history: func(h *history) { h.forbidden = true }},
		{name: "artifact-missing", history: func(h *history) { h.missing = true }},
		{name: "artifact-expired", history: func(h *history) { h.expired = true }},
		{name: "artifact-digest", history: func(h *history) { h.badDigest = true }},
		{name: "artifact-invalid", history: func(h *history) { h.broken = true }},
		{name: "previous-release-mode", history: func(h *history) { h.evidence.Mode = "release" }},
		{name: "different-base", history: func(h *history) { h.evidence.BaseSHA = strings.Repeat("a", 40) }},
		{name: "different-source", history: func(h *history) { h.evidence.SourceSHA = strings.Repeat("a", 40) }},
		{name: "different-pr", history: func(h *history) { h.evidence.PR++ }},
		{name: "empty-association-wrong-pr", history: func(h *history) { h.noPRAssociation = true; h.evidence.PR++ }},
		{name: "different-workflow", history: func(h *history) { h.evidence.Workflow = "other.yaml" }},
		{name: "stale-attempt", history: func(h *history) { h.evidence.RunAttempt++ }},
		{name: "parent-failed", history: func(h *history) { h.conclusion = "failure" }},
		{name: "newer-failure", history: func(h *history) { h.newerFailure = true }},
		{name: "rerun-started", history: func(h *history) { h.rerun = true }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t, tc.spec)
			if tc.event != nil {
				tc.event(f)
				f.saveEvent(t)
			}
			f.serveHistory(t, tc.history)
			if err := f.run(context.Background(), []string{"plan"}); err != nil {
				t.Fatal(err)
			}
			want := tc.want
			if want == "" {
				want = "full"
			}
			p := f.readPlan(t)
			if p.Record.Mode != want {
				t.Fatalf("mode = %s, want %s (%s)", p.Record.Mode, want, p.Reason)
			}
			output, err := os.ReadFile(f.envMap["GITHUB_OUTPUT"])
			if err != nil || string(output) != "mode="+want+"\n" {
				t.Fatalf("workflow output = %q, %v", output, err)
			}
			if want == "release" && (p.FullRunID != 400 || p.FullRunAttempt != 1) {
				t.Fatal("release mode lost the full CI run identity")
			}
		})
	}
}

func TestCIRejectsInvalidReleaseMetadata(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(*fixtureSpec)
	}{
		{"downgrade", func(s *fixtureSpec) { s.version = strings.Replace(newManifest, "1.1.0", "0.9.0", 1) }},
		{"no-bump", func(s *fixtureSpec) { s.version = "# comment\n" + oldManifest }},
		{"invalid-version", func(s *fixtureSpec) { s.version = strings.Replace(newManifest, "1.1.0", "01.1.0", 1) }},
		{"wrong-message", func(s *fixtureSpec) { s.message = "release open-video-sync: web 1.1.0" }},
		{"message-body", func(s *fixtureSpec) { s.message += "\n\n[skip ci]" }},
		{"empty-notes", func(s *fixtureSpec) { s.notes = "## [Unreleased]\n" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t, tc.change)
			if err := f.run(context.Background(), []string{"plan"}); err == nil {
				t.Fatal("invalid release metadata must fail before choosing a mode")
			}
			if _, err := os.Stat(f.envMap["GITHUB_OUTPUT"]); !os.IsNotExist(err) {
				t.Fatal("invalid release published a workflow mode")
			}
		})
	}
}

func TestCIFinishRecordsOnlyFullRunsAndRejectsMovingRefs(t *testing.T) {
	for _, scenario := range []string{"full", "release", "base-moved", "source-moved", "dirty", "wrong-merge"} {
		t.Run(scenario, func(t *testing.T) {
			var spec func(*fixtureSpec)
			if scenario == "full" {
				spec = func(s *fixtureSpec) { s.message = "docs: ordinary commit" }
			}
			f := newFixture(t, spec)
			f.serveHistory(t, nil)
			if err := f.run(context.Background(), []string{"plan"}); err != nil {
				t.Fatal(err)
			}
			switch scenario {
			case "base-moved":
				testGit(t, f.root, "", "update-ref", "refs/heads/main", f.parent)
			case "source-moved":
				testGit(t, f.root, "", "update-ref", "refs/pull/42/head", f.parent)
			case "dirty":
				if err := os.WriteFile(filepath.Join(f.root, "README.md"), []byte("untested\n"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "wrong-merge":
				testGit(t, f.root, "", "checkout", "--quiet", "--detach", f.parentMerge)
			}
			err := f.run(context.Background(), []string{"finish"})
			if scenario != "full" && scenario != "release" {
				if err == nil {
					t.Fatal("changed validation snapshot must fail")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(filepath.Join(f.root, ".misc", "ci", "full-validation.json"))
			if scenario == "release" {
				if !os.IsNotExist(err) {
					t.Fatal("release validation produced reusable full evidence")
				}
				return
			}
			var evidence record
			if err != nil || json.Unmarshal(raw, &evidence) != nil || evidence.Mode != "full" || evidence.SourceSHA != f.event.Pull.Head.SHA || evidence.BaseSHA != f.event.Pull.Base.SHA || evidence.MergeSHA != f.head {
				t.Fatalf("incorrect full evidence: %s, %v", raw, err)
			}
		})
	}
}
