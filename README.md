# Open Video Sync

OVS is a private, self-hosted application for synchronized viewing. Each participant supplies their own media. OVS carries control state only.

This repository includes persistent anonymous identities and private rooms with invitation links and codes.
Hosts can save room preferences, rotate invitations, remove participants, and close rooms. Participants can leave rooms.
The Go application embeds the Vue frontend and stores identities, memberships, room settings, media descriptors, and playback checkpoints in SQLite.
Authenticated room sockets and local synchronized playback are available as a development milestone. Bilibili and danmaku require the separate proof of concept described in [DESIGN](specs/DESIGN.md#8-bilibili-integration-and-required-proof-of-concept).
This intermediate stage does not complete the [PRD](specs/PRD.md).

## Use identities and rooms

Open OVS to restore or create your identity automatically. A display name is optional.
Create a room with a title, or enter a private invitation code. Invitation links use `/join#invite=...`; the page removes the fragment before mounting components.
Links and codes expire after seven days. Replacement invalidates both previous secrets. Removing a participant also invalidates previous invitations.
Membership survives browser reload and server restart. Room sockets deliver changes automatically; **Refresh room** also retrieves a snapshot.

Sessions use a host-only HttpOnly cookie with a rolling 365-day expiry, renewed at most once daily on bootstrap.
**Forget this identity** revokes the current session. Owned rooms may become inaccessible; ownership does not transfer.
Cookies are scoped to the browser profile and OVS origin. Private profiles receive independent identities.
Invitation secrets appear only when created or replaced. If a response is lost, retry the original request; replace the invitation to obtain new sharing details.

## Watch a local video

The host selects a file under **Watch local video**. Each participant selects the same file independently.
The optional shared label comes from host input. File names, timestamps, paths, handles, samples, and video bytes stay in each browser.
A worker computes a room-specific sampled SHA-256 digest with pinned `@noble/hashes`; matching works on ordinary HTTP without SubtleCrypto.
Equal size and digest plus duration within 250 ms permit matching. Sampled matching detects accidental differences; it does not prove identical content.

Use **Play together**, **Pause together**, **Seek together**, or **Replay**. The server enforces host/everyone control permissions.
Volume and mute remain local. Playback starts muted. If a browser blocks playback, select **Enable playback**.
**Use this tab** explicitly transfers playback ownership and disposes the previous tab's player.
A disconnected browser pauses after five seconds without server liveness, reconnects, obtains state, and recalibrates its clock.
An uncertain command can be checked with its original ID; controls are never queued for offline replay.

The default **All participants** policy waits for the active playback cohort, including the host.
Each participant must select matching media and allow playback. Seeking during waiting replaces the target and keeps play intent.
Buffering for at least 750 ms pauses the room at its authoritative position. Playback resumes after one second of stable readiness.
The host can exclude a participant from waiting for the current media. Exclusion does not grant media access.
Waiting times out paused and requires explicit host action. Changes to waiting rules also pause the room.
Late joiners either catch up when ready or wait for the next explicit play, according to the host preference.
Disconnected required participants retain a 15-second grace. Host absence after that grace pauses playback without transferring ownership.
Only the returning host can restart playback after host loss. Other room preferences preserve playback.
Reloading requires local file selection again. Server restart restores the saved checkpoint paused, with a new room epoch.
Playing rooms save progress every ten seconds. A crash can lose progress since the last checkpoint; accepted durable commands remain recorded.
Storage write failure pauses clients and rejects mutations. Recovery uses bounded write retries, fresh room state, and explicit host play.
Cleanup runs each minute in bounded batches. It removes expired retry records, invitations, and sessions.
Rooms expire after 30 inactive days; active connections prevent deletion. Identity cleanup requires 365 inactive days and no session, ownership, or membership.
Chromium and Firefox automation check synthetic VP8/WebM playback, including a room with both browsers.
An Opus audio track checks each browser's native autoplay permission handling.
Current stable browser releases, other codecs, mobile suspension, physical displays, and impaired networks need separate evidence.
Safari is outside the roadmap. OVS does not transcode unsupported files.

## Start development

Install these prerequisites:

- The latest stable Go release. `go.mod` declares the minimum supported version.
- Node 24.19.x and pnpm. `.node-version` selects Node 24.19.0.
- Make and Bash on Linux or macOS.
- A C compiler for `make test-race`.
- Docker Engine with Buildx and Compose for container work.

Use your existing tool manager. When pnpm is absent, install it with `npm install --global pnpm`.
No specific pnpm version is required. CI and Docker install the latest release.
Docker activates pnpm through its bundled Corepack and disables automatic manifest pinning.
Installation scripts check system tools. They do not change system packages or Git state.
`make install` retains timestamped logs under ignored `.misc/install/`.

CI selects the latest stable Go release. Docker uses `golang:latest`; Make and Compose builds pull current base images.
Container images and CI actions use tags. The Go compiler has no fixed toolchain pin.

```bash
make install
make dev
```

Open `http://127.0.0.1:8080` to use the embedded application. The development command stores local data in ignored `data/`.
For frontend hot reload, run `make dev-web` in another terminal and open `http://127.0.0.1:5173`.
Vite+ proxies health, API, and WebSocket requests to `127.0.0.1:8080`. The API and WebSocket proxies map the exact development Origin to the backend Origin.
Keep the default backend public origin when using this development proxy.

Go embedding requires generated frontend files. Run `make web-build` before direct `go vet`, `go test`, or `go build` commands.
The Make check, test, development, and build targets prepare these assets automatically.

## Commands

Run `make help` to list the available targets.

| Target | Purpose |
| --- | --- |
| `install`, `setup` | Install locked project dependencies and build the template |
| `deps` | Check tool versions and install locked Go/frontend dependencies |
| `uninstall` | Remove frontend dependencies and build output; preserve data and lockfiles |
| `clean` | Remove generated assets and binaries; preserve dependencies and data |
| `format`, `tidy` | Apply Go and Oxfmt formatting |
| `check` | Check Go formatting/vet, Bash syntax, Oxlint, Vue templates, and Vue types |
| `test` | Run Go and frontend unit/integration tests |
| `test-race` | Run Go tests with the race detector |
| `web-build` | Generate `internal/web/dist/` for Go embedding |
| `build` | Produce `build/ovs`, the project license, and dependency notices |
| `dev` | Run Go with loopback defaults and local storage |
| `dev-web` | Run the Vite+ development server |
| `browser-install` | Install the Chromium and Firefox versions selected by Playwright |
| `test-e2e` | Check shared journeys and decoded-frame measurements in Chromium and Firefox, plus mixed-room playback |
| `image` | Build the single application container |
| `image-smoke` | Check the built image with an isolated persistent volume |
| `bump-major`, `bump-minor`, `bump-patch` | Increase root `VERSION`; no Git mutations |
| `release-commit` | Preview, stage, commit, and push release files after confirmation |
| `release-tag` | Confirm and push an annotated `vX.Y.Z` tag from clean, current `main` |

`make build` accepts `CHANNEL=dev`, `VERBOSE=1`, and `CLEAN=1`. `VERSION` supplies the application version.
Container targets accept `IMAGE=ovs:dev`. Cleanup commands preserve `.misc/` evidence, databases, dependency lockfiles, and system tools.

The Bash scripts under `scripts/` own dependency checks, installation, cleanup, and build sequencing.
Go commands under `scripts/gofmt/`, `scripts/notices/`, `scripts/image-smoke/`, and `scripts/release/` own formatting checks, dependency notices, container verification, and release maintenance.
Use the matching Make targets as the common entry point.

## Release workflow

Use `$release-pr` in Codex or `/release-pr` in Claude Code to prepare a release from `dev` into `main`.
The repository instructions are in [release-pr](.agents/skills/release-pr/SKILL.md).
The workflow reviews the complete branch diff, selects a version increase, prepares `VERSION`, and presents validation and PR text for approval.
After explicit approval, the workflow runs `make release-commit YES=1` and opens the release PR.
Invoking the workflow does not authorize Git writes before that approval.

For manual preparation, run one `make bump-major`, `make bump-minor`, or `make bump-patch` on `dev` or a release topic branch.
These targets change only root `VERSION`, using `MAJOR.MINOR.PATCH` without a prefix or leading zeroes.
They reject an already modified `VERSION`. The private `web/package.json` version stays independent.
No changelog is created. If `CHANGELOG.md` exists, prepare its matching release section before committing; preserve its spacing.

Run the relevant validation, review the diff, then use `make release-commit` when ready to stage, commit, and push.
The command requires a version greater than `HEAD` and rejects unrelated tracked or staged changes.
It stages only `VERSION` and an existing tracked `CHANGELOG.md`, then commits `chore(release): release ovs X.Y.Z`.
An existing `origin` source branch must match `HEAD`, so the push contains only the new release commit.
`YES=1` skips the commit prompt after explicit approval. A failed push retains the local commit; inspect remote state before retrying only the push.

After merging the PR, update a clean `main` checkout to the current `origin/main` and run `make release-tag` separately.
The command previews the tag and requires you to type `vX.Y.Z` in an interactive terminal. `YES=1` cannot bypass this confirmation.
It rejects existing release tags and pushes only the new annotated tag, using changelog notes when available.
A failed tag push retains the local tag; inspect remote state before retrying only that tag push.
OVS has no automated publication workflow. Pushing a tag does not publish an application image or GitHub release.

## Configuration

The application implements these variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OVS_LISTEN_ADDR` | `:8080` | HTTP listener; `make dev` defaults to `127.0.0.1:8080` |
| `OVS_DATA_DIR` | `/data` | SQLite database, sidecars, and application ownership lock |
| `OVS_PUBLIC_ORIGIN` | Required | Canonical browser origin, such as `http://127.0.0.1:8080` |
| `OVS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `OVS_MAX_ACTIVE_ROOMS` | `100` | Active room coordinator cap; 1–1,000 |
| `OVS_MAX_ROOM_MEMBERS` | `32` | Membership cap; 1–32 |

Use a lowercase host. Omit default ports and trailing slashes from the public origin.
The remaining DESIGN configuration variables are not implemented. Forwarding headers are not trusted.
The effective client address comes from the direct connection. Behind a proxy, address rate limits apply to the proxy address until trusted-proxy support is added.
`build/ovs version` prints the build version. `build/ovs healthcheck` checks readiness using the configured listener.

`GET /health/live` checks HTTP process availability. `GET /health/ready` checks startup completion and the SQLite connection.
Both return `204` when successful. Readiness returns `503` on a database connection failure, a latched transaction failure, or shutdown.
After a transaction failure, restore storage health and restart OVS. Automated storage recovery remains later work.
Absent `/api`, `/health`, and `/ws` routes return `404`; they never receive SPA HTML.
`GET /ws/v1/rooms/{roomId}` upgrades only after exact-Origin, cookie, membership, and socket admission checks.

## Storage and deployment

SQLite uses WAL, foreign keys, a five-second busy timeout, and `synchronous=FULL`.
The application uses one database connection and one writer with 128 pending transactions.
Room coordinators admit 64 pending operations each. They retain live sockets and expire after one idle minute without sockets.
Durable operations have a five-second deadline. Saturated queues return `busy`.
Defaults also cap stored rooms at 1,000 and owned rooms at 20 per identity. These bounds are resource controls, not capacity guarantees.
Four migrations create application state, versioned local media, playback checkpoints, and transactional command receipts.
Accepted controls commit before acknowledgement and publication. Playing checkpoints save every ten seconds and on shutdown.
Sockets have 64-frame/256-KiB outputs, five-second write deadlines, five-second heartbeats, and a 15-second liveness expiry.
The instance admits at most 500 sockets and four tabs per membership.
Add each DDL change as a new numbered SQL file under `migrations/`.
Startup checks applied checksums and rejects newer schemas. A second process cannot own the same data directory.

See [deployment examples](deploy/README.md) for direct HTTP and external Caddy arrangements.
The application image embeds the frontend, runs as UID/GID `10001:10001`, and requires writable `/data`.
The final scratch image contains the application, trust certificates, and licenses. It has no Node runtime or separate database service.

Stop OVS before backing up. Copy the entire data directory, including SQLite sidecars, with ownership and modes preserved.
Restore into an empty directory while OVS is stopped. Use a binary compatible with the saved schema.
Do not copy only a live `ovs.sqlite` file or edit applied migrations.

## Validation and boundaries

```bash
make check
make test test-race
make build
make browser-install
make test-e2e
make image image-smoke
```

The tests cover migration upgrades and rollback, identity continuity/expiry/reset, authorization, strict requests, private membership, invitation expiry/rotation, capacity races, serialized revisions, bounded queues, and secret exclusion.
Browser scenarios run serially because they share one server and its address-based admission budgets.
The `chromium` and `firefox` projects run every shared scenario. The `chromium-firefox` project repeats the playback journey with one participant per browser.
Both browser binaries are required: Chromium encodes the synthetic VP8/Opus source for every project, and each tested browser decodes those bytes locally.
On Linux, install missing system libraries with `pnpm --dir web exec playwright install --with-deps chromium firefox`.
After `make build`, select one project with `pnpm --dir web run test:e2e --project=firefox` or `--project=chromium-firefox`.
The identity browser journey uses three isolated profiles to check room creation, sharing, reload continuity, isolation, settings, removal, closure, and identity reset.
Browser screenshots cover light/dark themes and 375/768/1440-pixel widths. Run `OVS_E2E_HOST=<host-LAN-IP> make test-e2e` to check ordinary HTTP outside the loopback secure-context exception.
Real WebSocket tests check admission, serialized HTTP/socket mutations, retry deduplication, stale/changed intents, lease replacement, and paused restart.
Local player journeys cover matching, mismatch, unsupported decoding, replacement cancellation, play/pause/seek, reconnect, and tab ownership.
Reconnect checks combine offline HTTP with explicit closure of the forwarded real room socket. Firefox offline emulation alone can leave an existing socket active.
Both participants exercise permitted controls. Decoded source-frame pixels verify convergence after seek and reconnect, including the mixed room.
Autoplay tests use native Chromium flags or Firefox preferences to require a local gesture before the default waiting barrier can release.
Policy journeys cover waiting timeout, exclusion, buffering recovery, late joining, host loss, and explicit host return.
Three independent timing trials per browser read decoded source-frame pixels in separate foreground headless processes.
They report control application latency separately from frame skew, with calibration, uncertainty, and sparse-tail limits under `.misc/e2e/results/`.
This method does not measure physical display presentation or establish cross-region acceptance.
Shared Go/TypeScript fixtures check profile, settings, and media metadata validation. See [version-1 contracts](specs/wire-v1.md) for exact shapes, bounds, and implementation ownership.
No video transfer or platform credential handling exists.
Live Bilibili/helper and danmaku validation, HTTPS, current stable browser validation, and the full network/release matrix remain required gates.

GitHub Actions runs the same checks. A local pass does not establish a successful hosted CI run.
Linux/amd64 browser automation covers Playwright-pinned Chromium and patched Firefox builds; it does not establish current stable browser acceptance.
macOS, other architectures, TLS, and live Caddy topologies remain unverified.
See [DESIGN](specs/DESIGN.md) for the remaining architecture, release gates, and acceptance matrix.
