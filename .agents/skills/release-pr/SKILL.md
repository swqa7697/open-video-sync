---
name: release-pr
description: Prepare an Open Video Sync release from dev or a release topic branch into main. Open or reuse the PR before bumping, diagnose, commit, push, and verify CI repairs, then prepare the version bump for final approval and verify final CI. Excludes ordinary feature PRs, merging, tagging, and publication.
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

**Invoking `release-pr` for release preparation authorizes creating/reusing and updating
the release PR, and staging, committing, and pushing fixes needed for CI failures on the
selected source branch.**

**Guidelines exemption for CI fix commits:** The user's `release-pr` invocation is the
explicit Git-write request for the CI repair loop. For these fixes, the user authorizes
an exemption from user/project guidelines that require asking before planning or executing
`git add`, `git commit`, or `git push`, including the Git authorization rule in
[AGENTS.md](../../../AGENTS.md). Do not request separate approval for staging, the fix
commit, its message, or the push; do not reintroduce these approval gates through a generic
commit workflow. This exemption covers necessary CI repairs on the selected source branch,
including failures after the approved release commit. Continue to follow guidelines for
review, validation, commit style, branch safety, and preserving unrelated changes.
The final version bump/release commit still requires approval of the concrete package
below; the CI repair exemption does not cover that action.

Continue through PR creation/reuse, CI waiting and repair retries, successful pre-bump CI,
version selection, release-file preparation, and approval-package validation without
ending the workflow. The first planned approval pause is the final version-bump confirmation.
Creating a PR, pending/failed CI, pushing a repair, or passing pre-bump CI is not a stopping
point. Only a concrete blocker that prevents further authorized progress may interrupt
this sequence; complete independent work and report the blocker and required user action.
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
gh pr list --base main --head "$release_branch" --state open --json number,url,headRefOid
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

For a new PR, prepare an English title such as `chore(release): prepare open-video-sync release`.
Follow the repository PR template when present. Include the reviewed source/base SHAs,
implemented changes, known release gates, and actual validation. State that the version
is not selected and hosted CI is pending. Do not run a bump command or edit release
metadata yet.

Write the reviewed body with real newlines to a disposable file under `/tmp/codex/`
and pass it with `--body-file`. Retained evidence belongs under `.misc/`.
Recheck for an existing PR immediately before creation, then run:

```bash
gh pr create --base main --head "$release_branch" --title "$release_title" --body-file "$body_file"
```

If creation fails or times out, query for an existing PR before retrying. Resolve the cause rather than
repeating an unchanged network/authentication failure. Remove the body file after use
when practical. Record the PR number and URL, then continue; do not stop at creation.

## Hosted CI gate and repair loop

**Do not choose/apply a new version bump until hosted CI passes for the current PR
source and base in full validation mode.** Local checks, an older green run, a release-mode
run, and an empty check list do not satisfy this pre-bump gate. Require full validation
after code repair pushes too. The final metadata-only release commit may use the verified
release mode described below.

Read `.github/workflows/` and applicable required checks to identify the expected PR jobs.
Query the PR and its checks, then inspect the linked workflow runs:

```bash
gh pr view "$pr_number" --json url,state,headRefName,headRefOid,baseRefName,baseRefOid
gh pr checks "$pr_number" --json name,state,bucket,workflow,event,link
gh run view "$run_id" --json headSha,event,status,conclusion,attempt,jobs,url
```

Confirm the PR is open with the selected source/base. Associate runs with that PR,
workflow event, current source SHA, current base, and latest attempt. Account for PR
workflows testing a synthetic merge commit. Do not compare unrelated push runs or use
stale checks from before a source/base update. Required and expected applicable jobs
must complete successfully. Pending, missing, cancelled, timed-out, or unexpectedly
skipped jobs keep the gate closed; a successful job does not hide another failed job.

The `CI / validate` job always runs. Its `Select validation mode` log identifies `full`
or `release`; its summary records the tested source/base and the reused full run when
applicable. In full mode, all static, unit, race, browser, image, and proxy steps must
succeed. Do not accept a missing mode as full without inspecting every expected step
in an older workflow.

