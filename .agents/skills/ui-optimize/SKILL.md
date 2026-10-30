---
name: ui-optimize
description: Improve Open Video Sync's existing Vue frontend through a real-browser render, screenshot inspection, edit, and verification loop. Use for OVS layout, accessibility, interaction polish, or screenshot-driven usability improvements; keep new product features within their separately requested scope.
---

# Optimize the OVS frontend

Canonical instructions live in `.agents/skills/ui-optimize`. Codex invokes `$ui-optimize`;
Claude Code invokes `/ui-optimize` through the `.claude/skills/ui-optimize` symlink.
Work from this development checkout.

Read [AGENTS.md](../../../AGENTS.md), [README](../../../README.md), and the relevant
[PRD](../../../specs/PRD.md) and [DESIGN](../../../specs/DESIGN.md) contracts. Inspect the
current implementation and owning regressions before choosing a target. Optimize an
implemented surface and distinguish verified behavior from proposed contracts; do not
present a mock room, player, or platform adapter as working functionality.

## Select available companion skills

Discover companions from the current agent's available-skill catalog and invocation policies.
Resolve each companion's `SKILL.md` through the catalog rather than a machine-specific path.
Before using a companion, announce the exact canonical name, read the companion's instructions,
and load supporting references only for the concrete subtask. Use `emil-design-eng` as the
default design companion when available and permitted; select other companions by the work
below rather than loading every frontend skill.

| Companion | When to use | Role in this workflow |
| --- | --- | --- |
| `emil-design-eng` | Visual or interaction polish | Apply design and component guidance while inspecting the baseline and choosing focused changes. Use the required Before/After/Why table when reviewing UI code. |
| `find-animation-opportunities` | Proactively assess animation opportunities in the current optimization scope, even without an explicit motion request | Assess the target read-only, gate candidates by frequency, purpose, speed, and function, and record both precise proposals and rejected candidates. No surviving proposal is a valid outcome. |
| `animate` | Assessing a concrete motion candidate when the discovery companion is unavailable, or implementing a justified transition or feedback animation | Gate the candidate, then build the selected motion with existing tokens, interruption and exit behavior, reduced-motion handling, and pointer-capability gating. |
| `remove-animations` | Existing motion makes the target feel slow or distracting | Remove or reduce unnecessary motion and clean up dependent visibility, focus, unmount timing, and orphaned code. Keep additions and retuning outside the subtraction phase. |
| `animation-performance` | Motion stutters, drops frames, or needs a rendering-cost decision | Diagnose the cause from properties, drivers, and browser recordings before choosing a fix. Follow AGENTS.md for measured performance comparisons. |
| `review-animations` | A focused review of existing or changed motion is requested and invocation policy permits | Review the scoped motion and report findings in the required format; use findings to guide implementation and browser verification. |
| `improve-animations` | The task calls for a broader motion audit or implementation roadmap | Keep source analysis read-only and produce prioritized findings or scoped plans. A broad audit is unnecessary for a single transition. |
| `mobile-native` | The target includes mobile viewport, touch, scroll, safe-area, or input behavior | Apply the relevant platform fixes and distinguish browser emulation from verification on real hardware. |
| `apple-design` | Existing gesture, drag, swipe, sheet, or spring behavior needs physical continuity | Apply direct manipulation, velocity handoff, and interruption guidance while preserving OVS's visual language. |
| `break-ui` | The task includes a dedicated worst-case data assessment | Exercise plausible, contract-bounded data at the owning boundary. Keep any comparison toggle development-only; ordinary long-text checks do not require a new harness. |

Select companions by the target's needs. If a relevant companion is unavailable, note the
limitation briefly and continue the core browser workflow without installing or copying skills.
Automatic companion selection needs no separate request where invocation policy allows;
honor explicit-only restrictions, including `disable-model-invocation` or
`allow_implicit_invocation: false`. `prototype` and `pick-ui-library` require explicit user
requests, including when another companion recommends invoking either name.

When a relevant motion companion is available and permitted, proactively inspect the target
during baseline review for useful animation additions; do not wait for the user to ask for
motion or for an obvious defect. Use `find-animation-opportunities` for scoped discovery when
available, or `animate` to assess concrete candidates. Look for clearer feedback, spatial
continuity, and occasional state changes in existing controls and surfaces. Judge candidates
by frequency, purpose, speed, and function. For improvement requests, implement candidates
that pass those gates within the existing scope using `animate` when available; a proposal
alone does not finish the work. For assessment-only requests, report proposals. If no candidate
qualifies, briefly explain why; do not add animation to meet a quota or expand product scope.

Give each selected companion a concrete subtask, the user's existing scope and authorization,
and repository constraints. Keep discovery, review, and audit phases read-only on application
source. When the user already requested improvements, finish the advisory phase and resume
authorized implementation under `ui-optimize` and the relevant implementation companion;
an audit handoff alone does not complete a requested fix. For assessment-only requests,
report findings without proceeding to implementation. Keep retained reports, plans, and
recordings under `.misc/browser/reviews/<task>/` even when a companion suggests another
artifact directory.

Adapt companion examples to Vue Composition API and the existing component system. Prefer
CSS, Vue transitions, or WAAPI when sufficient; React examples do not justify introducing
React, a new component system, or a motion dependency. Reuse existing motion tokens. Keep
playback commands and keyboard interactions immediate, and avoid decorative motion on
frequent synchronization telemetry or position updates. Preserve keyboard access, focus,
and useful feedback in reduced-motion and no-animation paths.

## Establish the target and baseline

