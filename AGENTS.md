# Open Video Sync development guidelines

## Scope and sources of truth

- OVS is a private, self-hosted application for synchronized viewing. Read [PRD](specs/PRD.md) for requirements and [DESIGN](specs/DESIGN.md) for proposed technical contracts.
- The repository implements Go/Vue infrastructure, persistent anonymous identity, private rooms/invitations, serialized durable management, authenticated room sockets, local-file playback and synchronization, tooling, and container packaging. Complete waiting policies, recovery, and platform adapters remain proposed. Do not describe unimplemented contracts or performance targets as verified.
- Preserve the selected stack: Go; Vue 3, TypeScript, Vite, and Pinia; SQLite with recorded schema migrations; WebSocket for the initial release.
- Ship one OVS application container with the frontend embedded in Go. Store persistent application state in `/data`. An optional external Caddy installation owns TLS.
- Keep these shared guidelines in root `AGENTS.md`. If another agent entry file is needed, make it point here instead of maintaining duplicate instructions.
- Keep retained development artifacts and validation evidence under ignored `.misc/`. Do not create or modify developer-managed `.tmp/` content.

## Product boundaries

- OVS carries control state and bounded matching metadata only. Never add video upload, storage, transcoding, proxying, relaying, redistribution, or peer-to-peer media transfer.
- Local files stay in each participant's browser. Do not send bytes, file paths, object URLs, or file handles to OVS. Share only the descriptor defined in DESIGN.
- Video-platform cookies, login tokens, and credential-bearing playback URLs stay on the participant's device. Never include them in synchronization messages, SQLite, logs, diagnostics, or persisted frontend stores.
- Each participant uses their own platform access. Do not add shared credentials, access bypasses, backend media resolution, or CORS proxies.
- Bilibili playback, state reporting, danmaku, and session isolation require a separate proof of concept before finalizing the adapter. A playable iframe alone does not satisfy the requirement.
- Do not declare first-release scope complete with only local playback. Bilibili and danmaku remain required release gates.
- Keep direct HTTP functional. Core features must not depend on certificate provisioning or browser APIs available only in secure contexts without a working HTTP-compatible path.

## Architecture and ownership

| Proposed location                                  | Responsibility                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------- |
| `cmd/ovs`                                          | Composition, configuration, process lifecycle                         |
| `internal/identity`                                | Anonymous identity, OVS sessions, profile lifecycle                   |
| `internal/rooms`                                   | Membership, host rules, media, policies, timelines, room coordinators |
| `internal/transport/http`, `internal/transport/ws` | Transport authentication, decoding, framing, connection bounds        |
| `internal/contracts`, `internal/storage`           | Wire validation; SQLite setup, migrations, transaction support        |
| `internal/web`, `web`                              | Embedded assets; Vue UI, browser adapters, synchronization engine     |
| `migrations`, `tests`, `scripts`, `deploy`         | Recorded DDL, integration harnesses, automation, deployment examples  |

- Organize backend code by identity and room capabilities. Separate domain rules, application orchestration, and infrastructure where needed; do not create empty layers.
- Domain rules must not import HTTP frameworks, WebSocket implementations, or SQLite drivers. Application services own transaction boundaries; adapters depend inward through small consumer-owned interfaces.
- One coordinator serializes mutations for each room. HTTP and WebSocket entry points must use the same authorization and mutation path.
- Persist accepted durable changes before acknowledging or broadcasting them. Never let participant telemetry replace the authoritative room timeline.
- Keep clocks, random sources, storage, and connection sinks injectable. Prefer concrete functions and small interfaces over generic repositories, plugin frameworks, and speculative abstractions.
- Separate Vue rendering, shared Pinia state, synchronization logic, and player adapters. Keep player instances, files, provider responses, and timer ownership outside serializable stores.
- Make ownership, cancellation, and disposal explicit for goroutines, sockets, timers, workers, object URLs, and player instances. Bound queues and concurrency.

## Synchronization contracts