Release mode is allowed only for a same-repository PR into `main`, with a single-parent
release commit that modifies only regular `versions.toml` and optional existing
`CHANGELOG.md` files. The bump, exact commit message, dated notes, and whitespace must
validate. The direct parent must have a successful full run for the same PR, base,
repository, and workflow. CI verifies the latest attempt and its `full-ci-<run>-<attempt>`
artifact, including its digest and recorded source/base/merge identity. A release-mode
run never supplies reusable full evidence. Missing, expired, or mismatched evidence and
API failures select full mode; invalid release metadata fails the run.

For the final release commit, accept either a successful full run or a successful
release-mode run whose dependency installation, `make check`, image build, image smoke,
final source/base freshness check, and `Record validation result` step succeed.
Both modes prepare pnpm and uv, then run `make install` and `make check`.
Unit, race, browser, and proxy steps are expected to be skipped only in verified release
mode. Check the linked full run and direct-parent relationship; a pre-bump green check
alone is insufficient.
Record both full and release-mode run links in the PR. Recheck the remote source/base
after completion. A changed base needs fresh full validation. Require the PR branch
to be up to date with its base in branch rules when enforcing merge-time freshness;
CI cannot prevent the base from moving after a run finishes.

Poll while jobs are queued/running or still registering. Use short waits or bounded
watch calls so progress updates remain possible at least every 60 seconds. Treat pending
status as waiting, not a repair failure. If CI does not start, inspect triggers,
workflow conditions, permissions, and service availability. Report access, approval,
runner, or service blockers and leave the gate closed until resolved.

### Attribute the failure before choosing a repair

A failing test does not establish whether the product or the test is wrong. Determine
the intended behavior from PRD, DESIGN, explicit user requirements, and approved contract
changes in the release range. Check shipped behavior when compatibility is relevant.
Neither the current implementation nor an existing assertion or snapshot alone defines
correct behavior. If these sources leave a material conflict unresolved, report the
decision needed instead of silently changing the contract; continue independent diagnosis.

Classify each independent cause with supporting evidence. More than one category may apply:

| Category                   | Evidence and repair target                                                                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product defect             | Application code, shipped configuration, or a runtime dependency violates the intended behavior. Repair the production cause and retain correct test expectations. Intermittent product races remain product defects.                              |
| Test defect                | Independent contract evidence supports the relevant product behavior, but the assertion, snapshot, fixture, mock, isolation, cleanup, or timing assumption is wrong. Repair the test or harness and preserve meaningful coverage of that contract. |
| CI/tooling defect          | Workflow, build scripts, dependency installation, toolchain selection, paths, permissions, services, or caches prevent the intended checks from running correctly. Repair the responsible configuration or tooling.                                |
| External transient failure | Logs establish a temporary runner, network, or external-service failure. A verified rerun may suffice without a repository change.                                                                                                                 |

Do not label an unexplained intermittent failure as a test defect or transient failure.
A local pass or a successful retry alone proves neither. Keep uncertain attribution
explicit and investigate further. If both the implementation and the test are wrong,
identify and repair both causes; do not force the failure into a single category.

### Complete the repair cycle

For each failed CI attempt, complete this cycle for all independent failures. Separate
original failures from downstream symptoms, such as artifacts absent because an earlier
step failed.

1. **Collect evidence and reproduce.** Read the failed job/step logs with
   `gh run view "$run_id" --log-failed`, plus relevant stack traces and browser/test
   artifacts. Identify the exact command, exit status, inputs, and expected versus actual
   behavior. Read the owning source, existing regressions, workflow, Make targets,
   package scripts, and relevant lockfiles. Run the smallest failing case before editing
   where feasible. Match the tested snapshot, working directory, runner/toolchain,
   locked dependencies, generated assets, browser prerequisites, services, and relevant
   environment settings. Do not dump credentials or raw provider data into diagnostics.
   Compare isolated and suite execution when ordering, parallelism, or shared resources
   may matter. Explain reproduction limits; a failure seen only in CI remains unresolved
   until its cause is supported and the repair is verified there.
