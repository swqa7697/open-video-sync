package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/swqa7697/open-video-sync/scripts/internal/versions"
)

func gitFixtureCommand(t *testing.T, dir, input string, args ...string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Stdin = strings.NewReader(input)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	raw, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, raw)
	}
	return string(raw)
}

func manifest(v string) string {
	return fmt.Sprintf("[versions]\nsync = %q\nweb = %q\nhelper = %q\n", strings.TrimSpace(v), "0.0.0", "1.1.0")
}

func writeFixture(t *testing.T, root, name, text string) {
	t.Helper()
	if name == "versions.toml" {
		text = manifest(text)
	}
	if err := os.WriteFile(filepath.Join(root, name), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// Seed through fast-import so these tests never invoke add, commit, or push.
func releaseFixture(t *testing.T, v, changelog string) (*app, string) {
	t.Helper()
	root := t.TempDir()
	remote := filepath.Join(root, "origin.git")
	gitFixtureCommand(t, root, "", "init", "--bare", "--initial-branch=main", remote)
	stream := "commit refs/heads/main\nmark :1\ncommitter Release Test <release@example.invalid> 1 +0000\ndata 7\nfixture\n"
	for _, file := range []struct{ name, text string }{{"versions.toml", manifest(v)}, {"README.md", "fixture\n"}, {"CHANGELOG.md", changelog}} {
		if file.text != "" {
			stream += fmt.Sprintf("M 100644 inline %s\ndata %d\n%s\n", file.name, len(file.text), file.text)
		}
	}
	stream += "\nreset refs/heads/dev\nfrom :1\n\ndone\n"
	gitFixtureCommand(t, remote, stream, "fast-import", "--quiet")
	checkout := filepath.Join(root, "checkout")
	gitFixtureCommand(t, root, "", "clone", "--quiet", "--branch", "dev", remote, checkout)
	return &app{ctx: context.Background(), root: checkout, in: strings.NewReader(""), out: &bytes.Buffer{}}, remote
}

func fixtureState(t *testing.T, a *app) string {
	t.Helper()
	var state strings.Builder
	for _, args := range [][]string{{"show-ref"}, {"ls-files", "--stage"}, {"diff", "HEAD"}, {"status", "--porcelain=v1", "-z"}} {
		state.WriteString(gitFixtureCommand(t, a.root, "", args...))
	}
	return state.String()
}

func TestBumpPreparesOnlyVersion(t *testing.T) {
	for _, tc := range []struct{ module, part, want string }{
		{"sync", "major", "2.0.0"},
		{"sync", "minor", "1.3.0"},
		{"sync", "patch", "1.2.4"},
		{"web", "minor", "0.1.0"},
		{"helper", "patch", "1.1.1"},
	} {
		t.Run(tc.module+"/"+tc.part, func(t *testing.T) {
			a, _ := releaseFixture(t, "1.2.3\n", "# Changelog\n\n## [Unreleased]\n\n- A change.\n")
			const comment = "# Preserve release comments.\n"
			if err := os.WriteFile(filepath.Join(a.root, "versions.toml"), []byte(comment+manifest("1.2.3")), 0o644); err != nil {
				t.Fatal(err)
			}
			index := gitFixtureCommand(t, a.root, "", "ls-files", "--stage")
			refs := gitFixtureCommand(t, a.root, "", "show-ref")
			if err := a.execute([]string{"bump", tc.part, tc.module}); err != nil {
				t.Fatal(err)
			}
			initial := map[string]string{"sync": "1.2.3", "web": "0.0.0", "helper": "1.1.0"}
			want := comment + strings.Replace(manifest("1.2.3"), tc.module+" = "+fmt.Sprintf("%q", initial[tc.module]), tc.module+" = "+fmt.Sprintf("%q", tc.want), 1)
			raw, err := os.ReadFile(filepath.Join(a.root, "versions.toml"))
			if err != nil || string(raw) != want {
				t.Fatalf("versions.toml=%q, error=%v", raw, err)
			}
			if changed := gitFixtureCommand(t, a.root, "", "diff", "--name-only"); changed != "versions.toml\n" {
				t.Fatalf("changed files: %q", changed)
			}
			if index != gitFixtureCommand(t, a.root, "", "ls-files", "--stage") || refs != gitFixtureCommand(t, a.root, "", "show-ref") {
				t.Fatal("bump changed the index or refs")
			}
			state := fixtureState(t, a)
			if err := a.bump(tc.part, tc.module); err == nil || state != fixtureState(t, a) {
				t.Fatal("a repeated bump must fail without changing the prepared version")
			}
			// Other modules can still be prepared in the same manifest.
			if tc.module != "sync" {
				if err := a.bump("patch"); err != nil {
					t.Fatal(err)
				}
				current, err := versions.Read(filepath.Join(a.root, "versions.toml"))
				if err != nil || current[tc.module] != tc.want || current["sync"] != "1.2.4" {
					t.Fatalf("module bump lost a prepared version: %v, %v", current, err)
				}
			}
		})
	}
}

func TestBumpRejectsInvalidPreparation(t *testing.T) {
	for _, tc := range []struct{ name, v, part string }{
		{"prefix", "v1.2.3\n", "patch"},
		{"leading-zero", "01.2.3\n", "minor"},
		{"overflow", "18446744073709551615.0.0\n", "major"},
		{"invalid-part", "1.2.3\n", "feature"},
		{"main", "1.2.3\n", "patch"},
		{"detached", "1.2.3\n", "patch"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, _ := releaseFixture(t, tc.v, "")
			if tc.name == "main" {
				gitFixtureCommand(t, a.root, "", "checkout", "--quiet", "main")
			} else if tc.name == "detached" {
				gitFixtureCommand(t, a.root, "", "checkout", "--quiet", "--detach")
			}
			state := fixtureState(t, a)
			if err := a.bump(tc.part); err == nil || state != fixtureState(t, a) {
				t.Fatal("invalid preparation must fail without changing checkout state")
			}
		})
	}
}

func TestReleaseCommitPreviewAndRefusalPreserveCheckout(t *testing.T) {
	for _, tc := range []struct {
		name, current, subject string
		notes                  bool
	}{
		{"sync", manifest("1.10.0"), "release open-video-sync: sync 1.10.0", false},
		{"web", "[versions]\nsync = \"1.2.3\"\nweb = \"0.1.0\"\nhelper = \"1.1.0\"\n", "release open-video-sync: web 0.1.0", true},
		{"helper", "[versions]\nsync = \"1.2.3\"\nweb = \"0.0.0\"\nhelper = \"1.1.1\"\n", "release open-video-sync: helper 1.1.1", false},
		{"multiple-reordered", "[versions]\nhelper = \"1.2.0\"\nsync = \"1.10.0\"\nweb = \"0.2.0\"\n", "release open-video-sync: helper 1.2.0 | sync 1.10.0 | web 0.2.0", true},
		{"partial-reordered", "[versions]\nhelper = \"1.2.0\"\nsync = \"1.2.3\"\nweb = \"0.1.0\"\n", "release open-video-sync: helper 1.2.0 | web 0.1.0", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			notes := ""
			if tc.notes {
				notes = "# Changelog\n\n## [2026-10-26]\n\n- Previous behavior.\n"
			}
			a, remote := releaseFixture(t, "1.2.3\n", notes)
			if err := os.WriteFile(filepath.Join(a.root, "versions.toml"), []byte(tc.current), 0o644); err != nil {
				t.Fatal(err)
			}
			if tc.notes {
				writeFixture(t, a.root, "CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n## [2026-10-27]\n\n- New behavior.\n\n## [2026-10-26]\n\n- Previous behavior.\n")
			}
			state := fixtureState(t, a)
			remoteRefs := gitFixtureCommand(t, remote, "", "show-ref")
			plan, err := a.prepareCommit()
			if err != nil {
				t.Fatal(err)
			}
			if plan.branch != "dev" || plan.subject != tc.subject || len(plan.files) != 1+btoi(tc.notes) {
				t.Fatalf("unexpected release: %+v", plan)
			}
			for _, terminal := range []bool{false, true} {
				a.terminal = terminal
				a.in = strings.NewReader("no\n")
				if err := a.commit(false); err == nil {
					t.Fatal("release commit must require confirmation")
				}
			}
			preview := a.out.(*bytes.Buffer).String()
			if !strings.Contains(preview, "diff --git a/versions.toml b/versions.toml") || !strings.HasPrefix(preview, tc.subject+"\n") {
				t.Fatalf("missing version or subject in preview: %s", preview)
			}
			if state != fixtureState(t, a) || remoteRefs != gitFixtureCommand(t, remote, "", "show-ref") {
				t.Fatal("preparation or refusal changed local/remote Git state")
			}
		})
	}
}

