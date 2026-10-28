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
current implementation before choosing a target. The repository currently has a Vue shell
and readiness status; rooms, playback, Bilibili, and danmaku remain proposed. Optimize an
implemented surface without presenting a mock room or player as working functionality.

## Establish the target and baseline

- Start with the user's reported problem and inspect its owning Vue component, styles,
  store, regression, and browser journey. With no named surface, inspect the existing shell
  and prioritize a concrete usability problem. Preserve the existing visual language and
  avoid unrelated redesigns or a new theme system.
- Use the tools selected by the repository: Vue 3 Composition API, strict TypeScript,
  Pinia, and Vite+ with pnpm. Keep player instances, files, object URLs, provider objects,
  and timer ownership outside serializable stores. Do not change dependency versions just
  to obtain a different browser rendering.
- Check prerequisites in README. Use `make install` if dependencies need installation,
  then `make browser-install` to install the Chromium version selected by locked Playwright.
  Keep the same browser and dependencies throughout the comparison. Record their versions.
- Run `make test-e2e` for the production application served by Go over direct HTTP. Inspect
  [playwright.config.ts](../../../web/playwright.config.ts),
  [playwright-fixtures.ts](../../../web/playwright-fixtures.ts), and the owning journey under
  `tests/e2e/`. The current shell journey checks readiness and routing; it does not capture
  visual baselines or exercise playback. Do not substitute a standalone preview for the
  shipped application.
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
   scrolling, keyboard operation, focus, reduced motion, and status announcements. For
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
After a final rendering edit, regenerate and inspect the affected screenshots. Update usage
documentation when behavior changes; when CHANGELOG.md exists, follow its Unreleased format
and describe the final user-visible result rather than internal iteration history.

Report the visible changes, accessible links to representative before/after PNGs using the
session's screenshot-access guidance, checks actually run, browser/version details, and
remaining limitations. If setup or image viewing is unavailable, report visual verification
as unverified and complete independent work; do not claim a mock render proves the result.

The shell journey does not prove synchronization or platform support. A playable Bilibili
iframe does not pass DESIGN's separate control, state reporting, danmaku, and session-isolation
gate. Keep live-platform checks explicit and separate from offline validation. Do not operate
a user's live deployment or platform account as part of routine UI polish. `ui-optimize` does
not authorize staging, committing, pushing, or publication.