2. **Establish the cause and repair plan.** Trace the causal chain from the symptom to
   the originating defect. State the intended contract, failure category, supporting
   evidence, and remaining uncertainty before editing. Test competing hypotheses with
   focused checks instead of guessing from the job name. Identify the smallest repair,
   affected files, and possible side effects; order multiple repairs by dependency.
   Distinguish test-defect repairs from regression coverage added for a product repair.
   For a test-defect repair, explain the incorrect assumption and why the replacement
   follows the contract. Do not change production behavior merely to satisfy an incorrect
   test, or change a correct test to accommodate broken production behavior.
3. **Repair the responsible layer.** Apply one causal repair at a time and read back
   each change. Keep OVS's architecture, stack, security boundaries, public compatibility,
   and existing style. Use the existing package manager and update dependency metadata
   and lockfiles together only when the cause requires it. Do not perform unrelated
   refactors, upgrades, toolchain migrations, coverage initiatives, or automatic rollback
   of user work.

   Test repairs may correct invalid assertions, snapshots, mocks, or fixtures when backed
   by the contract evidence above. Review changed expectations independently of the
   current output. Use deterministic clocks or explicit synchronization for timing;
   isolate resources and clean up sockets, timers, processes, files, and test data.
   Do not weaken valid assertions, skip failing tests, disable checks, or lower release
   gates. Do not mask unexplained failures with retries, arbitrary sleeps, larger
   timeouts, or blindly regenerated snapshots. Any justified timeout change must preserve
   product latency/skew requirements and explain the measured environment constraint.

   For workflow/build repairs, check YAML or script syntax, event/branch/path conditions,
   checkout and working directories, toolchain/setup order, locked installation, required
   permissions/services, and cache inputs as relevant. Commands and Make targets must
   propagate nonzero exits; read-only checks must not silently format or repair files.
   Preserve required job coverage and the full/release validation eligibility and evidence
   guarantees. Do not obtain green CI through success-masking conditions or fallback commands.

4. **Verify the repair and its detection.** Reuse coverage that already catches the
   failure; otherwise extend an owning scenario before adding a focused regression for
   a distinct uncovered failure mode. Test observable behavior rather than source text
   or incidental call order. For a product defect, establish that the regression fails
   for the original defect and passes with the repair where feasible; report any limit.
   For a test defect, verify the corrected scenario accepts valid behavior and still
   detects the relevant contract violation, using a controlled invalid case where
   feasible. A passing replacement assertion alone does not establish a valid repair.
   For a CI/tooling defect, rerun the affected command with its prerequisites and verify
   the checks actually execute and report failures correctly. For intermittent failures,
   repeat the relevant scenario under the implicated concurrency/environment and report
   the trial count and limits; one pass does not establish that a race is fixed.

   Apply the configured formatter to touched files, then run read-only formatting/static
   checks, the failing regression and relevant tests, then the production build. The
   default implementation sequence is `make check`, `make test test-race`, and
   `make build`. Use the documentation-only exception where applicable. Match affected
   CI browser/container/proxy steps too: install browser prerequisites before
   `make test-e2e`, and use `make image image-smoke proxy-smoke` when those contracts are
   affected. Update affected usage/contracts and existing changelog entries when behavior
   changes. Review the final diff, including generated changes, and run `git diff --check`;
   keep generated build output out of fix commits. Resolve observed local failures before
   publishing. Report actual results, missing prerequisites, and any verification that
   must occur in hosted CI.

5. **Publish the reviewed fix under the invocation's authorization.** Show each cause's
   classification, contract evidence, changed files, diff, and validation, then commit
   and push without a separate approval request, applying the guidelines exemption for
   CI fix commits above. Do not stop to satisfy a general Git approval rule already
   covered by the `release-pr` invocation.
   Recheck branch, diff, and remote tips before writing; stage
   only reviewed fix paths, use an English scoped Conventional Commit, and push only the
   selected source branch without force or tags. Keep new version bumps and dated release
   sections out of pre-bump repair commits. Do not use `make release-commit` for code
   fixes. After a push failure, inspect local/remote state and retry only the remaining
   authorized push; do not create a duplicate commit or include unrelated work.
6. **Wait again.** Fetch and resolve the new source SHA, confirm the PR points to it,
   and wait for all expected jobs on the new attempt. If CI still fails, repeat diagnosis,
   repair, verification, and the authorized commit/push cycle. Continue viable repairs
   rather than stopping at a fixed retry count. Continue until CI succeeds or a concrete
   blocker outside the authorized repair loop requires user action. With no new evidence
   or viable repair, report the blocker, attempts, PR/run links, and next required action
   instead of looping unchanged.