func btoi(value bool) int {
	if value {
		return 1
	}
	return 0
}

func TestReleaseCommitRejectsUnsafeContents(t *testing.T) {
	for _, scenario := range []string{"no-bump", "comment-only", "downgrade", "helper-downgrade", "main", "unrelated-worktree", "unrelated-index", "remote-moved", "missing-notes", "deleted-notes", "untracked-notes", "invalid-date", "version-notes", "empty-latest-notes", "duplicate-date"} {
		t.Run(scenario, func(t *testing.T) {
			a, remote := releaseFixture(t, "1.2.3\n", "")
			writeFixture(t, a.root, "versions.toml", "1.3.0\n")
			switch scenario {
			case "no-bump":
				writeFixture(t, a.root, "versions.toml", "1.2.3\n")
			case "comment-only":
				if err := os.WriteFile(filepath.Join(a.root, "versions.toml"), []byte("# No version changes.\n"+manifest("1.2.3")), 0o644); err != nil {
					t.Fatal(err)
				}
			case "downgrade":
				writeFixture(t, a.root, "versions.toml", "1.1.9\n")
			case "helper-downgrade":
				raw := strings.Replace(manifest("1.3.0"), `helper = "1.1.0"`, `helper = "1.0.0"`, 1)
				if err := os.WriteFile(filepath.Join(a.root, "versions.toml"), []byte(raw), 0o644); err != nil {
					t.Fatal(err)
				}
			case "main":
				gitFixtureCommand(t, a.root, "", "checkout", "--quiet", "main")
			case "unrelated-worktree":
				writeFixture(t, a.root, "README.md", "unrelated edit\n")
			case "unrelated-index":
				blob := strings.TrimSpace(gitFixtureCommand(t, a.root, "staged edit\n", "hash-object", "-w", "--stdin"))
				gitFixtureCommand(t, a.root, "", "update-index", "--cacheinfo", "100644,"+blob+",README.md")
			case "remote-moved":
				head := strings.TrimSpace(gitFixtureCommand(t, remote, "", "rev-parse", "refs/heads/dev"))
				stream := "commit refs/heads/dev\ncommitter Release Test <release@example.invalid> 2 +0000\ndata 5\nmoved\nfrom " + head + "\n\ndone\n"
				gitFixtureCommand(t, remote, stream, "fast-import", "--quiet")
			case "missing-notes", "deleted-notes":
				// Make the changelog tracked without staging or committing commands.
				a, remote = releaseFixture(t, "1.2.3\n", "# Changelog\n\n## [Unreleased]\n\n- Pending change.\n")
				writeFixture(t, a.root, "versions.toml", "1.3.0\n")
				if scenario == "deleted-notes" {
					if err := os.Remove(filepath.Join(a.root, "CHANGELOG.md")); err != nil {
						t.Fatal(err)
					}
				}
			case "untracked-notes":
				writeFixture(t, a.root, "CHANGELOG.md", "## [2026-10-27]\n\n- New behavior.\n")
			case "invalid-date", "version-notes", "empty-latest-notes", "duplicate-date":
				a, remote = releaseFixture(t, "1.2.3\n", "## [2026-10-26]\n\n- Previous behavior.\n")
				writeFixture(t, a.root, "versions.toml", "1.3.0\n")
				notes := map[string]string{
					"invalid-date":       "## [2026-02-30]\n\n- New behavior.\n",
					"version-notes":      "## [1.3.0] - 2026-10-27\n\n- New behavior.\n",
					"empty-latest-notes": "## [2026-10-27]\n\n## [2026-10-26]\n\n- Previous behavior.\n",
					"duplicate-date":     "## [2026-10-27]\n\n- New behavior.\n\n## [2026-10-27]\n\n- Previous behavior.\n",
				}
				writeFixture(t, a.root, "CHANGELOG.md", notes[scenario])
			}
			state := fixtureState(t, a)
			remoteRefs := gitFixtureCommand(t, remote, "", "show-ref")
			if err := a.commit(true); err == nil {
				t.Fatal("unsafe release must fail even with --yes")
			}
			if state != fixtureState(t, a) || remoteRefs != gitFixtureCommand(t, remote, "", "show-ref") {
				t.Fatal("rejected release changed checkout, index, or remote")
			}
		})
	}
}

