---
name: release-pr
description: Prepare an Open Video Sync release from dev or a release topic branch into main. Open or reuse the PR before bumping, diagnose and repair CI failures until CI passes, then prepare the version and approved release commit and verify final CI. Excludes ordinary feature PRs, merging, tagging, and publication.
---

# Prepare and open an OVS release PR

Canonical instructions live in `.agents/skills/release-pr`. Codex invokes `$release-pr`;
Claude Code invokes `/release-pr` through the `.claude/skills/release-pr` symlink.
Run from the repository root with Git and authenticated `gh`.
Read [AGENTS.md](../../../AGENTS.md), [README](../../../README.md), and the repository's
PR templates and workflows before preparation.

`release-pr` opens or reuses the PR, obtains successful hosted CI, and only then prepares
the version bump. CI diagnosis, repair, and verification are self-contained below; no
other skills are required.

Creating and updating the release PR follows the user's authorization. If PR creation
is not yet authorized, present the preliminary title/body, source/base, and draft status
before asking. **Explicit authorization is required before planning or executing staging,
committing, or pushing**, including CI repair commits and `make release-commit YES=1`.
Invoking `release-pr` alone does not approve Git writes. Reuse authorization already given
in the session, including an explicitly approved CI repair commit/push loop on the named
branch; do not ask again for actions within that scope. Without such authorization,
finish the reversible fixes and validation before requesting approval for Git writes.
Preserve unrelated staged and working-tree changes. Never switch branches, reset, stash,
merge, tag, or publish without separate authorization.

## Inspect the release range

Use `dev` as the default source and `main` as the base. Honor an explicitly selected release
topic branch. Fetch and resolve remote commits so the review has a precise basis:

```bash
git status --short
git fetch origin --prune
release_branch=dev
base_sha=$(git rev-parse --verify 'refs/remotes/origin/main^{commit}')
head_sha=$(git rev-parse --verify "refs/remotes/origin/${release_branch}^{commit}")
git log "${base_sha}..${head_sha}" --no-merges --format='%h %s'
git diff --stat "${base_sha}...${head_sha}"
gh pr list --base main --head "$release_branch" --state open --json number,url,isDraft,headRefOid
```

Set `release_branch` to the requested branch before resolving commits. Reject `main`, an
absent remote source, or an empty release range. Confirm `gh` targets the same repository
as `origin`. Authentication/access failures are blockers for PR creation.

If a matching open PR already exists, reuse it and continue through the CI gate. An
existing PR is not a completion condition. Do not create a duplicate or bump again when
resuming an already prepared release.

Preparation requires the checked-out source branch at `head_sha`, with no unrelated tracked
or staged changes. Report unpushed, divergent, or dirty work as a prerequisite; do not include
it silently or commit it as release metadata. The recovery instructions below cover an
approved release commit awaiting push. A previously prepared versions.toml/changelog diff can
be reviewed and reused. If another branch is checked out, finish read-only analysis and
identify the required checkout without switching automatically.

Read `versions.toml` and `Makefile` from both resolved snapshots when present. Inspect the full
application diff plus README, PRD, DESIGN, manifests, migrations, deployment, and workflows.
Use the diff rather than commit prefixes alone to decide release behavior. Local files may
contain proposed behavior that the remote release does not contain.

## Open or reuse the PR before any version bump

For a new PR, prepare an English title such as `chore(release): prepare ovs release`.
Follow the repository PR template when present. Include the reviewed source/base SHAs,
implemented changes, known release gates, and actual validation. State that the version
is not selected and hosted CI is pending. Do not run a bump command or edit release
metadata yet. Default to a draft during preparation; inspect workflow triggers to ensure
the selected PR state starts CI.

Write the reviewed body with real newlines to a disposable file under `/tmp/codex/`
and pass it with `--body-file`. Retained evidence belongs under `.misc/`.
Recheck for an existing PR immediately before creation, then, when authorized, run:

```bash
gh pr create --base main --head "$release_branch" --title "$release_title" --body-file "$body_file" --draft
```