For a demonstrated transient service/runner failure, a rerun may replace a code change;
explain the evidence and verify the rerun's result. Repeatedly rerunning the same failure
is not a repair. Never create empty commits merely to restart CI.

After success, record the verified source/base SHAs and run links. Include a concise
repair summary in the PR validation: each cause's classification, contract evidence,
repair, and verification limits. Fetch again; if either tip changed, re-review the
complete release diff and repeat the gate. Use the final CI-green range, including
repair commits, for the version decision and release notes.

## Choose and prepare the version

Root `versions.toml` is the sole module release-version source. Sync, web, and helper have
independent versions; do not require a sync bump for a web-only or helper-only change.
Changelog sections and release tags use the release date independently of numeric
module versions. Use `## [YYYY-MM-DD]` for changelog headings and `vYYYY-MM-DD`
for release tags.
Private package manifests omit versions; helper release metadata is generated during the build. Use numeric `MAJOR.MINOR.PATCH`
comparison, not string ordering. If a release branch name contains a version, reconcile it
with the proposed version rather than renaming the branch silently.

Read the full `origin/main...source` diff and identify runtime or observable behavior changes
for each module. Paths locate changes to inspect; they do not by themselves require bumps.
Documentation, tests, formatting, behavior-preserving refactors, and tooling-only changes
require no module bump unless they change shipped runtime behavior. Review shared changes
for their impact on each module too.

Compare each module's base, committed, and proposed versions. Show a table in manifest order
with those versions, runtime impact, and the bump rationale. An existing release commit does
not prove that every affected module is covered. If a partial set of bumps leaves an affected
module uncovered, identify the gap and include a justified proposed target in the final
approval package rather than stopping for a separate version question. Preserve valid
committed and pending bumps.

For each affected module, select the smallest appropriate increase from its `origin/main` version:

- **Major:** incompatible changes to a supported application contract, configuration,
  protocol, or upgrade path. Before 1.0, normally use a minor increase for incompatible
  development changes; reserve 1.0.0 for an intentional stable release with required gates met.
- **Minor:** new user/operator capabilities or a substantial development milestone.
- **Patch:** backward-compatible fixes, security corrections, or maintenance without new
  capabilities.

Explain the choice with concrete changes in `main...source`. An unversioned base needs an
explicitly identified initial version: normally 0.1.0 for the infrastructure milestone,
never an unsupported claim of a finished 1.0 application. Compare with the previous published
tag/release too when it predates `main`; label the PR commit range separately.

When the source still has the base version, run the selected `make bump-major`,
`make bump-minor`, or `make bump-patch`, with `MODULE=sync`, `MODULE=web`, or `MODULE=helper`
for each affected module. These commands edit only `versions.toml` (`MODULE=sync` by default); they do not
stage, commit, or push. Review the resulting value against the recommendation.
For an unversioned base, use the source's existing version as the starting point or edit
`versions.toml` directly to the justified initial version. Do not invent a base version.

If the source or worktree already contains the recommended greater version, reuse it;
do not bump a second time. If the existing version conflicts with the recommendation,
explain the mismatch and resolve it before approval. Do not reduce an already published
version. If the exact bump is already committed and pushed, skip `release-commit`, verify
hosted CI for the current PR, and update the existing PR within the user's authorization.
If a prior release commit exists locally after a push failure, inspect origin and reuse
its existing approval for the outstanding push; do not rerun the bump or create another
release commit. If final bump approval is missing, include only the outstanding release
push in the final approval package. Verify CI after the push before completing the release PR.

If no modules require bumps and all versions are unchanged, continue without a version
commit. Use a descriptive final PR title `release open-video-sync: <summary>` for that case.

If CHANGELOG.md exists, prepare a date-only `## [YYYY-MM-DD]` release section with final user-visible behavior
relative to the previous published release. Fold refinements of newly added features into
their Added entry. Preserve spacing and retain an empty `[Unreleased]` section according to
the existing format. Keep development-only migration notes separate. Do not introduce a
changelog when none exists; derive an explicitly identified release summary from the diff.

## Validate and present the approval package

