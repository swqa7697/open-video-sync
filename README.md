# Open Video Sync

OVS is a private, self-hosted application for synchronized viewing. Each participant supplies their own media. OVS carries control state only.

This repository includes persistent anonymous identities and private rooms with invitation links and codes.
Hosts can save room preferences, replace invitations, remove participants, and close rooms. Participants can leave rooms.
The Go application embeds the Vue frontend and stores identities, memberships, room settings, and media descriptors in SQLite. Playback, waiting, authorization, and retry results run in application memory.
Authenticated room sockets support local files and browser-local Bilibili AVC/AAC playback with danmaku.
Bilibili uses an instance-scoped Tampermonkey helper, based on the accepted [feasibility path](specs/DESIGN.md#831-accepted-b0-baseline).

## Use identities and rooms

Open OVS to restore or create your identity automatically. A display name is optional.
Create a room with a title, or enter a private invitation code. Invitation links use `/join#invite=...`; the page removes the fragment before mounting components.
Links and codes remain valid until replaced or the room closes. **Share invitation** retrieves the same link and code.
**Replace invitation** resets both values. Removing a participant also replaces the invitation.
Membership survives browser reload and server restart. Room sockets deliver changes automatically; **Refresh room** also retrieves a snapshot.
If the host closes the room, removes you, or your session ends, the page returns to **Your rooms** and states the reason.

The header shows **Server: ready**, **online, but cannot save changes**, or **unreachable**. The page checks again after a failure, a reconnect, or a return online.
Errors begin with **Error:** and name the next step, such as checking the connection, waiting, or reloading. A **Reload page** button appears when only a reload can recover.
The interface works with a keyboard. **Skip to main content** is the first focus stop. After you open, leave, or close a room, focus moves to the new heading.

Sessions use a host-only HttpOnly cookie with a rolling 365-day expiry, renewed at most once daily on bootstrap.
**Forget this identity** revokes the current session. Owned rooms may become inaccessible; ownership does not transfer.
Cookies are scoped to the browser profile and OVS origin. Private profiles receive independent identities.
Only the host can retrieve sharing details. Create/redeem requests retain bounded retry results for 60 seconds in memory.
After an uncertain creation expires, refresh **Your rooms** and choose a new action explicitly. A server restart clears retry results.

## Watch a local video

The host selects a file under **Watch together**. Each participant selects the same file independently.
The optional shared label comes from host input. File names, timestamps, paths, handles, samples, and video bytes stay in each browser.
A worker computes a room-specific sampled SHA-256 digest with pinned `@noble/hashes`; matching works on ordinary HTTP without SubtleCrypto.
Equal size and digest plus duration within 250 ms permit matching. Sampled matching detects accidental differences; it does not prove identical content.

Use **Play together**, **Pause together**, **Seek together**, or **Replay**. The server enforces host/everyone control permissions.
Volume and mute remain local. Playback starts muted. If a browser blocks playback, select **Enable playback**.
Opening the room in a new page automatically takes over playback and disposes the previous page’s player.
The replaced page stays inactive until explicitly reloaded or reopened.
A disconnected browser pauses after five seconds without server liveness, reconnects, obtains state, and recalibrates its clock.
On a high-latency or unstable link the status shows **Synchronization may drift**. Small rate corrections pause, but the participant can still release waits and use room controls.
An uncertain command can be checked with its original ID; controls are never queued for offline replay.

Room preferences contain **Playback controls** (host or everyone) and **Wait for everyone** (enabled by default).
Waiting freezes the connected participants for startup or sustained buffering. Each participant must load matching media and permit playback.
The waiting notice names the participants who are not ready yet. Participants in a host-controlled room see why room controls are unavailable.
Seeking during a wait replaces its target and preserves play intent. Ready late joiners catch up without enlarging an existing wait.
Buffering for at least 750 ms pauses the room. Playback resumes after one second of stable readiness.
A wait times out after 30 seconds and stays paused until an allowed controller explicitly retries.
Changing **Wait for everyone** cancels pending playback and pauses the room. Changing control permission preserves playback.
Disconnected required participants retain a 15-second grace. Controller permission still applies while the host is absent; ownership never transfers.
Reloading requires local file selection again. Restart preserves selected media and metadata, with playback paused at zero in a new epoch.
A failed durable write leaves application memory unchanged. Existing playback continues; fix storage and restart to restore persistent writes.
Bounded expired-session cleanup runs each minute. Rooms and new invitations have no scheduled expiry.

Chromium and Firefox automation check synthetic VP8/WebM playback, including a room with both browsers.
An Opus audio track checks each browser's native autoplay permission handling.
Current stable browser releases, other codecs, mobile suspension, physical displays, and impaired networks need separate evidence.
Safari is outside the roadmap. OVS does not transcode unsupported files.

## Watch Bilibili

### Install or update the helper

1. Install Tampermonkey in each participant's browser.
2. In the room, open **OVS Bilibili helper 1.0.0** to install the reviewed code from your OVS instance.
3. If the manager does not open automatically, create a new userscript and paste the complete code from that link.
4. In Chromium, allow user scripts when the manager requires that setting.
5. Enable the helper for the exact OVS scheme, host, and port. Then reload OVS.

The helper never runs on Bilibili pages or frames. It permits only the reviewed Bilibili API and media CDN destinations.
Automatic remote code updates are disabled. After an OVS update that changes the helper version, install it again from the same instance and reload OVS pages.
The helper is scoped to `OVS_PUBLIC_ORIGIN`. A new origin, such as a switch from HTTP to HTTPS, needs a new helper installation.

### Watch a Bilibili video

The host enters a canonical Bilibili video URL or BV identifier and part, then selects **Select Bilibili video**.
A URL's `p` parameter selects its exact part. Short links require opening Bilibili and copying the canonical video URL.
Other participants select **Load room Bilibili video**. Each profile uses its own platform access and must independently match the CID, part, and duration.
Sign in on Bilibili in that browser profile when required. An access failure leaves only that participant unready; others see **Platform access unavailable** for that participant. OVS supplies no shared access.
Use the same room controls, waiting policies, and local playback permission button as local videos.
Changing media or transferring tab ownership cancels requests, clears buffers and comments, and invalidates old helper handles.
Reloading the page requires loading the room video again.

Danmaku follows observed video time through pause, seek, and rate correction. Visibility, density, and text size remain local.
Fetch/decode failures appear separately from hiding comments. **Reload danmaku** retries the current segment.
Only ordinary scrolling, top, and bottom text comments are displayed. Executable and advanced-script modes are ignored.
There is no comment submission, server persistence, or OVS media/danmaku relay.

The helper keeps provider responses and signed locations in memory. Only stable `{bvid,cid,part,durationMs}` metadata enters the room protocol.
The page requests bounded byte ranges through opaque handles; it cannot supply request URLs, methods, headers, or cookies.
Missing or incompatible helpers do not affect local-file playback. Failures are grouped by the action you can take: install or update the helper, sign in or fix access, wait after rate limits, check network permissions, or choose another part or browser.
The supported delivery path is ordinary on-demand AVC/AAC DASH.
The current helper selects Bilibili video quality 32 or lower, with AAC audio. Live, DRM, paid episodic formats, other codecs, and mobile remain unverified.
Bilibili interfaces can change. See [DESIGN](specs/DESIGN.md#8-bilibili-integration-and-required-proof-of-concept) for the validated baseline and boundaries.

The OVS origin and helper are trusted code. A malicious page on that origin can use its bridge privileges.
Plain HTTP also trusts the network path. The bridge does not protect against a compromised instance, helper, or same-origin script.
The production helper endpoint uses `OVS_PUBLIC_ORIGIN`, never request or forwarding headers.
For Bilibili development, open the embedded Go application at its configured public origin. The Vite hot-reload origin is outside that helper scope.

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
| `test` | Run Go, frontend, and userscript unit/integration tests |
| `test-race` | Run Go tests with the race detector |
| `web-build` | Generate `internal/web/dist/` for Go embedding |
| `build` | Produce `build/ovs`, the project license, and dependency notices |
| `dev` | Run Go with loopback defaults and local storage |
| `dev-web` | Run the Vite+ development server |
| `browser-install` | Install the Chromium and Firefox versions selected by Playwright |
| `test-e2e` | Check shared journeys and decoded-frame measurements in Chromium and Firefox, plus mixed-room playback |
| `image` | Build the single application container |
| `image-smoke` | Check the built image with an isolated persistent volume |
| `proxy-smoke` | Check the built image behind containerized Caddy HTTPS, including trusted-proxy addresses and reconnect after a reload |
| `bump-major`, `bump-minor`, `bump-patch` | Increase root `VERSION`; no Git mutations |
| `release-commit` | Preview, stage, commit, and push release files after confirmation |
| `release-tag` | Confirm and push an annotated `vX.Y.Z` tag from clean, current `main` |

`make build` accepts `CHANNEL=dev`, `VERBOSE=1`, and `CLEAN=1`. `VERSION` supplies the application version.
Container targets accept `IMAGE=ovs:dev`; `proxy-smoke` also accepts `CADDY_IMAGE=caddy:2`. Cleanup commands preserve `.misc/` evidence, databases, dependency lockfiles, and system tools.

The Bash scripts under `scripts/` own dependency checks, installation, cleanup, and build sequencing.
Go commands under `scripts/gofmt/`, `scripts/notices/`, `scripts/image-smoke/`, `scripts/proxy-smoke/`, and `scripts/release/` own formatting checks, dependency notices, container and proxy verification, and release maintenance. `scripts/internal/smoke/` holds their shared API and room-socket helpers.
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
| `OVS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`; logs are JSON on standard error |
| `OVS_TRUSTED_PROXIES` | Empty | Optional comma-separated CIDRs of reverse proxies, such as `172.30.0.2/32` |

Use a lowercase host. Omit default ports and trailing slashes from the public origin.
An `https://` public origin makes the session cookie `Secure`. Links, cookies, and the helper scope always come from this origin, never from request headers.

Address-based request limits use the direct peer address. When that peer matches `OVS_TRUSTED_PROXIES`, OVS reads `X-Forwarded-For` from right to left and uses the first address that is not a trusted proxy.
A missing or malformed header falls back to the proxy's own address, which shares one limit for all its clients. Trust only proxy addresses that clients cannot reach directly.
CIDRs must be masked, such as `10.0.0.0/8`; `/0` and IPv4-mapped prefixes are rejected. See [deployment examples](deploy/README.md#trusted-proxy-addresses) for each topology.
`build/ovs version` prints the build version. `build/ovs healthcheck` checks readiness using the configured listener.

`GET /health/live` checks HTTP process availability. `GET /health/ready` checks in-memory startup, shutdown, and persistent-write failure flags.
Both return `204` when successful. Readiness returns `503` after a persistent transaction failure or during shutdown. Health checks do not query SQLite.
Absent `/api`, `/health`, and `/ws` routes return `404`; they never receive SPA HTML.
`GET /ws/v2/rooms/{roomId}` upgrades only after exact-Origin, cookie, membership, and socket admission checks.

## Deploy and operate

For remote deployment, the server needs Linux, Docker Engine/CLI, and SSH access
with permission to run Docker. The deployment command prepares Compose and optional
Caddy automatically. The local machine uses the normal Go, Make, Docker Buildx, and
SSH development tools. No registry account or remote source checkout is needed.

```bash
# Use your SSH alias and actual public IP or DNS name.
make deploy HOST=ovs-prod URL=https://203.0.113.10

# Later updates reuse the saved origin and proxy settings.
make deploy HOST=ovs-prod
make deploy-status HOST=ovs-prod
make deploy-logs HOST=ovs-prod
make deploy-restart HOST=ovs-prod
make deploy-stop HOST=ovs-prod
```

The example IP is reserved for documentation. Replace it before deployment.
An HTTP URL selects direct HTTP. An HTTPS URL starts a separate Caddy container,
which obtains and renews certificates for a public IP or domain. Public IP
certificates use Let's Encrypt's short-lived profile. Keep TCP 80/443 reachable
and allow Caddy to contact the CA. TLS verification failures fail the deployment
check; they do not enable an internal certificate or disable verification.

Remote updates preserve data, but briefly stop OVS. Playback restarts paused at
zero. Existing manual installations require explicit migration; the tool does
not adopt their containers or volumes. See [remote deployment](deploy/README.md#remote-deployment)
for prerequisites, proxy integration, persistence, and failure handling.

For manual deployment, build the image and start Compose from the repository root:

```bash
make image
OVS_PUBLIC_ORIGIN=http://127.0.0.1:8080 docker compose -f deploy/compose.yaml up -d --wait
```

Compose publishes OVS on `127.0.0.1:8080` and keeps `/data` in a named volume. For LAN access, set the Compose-only variable `OVS_BIND_ADDR` to the host's LAN address and `OVS_PUBLIC_ORIGIN` to the matching browser origin.
OVS itself never reads `OVS_BIND_ADDR`. Direct HTTP needs no certificate, but it does not protect traffic on the network.
For HTTPS, run Caddy on the host, in another container, or in an existing installation. See [deployment examples](deploy/README.md).
Choose the final public origin before you invite people. A new origin means new browser identities, new invitation links, and a new helper installation.
Give each OVS instance its own host name. Browsers share cookies across ports of one host, so an HTTP and an HTTPS instance on the same host name overwrite each other's session cookie.

To update OVS:

1. Check out the new version and run `make image`.
2. Stop the stack with `docker compose -f deploy/compose.yaml down`. Keep the named volume.
3. Optionally make a stopped-directory copy, as described below.
4. Start the stack again with the same `OVS_PUBLIC_ORIGIN` and `up -d --wait`.
5. Reload open OVS pages. Install the helper again if its version changed.

Migrations run automatically at startup. A failed migration stops startup and leaves the data unchanged; fix the cause and start again.
Never start an older binary on a newer schema; it refuses to start. Playback always restarts paused at position zero.
Development installations with application protocol v1 need the [legacy invitation transition](specs/development-upgrade.md).

To copy the data directory, stop OVS first. Copy the entire directory, including SQLite sidecars, with ownership and modes preserved.
Do not copy a live `ovs.sqlite` file alone. A copy contains credentials as of that moment: starting from an old copy restores revoked sessions and replaced invitations.
OVS has no backup, restore, or invalidation command, and no automated downgrade workflow. Use a binary compatible with the saved schema.

## Storage and runtime

SQLite uses WAL, foreign keys, a five-second busy timeout, and `synchronous=FULL`.
The application uses one database connection and one writer with 128 pending transactions.
Room coordinators admit 64 pending operations each. They retain live sockets and expire after one idle minute without sockets.
Durable operations have a five-second deadline. Saturated queues and timed-out requests return `busy`.
Defaults also cap stored rooms at 1,000 and owned rooms at 20 per identity. These bounds are resource controls, not capacity guarantees.
Migration 0006 preserves durable metadata and removes obsolete persisted playback state.
Persistent changes commit before memory installation and acknowledgement. Playback acknowledgements report applied memory state.
Sockets have 64-frame/256-KiB outputs, five-second write deadlines, two-second heartbeats, and a 15-second liveness expiry. Pages pause after five seconds without a server message.
The instance admits at most 500 sockets, with one playback connection per membership.
Add each DDL change as a new numbered SQL file under `migrations/`.
Startup checks applied checksums and rejects newer schemas. A second process cannot own the same data directory.

The application image embeds the frontend, runs as UID/GID `10001:10001`, and requires writable `/data`.
The final scratch image contains the application, trust certificates, and licenses. It has no Node runtime or separate database service.

## Validation and boundaries

```bash
make check
make test test-race
make build
make browser-install
make test-e2e
make image image-smoke proxy-smoke
```

The tests instrument storage to prove zero operations on initialized reads, authorization, playback, readiness, and waiting timers.
They verify failed-write isolation and zero-position restart. They also cover migration upgrades and rollback, identity continuity/expiry/reset, authorization, strict requests, private membership, reusable invitations and explicit replacement, capacity races, serialized revisions, bounded queues, and secret exclusion.
Browser scenarios run serially because they share one server and its address-based admission budgets.
The `chromium` and `firefox` projects run every shared scenario. The `chromium-firefox` project repeats the playback journey with one participant per browser.
Both browser binaries are required: Chromium encodes the synthetic VP8/Opus source for every project, and each tested browser decodes those bytes locally.
On Linux, install missing system libraries with `pnpm --dir web exec playwright install --with-deps chromium firefox`.
After `make build`, select one project with `pnpm --dir web run test:e2e --project=firefox` or `--project=chromium-firefox`.
The identity browser journey uses three isolated profiles to check room creation, sharing, reload continuity, isolation, settings, removal, closure, and identity reset.
It uses the keyboard for the skip link, saving a name, creating and joining rooms, and confirming closure, and checks landmarks, page titles, and focus after each change.
Browser screenshots cover light/dark themes and 375/768/1440-pixel widths for the landing page and a room with an unbroken 48-character name. Run `OVS_E2E_HOST=<host-LAN-IP> make test-e2e` to check ordinary HTTP outside the loopback secure-context exception.
Real WebSocket tests check admission, serialized HTTP/socket mutations, retry deduplication, stale/changed intents, connection replacement, and zero-position restart.
Local player journeys cover matching, mismatch, unsupported decoding, replacement cancellation, play/pause/seek, reconnect, and tab ownership.
Reconnect checks combine offline HTTP with explicit closure of the forwarded real room socket. Firefox offline emulation alone can leave an existing socket active.
Both participants exercise permitted controls. Decoded source-frame pixels verify convergence after seek and reconnect, including the mixed room.
Autoplay tests use native Chromium flags or Firefox preferences to require a local gesture before the default waiting barrier can release.
Policy journeys cover waiting timeout, buffering recovery, ready late joining, and controller permissions during host absence.
Three independent timing trials per browser read decoded source-frame pixels in separate foreground headless processes.
They report control application latency separately from frame skew, with calibration, uncertainty, and sparse-tail limits under `.misc/e2e/results/`.
This method does not measure physical display presentation or establish cross-region acceptance.
Shared Go/TypeScript fixtures check profile, settings, and media metadata validation. See [version-2 contracts](specs/wire-v2.md) for exact shapes, bounds, and implementation ownership.
OVS transports no video, danmaku payloads, signed media URLs, or platform credentials.
Offline helper fault tests cover origin/channel ownership, request bounds, cancellation, expiry refresh, unsafe destinations, and sanitized failures.
Live production Bilibili/helper validation is separate from the ordinary offline suite.
`make proxy-smoke` runs the shipped Compose file and `deploy/compose.caddy.yaml` behind the `caddy:2` image with a local certificate authority.
It checks HTTPS pages, the `Secure` session cookie, the helper scope, trusted-proxy client addresses against spoofed headers, and a same-epoch room socket reconnect after `caddy reload`.
Release acceptance on 2026-10-29 used current stable Chrome 156 and Firefox 159 with Tampermonkey 5.5 on Ubuntu 24.04 (x86_64), including rooms with both browsers.
It covered LAN HTTP, HTTPS through a host Caddy with a local certificate authority in front of the Compose recipe, live Bilibili with danmaku, simultaneous rooms, persistence across container replacement, and impaired control networks.
There is no fixed capacity or statistical-significance release gate.

GitHub Actions runs the same checks. A local pass does not establish a successful hosted CI run.
`make test-e2e` uses Playwright-pinned Chromium and patched Firefox builds. Current stable browser acceptance comes from separate native release checks.
macOS, Windows, other architectures, Safari, and mobile browsers are not verified. `make proxy-smoke` checks container Caddy without a browser. Certificate issuance and DNS belong to the operator's Caddy, not OVS.
See [DESIGN](specs/DESIGN.md) for the remaining architecture, release gates, and acceptance matrix.