func TestReleaseTagPreviewAndGuards(t *testing.T) {
	for _, scenario := range []string{"valid", "dev", "dirty", "untracked", "stale-main", "local-tag", "remote-tag", "tagged-head", "missing-notes", "noninteractive"} {
		t.Run(scenario, func(t *testing.T) {
			notes := "# Changelog\n\n## [Unreleased]\n\n## [2026-10-27]\n\n- New behavior.\n\n## [2026-10-26]\n\n- Previous behavior.\n"
			if scenario == "missing-notes" {
				notes = ""
			}
			a, remote := releaseFixture(t, "1.2.3\n", notes)
			gitFixtureCommand(t, a.root, "", "checkout", "--quiet", "main")
			head := strings.TrimSpace(gitFixtureCommand(t, a.root, "", "rev-parse", "HEAD"))
			switch scenario {
			case "dev":
				gitFixtureCommand(t, a.root, "", "checkout", "--quiet", "dev")
			case "dirty":
				writeFixture(t, a.root, "README.md", "unreleased edit\n")
			case "untracked":
				writeFixture(t, a.root, "untracked.txt", "untracked\n")
			case "stale-main":
				stream := "commit refs/heads/main\ncommitter Release Test <release@example.invalid> 2 +0000\ndata 5\nmoved\nfrom " + head + "\n\ndone\n"
				gitFixtureCommand(t, remote, stream, "fast-import", "--quiet")
			case "local-tag":
				gitFixtureCommand(t, a.root, "", "update-ref", "refs/tags/v2026-10-27", head)
			case "remote-tag":
				gitFixtureCommand(t, remote, "", "update-ref", "refs/tags/v2026-10-27", head)
			case "tagged-head":
				gitFixtureCommand(t, remote, "", "update-ref", "refs/tags/v2026-10-26", head)
			}
			state := fixtureState(t, a)
			remoteRefs := gitFixtureCommand(t, remote, "", "show-ref")
			if scenario == "valid" {
				plan, err := a.prepareTag()
				if err != nil || plan.name != "v2026-10-27" || plan.head != head || !strings.Contains(plan.message, "New behavior.") || strings.Contains(plan.message, "Previous behavior.") {
					t.Fatalf("tag plan: %+v, error: %v", plan, err)
				}
			} else if scenario != "noninteractive" {
				if _, err := a.prepareTag(); err == nil {
					t.Fatal("unsafe tag preparation succeeded")
				}
			}
			a.terminal = scenario != "noninteractive"
			a.in = strings.NewReader("incorrect\n")
			if err := a.tag(); err == nil {
				t.Fatal("tag must require matching interactive confirmation")
			}
			if state != fixtureState(t, a) || remoteRefs != gitFixtureCommand(t, remote, "", "show-ref") {
				t.Fatal("refused tag changed local or remote state")
			}
		})
	}
}