Validate the proposed source snapshot including the prepared release files. Follow README
prerequisites and AGENTS.md's documentation-only exception. When only the isolated release
files change after successful full validation of the direct parent against the same base,
reuse the completed local unit, race, browser, and proxy checks, inspect the complete
release-file diff and metadata, and run `git diff --check`, `make check`, and
`make image image-smoke` for the prepared snapshot.
The hosted classifier still independently decides whether release mode is eligible.
For other implementation changes, run the complete sequence:

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
remain visible. Do not describe a known failing release as validated.

Review DESIGN's product gates. Bilibili controls, state reporting, danmaku, and session
isolation need separate proof; ordinary offline tests do not establish live support or
latency/skew targets. An infrastructure or local-playback milestone does not complete the
first-release PRD. Apply AGENTS.md's acceptance-continuity rule: carry accepted results
forward from prior release PRs or explicit user confirmation, and repeat only affected
checks when contracts change or a regression is identified. Missing volatile `.misc/`
artifacts alone do not reopen acceptance. Report incomplete preparation and unmet
product gates in the PR body and checklist.

Prepare an English PR title matching the release commit subject:
`release open-video-sync: <module> X.Y.Z | <module> X.Y.Z`.
List only modules changed by that version commit relative to its parent, in `versions.toml`
order, separated by `|`. For example: `release open-video-sync: sync 0.1.0 | helper 0.2.1`.
Omit unchanged modules; a single-module release has one entry and no separator.
Follow the repository PR template when present; otherwise include these useful parts:

- **Version and rationale:** a table of all three modules in manifest order, comparing base
  and proposed versions across the full PR, with the selected increases and reasons. The
  release commit subject describes only that commit's bumps; the table covers the release.
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
and source/base SHAs. State exactly which files `release-commit` will stage
(`versions.toml`, plus tracked `CHANGELOG.md` when present), its commit subject, and push destination.
**Reach this fully prepared package before pausing for final version-bump confirmation.**
If the concrete bump is not already explicitly authorized, ask for approval to run
`make release-commit YES=1` (stage, commit, and push) for the named branch/version.
**Stop and wait for the reply.** A timeout, missing reply, or invocation of `release-pr`
alone is not final bump approval. Reuse approval already given for the same package.
When the bump is already pushed or no bump is needed, continue to PR updates and final
CI verification without a redundant approval request. Use `YES=1` only after explicit
approval covers the release Git actions.

## After approval: commit, push, update the PR, and verify CI

Recheck the branch, local diff, and fetched base/source tips against the approved package.
If the approved version targets, release files, or PR scope changed, refresh the review
and request any additional authorization needed for the changed package. CI repair
commits and pushes retain the invocation's authorization. Reuse valid local evidence when
only commit metadata changed; rerun affected checks when contents changed. If either
remote tip changed, repeat the hosted CI gate before continuing. Recheck the existing PR
before further writes.

For the approved, uncommitted bump, run:

```bash
make release-commit YES=1
```

The target previews the diff, rejects unrelated tracked/staged changes, stages only release
files, and commits the single-line message `release open-video-sync: <module> X.Y.Z | ...`
without a body or `v` prefix. The subject lists only modules increased relative to HEAD,
in worktree `versions.toml` order. At least one module must increase; all module downgrades
are rejected. The selected branch is then pushed to origin.
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

Return to the hosted CI gate for the pushed release commit. Diagnose, commit, push, and
verify repairs through the same authorized loop without separate repair approval, accepting
full or verified release mode as defined above and preserving the chosen version instead
of bumping again. If repairs change release behavior, refresh the full diff, version
rationale, and release notes. CI repairs within the approved version targets, including
release-metadata corrections, remain authorized. If a different version bump is needed,
prepare and validate the revised package before requesting approval for that version change.
Verify the final PR head after every push;
pre-bump green CI does not verify the release commit or later fixes.

After final CI succeeds, update validation links. Report any unmet product gates in
the PR body and checklist. Report the PR URL, version change, release commit SHA, final head SHA,
successful CI links and final validation mode (including the reused full run for release
mode), remaining product gates, and publication status. Stop after release
PR preparation and final CI verification. Merging, `make release-tag`, and publication need
separate user requests; approval for the release PR does not authorize those actions.
