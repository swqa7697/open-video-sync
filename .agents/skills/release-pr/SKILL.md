---
name: release-pr
description: Prepare an Open Video Sync release from dev or a release topic branch into main, choose and apply a version bump from the complete diff, wait for approval, then run release-commit and create or reuse the release PR. Excludes ordinary feature PRs, merging, tagging, and publication.
---

# Prepare and open an OVS release PR

Canonical instructions live in `.agents/skills/release-pr`. Codex invokes `$release-pr`;
Claude Code invokes `/release-pr` through the `.claude/skills/release-pr` symlink.
Run from the repository root with Git and authenticated `gh`.
Read [AGENTS.md](../../../AGENTS.md), [README](../../../README.md), and the repository's
PR templates and workflows before preparation.

`release-pr` prepares a concrete version bump and PR for review, then **waits for explicit
approval before staging, committing, pushing, or creating the PR**. Request approval for
the exact `make release-commit YES=1` action (including stage, commit, and push), source
branch, version, and proposed PR. Invoking `release-pr` alone is not that approval.
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

If a matching open PR already exists, return its URL. Do not bump or rewrite the release
unless the user requested an update. An update still needs approval for its exact Git writes.

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
version. If the exact bump is already committed and pushed, skip `release-commit` and
request approval for the prepared PR only. If a prior release commit exists locally after
a push failure, inspect origin and request approval for only the outstanding push and PR;
do not rerun the bump or create another release commit.

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
make image image-smoke
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
- **Release checklist:** pending PR CI and applicable acceptance gates. State that merge/tag
  currently triggers no automated publication. Tagging is a separate `make release-tag` action.
- **Commits:** a compact list or collapsed details for the remote PR range.

Show the version rationale, full release-file diff, validation results, PR title/body,
source/base SHAs, and draft status. State exactly which files `release-commit` will stage
(`versions.toml`, plus tracked `CHANGELOG.md` when present), its commit subject, and push destination.
Ask for approval to run `make release-commit YES=1` and open the reviewed PR. When the bump
is already pushed, ask only for the remaining PR action. **Stop and wait for the reply.**
A timeout, missing reply, or generic earlier request to prepare a release is not approval.
Use `YES=1` only after explicit approval covers the Git actions.

## After approval: commit, push, and open the PR

Recheck the branch, local diff, and fetched base/source tips against the approved package.
If release contents, version, or PR scope changed, refresh the review and request approval
for the changed package. Reuse valid evidence when only commit metadata changed; rerun
affected checks when contents changed. Recheck for an existing PR before further writes.

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
If the base or source moved unexpectedly, refresh the review before creating the PR.
Update the PR's validation wording to identify the new SHA and the identical tested contents;
report hosted checks for that SHA as pending/unverified until observed.

Write the reviewed body with real newlines to a disposable file at the session's authorized
scratch location and use `--body-file`. Retained evidence belongs under `.misc/`.
Recheck existing PRs, then create:

```bash
gh pr create --base main --head "$release_branch" --title "$release_title" --body-file "$body_file"
```

Add `--draft` when selected. If creation fails or times out, query for an existing PR before
retrying. Resolve the cause; do not loop on an unchanged network/authentication failure.
Remove the disposable body file after use when practical.

Report the PR URL, version change, release commit SHA, pending checks/gates, and publication
status. Stop after PR creation. Merging, `make release-tag`, and publication need separate
user requests; approval for the release PR does not authorize those actions.