Honor an explicitly approved ready PR instead of adding `--draft`. If creation fails or
times out, query for an existing PR before retrying. Resolve the cause rather than
repeating an unchanged network/authentication failure. Remove the body file after use
when practical. Record the PR number and URL, then continue; do not stop at creation.

## Hosted CI gate and repair loop

**Do not choose/apply a new version bump until hosted CI passes for the current PR
source and base.** Local checks, an older green run, and an empty check list do not satisfy
this gate. Use the same gate after each repair push and after the release commit.

Read `.github/workflows/` and applicable required checks to identify the expected PR jobs.
Query the PR and its checks, then inspect the linked workflow runs:

```bash
gh pr view "$pr_number" --json url,state,headRefName,headRefOid,baseRefName,baseRefOid,isDraft
gh pr checks "$pr_number" --json name,state,bucket,workflow,event,link
gh run view "$run_id" --json headSha,event,status,conclusion,attempt,jobs,url
```

Confirm the PR is open with the selected source/base. Associate runs with that PR,
workflow event, current source SHA, current base, and latest attempt. Account for PR
workflows testing a synthetic merge commit. Do not compare unrelated push runs or use
stale checks from before a source/base update. Required and expected applicable jobs
must complete successfully. Pending, missing, cancelled, timed-out, or unexpectedly
skipped jobs keep the gate closed; a successful job does not hide another failed job.

Poll while jobs are queued/running or still registering. Use short waits or bounded
watch calls so progress updates remain possible at least every 60 seconds. Treat pending
status as waiting, not a repair failure. If CI does not start, inspect triggers, draft
conditions, workflow permissions, and service availability. Report access, approval,
runner, or service blockers and leave the gate closed until resolved.

For each failed CI attempt, complete this repair cycle:

1. **Diagnose from evidence.** Read the failed job/step logs with
   `gh run view "$run_id" --log-failed`. Identify the failing command, environment, and
   expected versus actual behavior. Trace the symptom to its root cause in code,
   configuration, dependencies, or the workflow. Summarize the cause and supporting
   evidence before editing; do not guess from the job name.
2. **Reproduce and fix.** Read the owning source and existing regressions. Reproduce
   the failure locally with the workflow's prerequisites and toolchain where feasible.
   Explain any reproduction limit. Apply the smallest change that addresses the cause;
   keep OVS's architecture, stack, security boundaries, and existing style. Do not weaken
   assertions, skip failing tests, disable checks, or lower release gates to obtain green CI.
   Do not perform unrelated refactors, upgrades, or automatic rollback of user work.
3. **Verify the repair.** Reuse coverage that already catches the failure; extend an
   owning scenario when needed. Add a focused regression only for an uncovered failure
   mode. Read back the diff. Run formatting/static checks, the failing regression and
   relevant tests, then the production build. The default implementation sequence is
   `make check`, `make test test-race`, and `make build`. Use the documentation-only
   exception where applicable. Match affected CI browser/container/proxy steps too:
   install browser prerequisites before `make test-e2e`, and use
   `make image image-smoke proxy-smoke` when those contracts are affected. Update affected
   usage/contracts and existing changelog entries when behavior changes. Report actual
   results and missing prerequisites; a failed local check needs attention before a push.
4. **Publish the reviewed fix when authorized.** Show the root cause, changed files,
   diff, and validation. If Git write authorization is missing, request approval before
   planning the commit/push. An approved repair loop can cover subsequent fixes within
   the same CI/release scope. Recheck branch, diff, and remote tips before writing; stage
   only reviewed fix paths, use an English scoped Conventional Commit, and push only the
   selected source branch without force or tags. Keep version/release metadata out of
   pre-bump repair commits. Do not use `make release-commit` for code fixes. After a push
   failure, inspect local/remote state and retry only the remaining authorized push;
   do not create a duplicate commit or include unrelated work.