- Use monotonic clocks for playback and latency; use wall time for expiry and persisted timestamps. Never extrapolate playback through server downtime.
- Carry epoch, media generation, expected revision, and command identity through control handling. Reject stale state and deduplicate uncertain retries as specified in DESIGN.
- Cancel asynchronous work on media/adapter changes. Late callbacks must not affect a newer player or readiness barrier.
- Distinguish user intent from events produced by applying remote state. Prevent feedback loops without discarding genuine user actions.
- Enforce host permissions, active-tab leases, room isolation, and waiting rules on the server. Hidden or disabled UI controls are not authorization.
- Declare adapter capabilities explicitly. Play, pause, seek, and position reporting are mandatory; rate control and buffering detection require defined fallback behavior.
- Keep local volume, mute, quality, and danmaku preferences separate from shared playback state.
- Measure control-response latency and playback skew separately. A server acknowledgement or a client's predicted target is not evidence of actual synchronized playback.
- Retain WebSocket initially. Consider a datagram alternative only after evidence identifies TCP head-of-line blocking as the unmet-target cause.

## Go, TypeScript, and shell conventions

- Use `gofmt` for Go. Follow idiomatic Go naming, document exported contracts, return errors for operational failures, and wrap errors when callers need their cause.
- Propagate `context.Context` through blocking operations. Every goroutine needs an owner and a termination path. Do not panic on malformed user input.
- Prefer standard-library primitives where suitable. Pin third-party dependencies in manifests/lockfiles. Select container images and CI actions by tags. Use the latest stable Go compiler in CI and Docker; keep only the minimum Go version in `go.mod`.
- Use Vue Composition API with `<script setup lang="ts">`, strict TypeScript, typed adapter boundaries, and runtime validation for network/platform data. Do not use `any` to bypass contract checking.
- During frontend scaffolding, evaluate Vite+ with the required Vue/Vite setup. If compatibility requires plain Vite with pnpm, record the reason. Use pnpm with one lockfile; do not pin or require a specific pnpm version.
- Use Oxlint for supported frontend rules, retain necessary Vue template checks, and run `vue-tsc --noEmit` independently of bundling. Select and pin the formatter during scaffolding; avoid competing tools for the same rule.
- Use Bash with `set -euo pipefail`, quoted expansions, and argument arrays for executable automation. Keep reusable automation under `scripts/`.
- Prefer Go for standalone repository automation when no existing tool fits. Keep native frontend tests in the frontend test framework.
- Keep changes focused. Remove dead code and share helpers only when they represent the same responsibility. Do not add unrelated cleanup or future-source abstractions.

## Security, storage, and deployment

- Strictly validate JSON shape, duplicate/unknown fields, versions, sizes, numeric ranges, and room membership before effects. Translate failures into bounded, safe public errors.
- Keep OVS session credentials distinct from platform credentials. Use HttpOnly session cookies, exact-origin/CSRF checks, and server-generated high-entropy invitation/session secrets.
- Trust proxy headers only from configured proxies. Derive public URLs and cookie policy from validated deployment configuration, not arbitrary request headers.
- Render untrusted names, titles, danmaku, and errors as text. Validate platform messages by exact origin and source window as well as payload shape.
- Never serialize arbitrary player SDK objects or log raw requests/provider errors. Use synthetic secrets in boundary tests and sanitize retained traces.
- Record every SQLite DDL change as a new migration. Never edit an applied migration, silently reset a database, or remove data to hide migration failures.
- Keep related state and command outcomes in one transaction. Use real SQLite tests for constraints, rollback, upgrades, and crash recovery.
- Run one OVS process per data directory. Preserve `/data` across container replacement and include SQLite sidecars in the storage/backup contract.
- Build frontend assets before the Go embedding step. Verify the final image serves UI, API, and WebSocket without Node or a separate database service.
- Support direct HTTP and optional host/container/existing Caddy. Do not overwrite an operator's existing proxy configuration or manage certificates inside OVS.

## Development commands and validation

Use `make help` for the command list. Run `make install` to install locked dependencies and build the template. Run `make dev` for Go and `make dev-web` for frontend hot reload. See README for tool prerequisites.

Run `make check`, `make test test-race`, and `make build` in that order. Run `make browser-install` before `make test-e2e`. Use `make image image-smoke` for container checks. Direct Go commands require `make web-build` first because frontend assets are embedded at compile time. CI is configured; hosted success requires an actual successful run.