- Start with the user's reported problem and inspect its owning Vue component, styles,
  store, regression, and browser journey. With no named surface, inspect the application
  and prioritize a concrete usability problem. Preserve the existing visual language and
  avoid unrelated redesigns or a new theme system.
- Use the tools selected by the repository: Vue 3 Composition API, strict TypeScript,
  Pinia, and Vite+ with pnpm. Keep player instances, files, object URLs, provider objects,
  and timer ownership outside serializable stores. Do not change dependency versions just
  to obtain a different browser rendering.
- Check prerequisites in README. Use `make install` if dependencies need installation,
  then `make browser-install` to install the browsers selected by locked Playwright.
  Keep the same browser and dependencies throughout the comparison. Record their versions.
- Run `make test-e2e` for the production application served by Go over direct HTTP. Inspect
  [playwright.config.ts](../../../web/playwright.config.ts),
  [playwright-fixtures.ts](../../../web/playwright-fixtures.ts), and the owning journey under
  `tests/e2e/`. Reuse the journey that owns the target state and inspect existing screenshot
  coverage before adding captures. Do not substitute a standalone preview for the shipped
  application.
- Capture the requested state in the real browser before editing. Use consistent viewports
  before and after; 1440×900 and 390×844 are useful desktop/mobile defaults, with 1024×768
  when compact desktop controls are relevant. Preserve the existing journey's coverage.
  Exercise relevant states with synthetic data and browser input.
- Inspect the actual PNGs with an image-viewing tool. Playwright writes results and retained
  failure traces under `.misc/e2e/results/`; these outputs can be replaced by the next run.
  Preserve comparison PNGs, sanitized diagnostics, and a short record of commands, revision,
  local changes, browser version, viewports, and limitations under
  `.misc/browser/reviews/<task>/before/` and `after/`. Follow AGENTS.md for retained artifacts;
  never write developer-managed `.tmp/` content or commit generated screenshots.

## Repeat: inspect, change, render, compare

1. State the observed problem and an observable resolution: readable status text, reachable
   actions, visible keyboard focus, or controls that fit without horizontal clipping.
2. Inspect the states relevant to that problem. Check hierarchy, spacing, contrast, long text,
   scrolling, keyboard operation, focus, reduced motion, and status announcements. Apply the
   selected design or motion companion to the observed states before choosing edits. For
   implemented room/player surfaces, distinguish connection failure, media access failure,
   autoplay activation, readiness/waiting, and degraded synchronization. Do not invent these
   states in the shell merely to expand an optimization task.
3. Make a focused change in the shipped frontend. Separate Vue rendering, shared state,
   synchronization, and adapters. Preserve cancellation on media changes and disposal,
   distinguish user actions from remotely applied events, and keep local volume, mute,
   quality, and danmaku preferences separate from shared playback state. UI restrictions
   never replace server authorization.
4. Reuse the existing regression first; extend its scenario when reasonable. Add a focused
   browser scenario only for a distinct uncovered behavior, following AGENTS.md's test-growth
   ladder. Use mouse and keyboard input to verify interactions, including autoplay/user
   gestures when applicable. Screenshots establish appearance; behavioral assertions establish
   interaction outcomes. Avoid tracked pixel baselines unless explicitly requested.
5. Render the same states and viewports again, open the new PNGs, and compare with the saved
   baseline. Check for clipping, displaced controls, lost focus, broken media, repeated status
   announcements, and new console errors. Preserve useful images before another run replaces
   them. For a focused browser iteration, build first with `make build`, then use
   `pnpm --dir web run test:e2e --grep '<owning scenario>'`; finish with the full Make target.
6. Keep a change when the evidence supports the stated outcome. Otherwise revise that batch
   while preserving unrelated work. Stop when the requested problems are resolved and the
   affected states remain usable. Do not weaken assertions, hide errors, or remove controls
   to make a run pass.

OVS carries control state and bounded matching metadata only. Do not send local file bytes,
paths, handles, object URLs, platform cookies, login tokens, or credential-bearing playback
URLs to OVS or retained diagnostics. Use synthetic media and sessions for ordinary tests.
Keep direct HTTP functional; loopback browser success alone does not establish that a
secure-context API works on an ordinary LAN HTTP origin.

## Finish with evidence

Format changed files with the configured formatter, then validate in repository order:

```bash
make check
make test test-race
make build
make test-e2e
```

Run `make image image-smoke` when packaging, embedded serving, or deployment behavior changes.
After a final rendering edit, regenerate and inspect the affected screenshots. For changed
motion, also exercise entry/exit, rapid repetition or reversal, keyboard input, reduced
motion, and relevant pointer types in the real browser. Still PNGs establish appearance,
not timing or smoothness; use recordings or profiling for those claims and report any
unverified device behavior. Update usage documentation when behavior changes; when
CHANGELOG.md exists, follow its Unreleased format and describe the final user-visible
result rather than internal iteration history.

Report the visible changes, including any motion added and its purpose, or why the scoped
motion assessment found no suitable addition. Include accessible links to representative
before/after PNGs using the session's screenshot-access guidance, checks actually run,
browser/version details, and remaining limitations. If setup or image viewing is unavailable,
report visual verification as unverified and complete independent work; do not claim a mock
render proves the result.

The shell journey does not prove synchronization or platform support. A playable Bilibili
iframe does not pass DESIGN's separate control, state reporting, danmaku, and session-isolation
gate. Keep live-platform checks explicit and separate from offline validation. Do not operate
a user's live deployment or platform account as part of routine UI polish. `ui-optimize` does
not authorize staging, committing, pushing, or publication.