5. **Wait again.** Fetch and resolve the new source SHA, confirm the PR points to it,
   and wait for all expected jobs on the new attempt. If CI still fails, repeat diagnosis,
   repair, verification, and the authorized commit/push cycle. Do not proceed after a
   fixed retry count. Continue until CI succeeds or a concrete external/authorization
   blocker requires user action. With no new evidence or viable repair, report the
   blocker, attempts, PR/run links, and next required action instead of looping unchanged.

For a demonstrated transient service/runner failure, a rerun may replace a code change;
explain the evidence and verify the rerun's result. Repeatedly rerunning the same failure
is not a repair. Never create empty commits merely to restart CI.

After success, record the verified source/base SHAs and run links. Fetch again; if either
tip changed, re-review the complete release diff and repeat the gate. Use the final
CI-green range, including repair commits, for the version decision and release notes.

## Choose and prepare the version

Root `versions.toml` is the sole module release-version source. `versions.sync` is the application version.
`versions.web` and `versions.helper` record independently managed frontend and helper releases.
Private package manifests omit versions; helper release metadata is generated during the build. Use numeric `MAJOR.MINOR.PATCH`
comparison, not string ordering. If a release branch name contains a version, reconcile it
with the proposed version rather than renaming the branch silently.

Select the smallest appropriate increase from `origin/main`'s application version:

- **Major:** incompatible changes to a supported application contract, configuration,
  protocol, or upgrade path. Before 1.0, normally use a minor increase for incompatible
  development changes; reserve 1.0.0 for an intentional stable release with required gates met.
- **Minor:** new user/operator capabilities or a substantial development milestone.
- **Patch:** backward-compatible fixes, security corrections, or maintenance without new
  capabilities. Documentation/tooling-only release requests can use patch; explain that scope.

Explain the choice with concrete changes in `main...source`. An unversioned base needs an
explicitly identified initial version: normally 0.1.0 for the infrastructure milestone,
never an unsupported claim of a finished 1.0 application. Compare with the previous published
tag/release too when it predates `main`; label the PR commit range separately.

When the source still has the base version, run the selected `make bump-major`,
`make bump-minor`, or `make bump-patch`. These commands edit only `versions.toml` (`MODULE=sync` by default); they do not
stage, commit, or push. Review the resulting value against the recommendation.
For an unversioned base, use the source's existing version as the starting point or edit
`versions.toml` directly to the justified initial version. Do not invent a base version.

If the source or worktree already contains the recommended greater version, reuse it;
do not bump a second time. If the existing version conflicts with the recommendation,
explain the mismatch and resolve it before approval. Do not reduce an already published
version. If the exact bump is already committed and pushed, skip `release-commit`, verify
hosted CI for the current PR, and update the existing PR within the user's authorization.
If a prior release commit exists locally after a push failure, inspect origin and request
any missing approval for only the outstanding push; do not rerun the bump or create
another release commit. Verify CI after the push before completing the release PR.

If CHANGELOG.md exists, prepare its matching release section with final user-visible behavior
relative to the previous published release. Fold refinements of newly added features into
their Added entry. Preserve spacing and retain an empty `[Unreleased]` section according to
the existing format. Keep development-only migration notes separate. Do not introduce a
changelog when none exists; derive an explicitly identified release summary from the diff.

## Validate and present the approval package

Validate the proposed source snapshot including the prepared release files. Follow README
prerequisites and AGENTS.md's documentation-only exception. For implementation releases:

```bash
make check
make test test-race
make build
make browser-install
make test-e2e
make image image-smoke proxy-smoke
```

Use isolated data under `.misc/`; never use a live deployment or existing `/data`.
Retain requested release evidence under `.misc/`. Distinguish checks for the proposed local
snapshot from hosted checks for `head_sha`; neither verifies a different snapshot. Report
passed, failed, pending, and unverified checks. Missing prerequisites and skipped checks
remain visible. Do not present a known failing release as ready.

Review DESIGN's product gates. Bilibili controls, state reporting, danmaku, and session
isolation need separate proof; ordinary offline tests do not establish live support or
latency/skew targets. An infrastructure or local-playback milestone does not complete the
first-release PRD. Use draft status for incomplete release preparation or product gates,
unless the user explicitly requests a ready intermediate milestone with those limits stated.