- For documentation-only changes, check references and contract consistency, then run `git diff --check`. Do not add application tests for documentation text.
- Use Make as the common developer entry point once implemented. Separate mutation-only formatting from read-only format/lint checks; avoid targets that silently stage or commit.
- Once the Go module exists, use `go vet ./...`, `go test ./...`, and `go test -race ./...` for concurrent code. Run the configured frontend format/lint, type checks, and tests from the frontend package.
- Validate in order: formatting/static checks, relevant tests, then production build. The production build must generate embedded assets before compiling Go.
- Add browser, storage, deployment, and network checks when the changed contract needs them. Keep live platform validation explicit and separate from the ordinary offline suite.
- Report checks actually run, their results, and missing prerequisites. A skipped check is unverified; claim hosted CI success only after a successful hosted run.

## Test design and growth

Before adding a test, read the regressions that own the affected behavior and stop at the first applicable step:

1. Existing coverage verifies the behavior: add nothing.
2. An existing scenario can reasonably cover the behavior: extend it.
3. Otherwise, add a focused scenario at the highest layer that owns the contract and explain the distinct failure mode.

- Keep Go tests beside their packages; keep frontend tests with the owning feature/engine and shared browser journeys under `tests/e2e/`.
- Test observable outcomes: cross-room isolation, stale-command rejection, waiting behavior, actual player convergence, persistence, and credential exclusion.
- Do not test constants, getters, documentation strings, source substrings, or incidental implementation layout. Do not mirror implementation calls with mock expectations as the only assertion.
- Use fake clocks and deterministic synchronization for timing logic. Use real browsers for autoplay, codecs, platform messaging, and user-gesture behavior.
- Use isolated temporary databases, synthetic peers/media, `t.TempDir`, and cleanup hooks. Ordinary tests must not access live user deployments or platform accounts.
- Share reusable fakes in the owning test-support boundary. Prefer small curated tables over exhaustive cross-products and unrelated one-assertion files.
- Use parallel tests only for independent resources. Serialize process-global effects or isolate them in subprocesses.
- Do not hide failures behind unconditional skips. Environment-gated live checks must state prerequisites and remain reported as unverified until run.
- Explain material suite growth and its runtime cost. Do not add tests to fill a case-count target or remove necessary security coverage to reduce counts.

## Performance evidence

- Measure before/after with the same machine, toolchain, browser/adapter, media, cache state, and network profile. Separate setup/build time from the measured operation.
- Choose at least three independent trials dynamically, capped at five minutes per before/after phase. Report insufficient evidence when both constraints cannot be met.
- Report sample count, mean, median, standard deviation, min/max, and p95/p99; label sparse tail estimates. Use Welch's t-test at alpha 0.05 on independent trial summaries.
- Label statistical confidence by degrees of freedom: high ≥29, moderate 10–28, low <10. Do not treat correlated playback samples as independent trials.
- Record commands, revision, environment, measurements, and limitations in `.misc/` for performance work. Keep release soak tests distinct from bounded comparison trials.

## Git, review, and documentation

- Preserve unrelated staged and working-tree changes. Never run `git add`, `git commit`, or `git push` without an explicit user request; ask before planning those actions. This also applies to wrappers that perform them.
- Use a focused topic branch or `dev` branch. Never commit directly to `main`.
- Write English Conventional Commit subjects: `type(scope): imperative summary`, lowercase, no trailing period. Use concise bullet points for any body. Add an optional short summary above the bullets only when it really helps.
- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Example subjects: `feat(rooms): add readiness barriers`; `fix(sync): reject stale media events`.
- PR descriptions explain the problem, resulting behavior, validation, and material limitations. Distinguish implementation from proposals and verified behavior from assumptions.
- Keep PRD focused on requirements and DESIGN on durable contracts. Add README usage/setup guidance when commands exist. Update affected documentation when behavior changes.
- When CHANGELOG exists, follow Keep a Changelog with user-visible entries under `[Unreleased]`. Preserve existing spacing and omit internal-only formatting/refactoring entries.
- Keep documentation clear and consistent. Use short, active sentences and stable terms for identities, members, connections, media generations, and room revisions.