Prepare an English PR title: `chore(release): release ovs X.Y.Z`.
Follow the repository PR template when present; otherwise include these useful parts:

- **Version and rationale:** base version, proposed version, selected increase, and reason.
- **Highlights and release notes:** final user/operator behavior from the changelog or an
  identified diff summary. Describe implemented scope, not proposed application contracts.
- **Upgrade and deployment:** changed configuration, dependencies, numbered migrations,
  schema compatibility, and backup/restore needs for all of `/data`, including SQLite sidecars.
- **Validation:** reviewed source SHA and prepared release-file diff, actual checks/links,
  missing gates, and live-platform/performance evidence separately from offline tests.
- **Release checklist:** successful pre-bump CI links, pending CI for the release commit,
  and applicable acceptance gates. State that merge/tag currently triggers no automated
  publication. Tagging is a separate `make release-tag` action.
- **Commits:** a compact list or collapsed details for the remote PR range.

Show the version rationale, full release-file diff, validation results, PR title/body,
source/base SHAs, and draft status. State exactly which files `release-commit` will stage
(`versions.toml`, plus tracked `CHANGELOG.md` when present), its commit subject, and push destination.
If not already explicitly authorized, ask for approval to run `make release-commit YES=1`
(stage, commit, and push) for the named branch/version, and to update the existing PR
with the reviewed title/body and draft status. **Stop and wait for the reply.** A timeout,
missing reply, or generic earlier request to prepare a release is not approval. When the
bump is already pushed, request only any remaining unauthorized action. Use `YES=1` only
after explicit approval covers the Git actions.

## After approval: commit, push, update the PR, and verify CI

Recheck the branch, local diff, and fetched base/source tips against the approved package.
If release contents, version, or PR scope changed, refresh the review and request any
additional authorization needed for the changed package. Reuse valid local evidence when
only commit metadata changed; rerun affected checks when contents changed. If either
remote tip changed, repeat the hosted CI gate before continuing. Recheck the existing PR
before further writes.

For the approved, uncommitted bump, run:

```bash
make release-commit YES=1
```

The target previews the diff, rejects unrelated tracked/staged changes, stages only release
files, commits `chore(release): release ovs X.Y.Z`, and pushes the selected branch to origin.
An existing remote source must match local HEAD before this commit. Do not bypass these
guards with a broad stage/commit or force push. On failure, inspect local/remote state and
report the remaining action; a failed push retains the local release commit. Do not retry
the whole release sequence or discard the approved files.

Fetch again and resolve the resulting source SHA. Verify that its versions.toml, release notes,
commit subject, and complete diff match the approved package, and that the source is pushed.
If the base or source moved unexpectedly, refresh the review before updating the PR.
Update the PR's validation wording to identify the new SHA and the identical tested contents;
report hosted checks for that SHA as pending/unverified until observed.

Write the reviewed body with real newlines to a disposable file at the session's authorized
scratch location and use `--body-file`. Retained evidence belongs under `.misc/`.
Update the same PR:

```bash
gh pr edit "$pr_number" --title "$release_title" --body-file "$body_file"
```

Remove the disposable body file after use when practical. If the PR was closed or its
source/base changed, report the state and resolve it within authorization; do not silently
create a replacement PR.

Return to the hosted CI gate for the pushed release commit. Diagnose and repair failures
through the same loop, preserving the chosen version instead of bumping again. If repairs
change release behavior, refresh the full diff, version rationale, release notes, and any
affected approval before further Git writes. Verify the final PR head after every push;
pre-bump green CI does not verify the release commit or later fixes.

After final CI succeeds, update validation links and mark the PR ready only when the
approved status and product gates permit it. Otherwise retain draft status and report
the missing gates. Report the PR URL, version change, release commit SHA, final head SHA,
successful CI links, remaining product gates, and publication status. Stop after release
PR preparation and final CI verification. Merging, `make release-tag`, and publication need
separate user requests; approval for the release PR does not authorize those actions.
