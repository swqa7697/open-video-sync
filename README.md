# Open Video Sync

OVS is a private, self-hosted application for synchronized viewing. Each participant supplies their own media. OVS carries control state only.

This repository includes persistent anonymous identities and private rooms with invitation links and codes.
Hosts can save room preferences, replace invitations, remove participants, and close rooms. Participants can leave rooms.
The Go application embeds the Vue frontend and stores identities, memberships, room settings, and media descriptors in SQLite. Playback, waiting, authorization, and retry results run in application memory.
Authenticated room sockets support local files and browser-local Bilibili AVC/AAC playback with danmaku.
Bilibili uses an instance-scoped Tampermonkey helper, based on the accepted [feasibility path](specs/DESIGN.md#831-accepted-b0-baseline).

## Repository layout

The monorepo contains three modules. Each module owns its source, configuration, and module-specific automation.

| Module                             | Contents                                                           |
| ---------------------------------- | ------------------------------------------------------------------ |
| [sync](modules/sync/README.md)     | Go server, SQLite migrations under `sql/migrations`, Go automation |
| [web](modules/web/README.md)       | Vue frontend, browser adapters, frontend build and unit tests      |
| [helper](modules/helper/README.md) | Tampermonkey script, bridge parser, helper build and tests         |

Root `versions.toml` is the sole release-version source, with `sync`, `web`, and `helper` entries under `[versions]`.
Each module owns its package manager files. Frontend pnpm configuration and its lockfile stay under `modules/web/`.
Private package manifests have no release versions. The frontend declares its helper dependency with a local package link.
Root `scripts/` and Make targets coordinate builds. Shared contracts stay in `specs/`, and application journeys stay in `tests/e2e/`.
Build helper assets first, then the frontend, then the Go binary. `make build` performs this sequence and embeds both distributions.
Root [Dockerfile](Dockerfile) and `.dockerignore` define one application image that builds and bundles all three modules.
Root [deploy/](deploy/README.md) contains shared Compose and Caddy configuration for deploying that complete application.

## Watch together

Open OVS to restore or create your anonymous identity. Edit your optional display name through the profile button.
The header keeps server status, **Settings**, and your identity together. Open **Settings** for **Appearance**, **Language**, **Notifications**, or **About**.
The interface supports English and Simplified Chinese. **Settings → Language** defaults to **Follow system**.
Chinese device languages use Simplified Chinese; other device languages use English. Choose **简体中文** or **English** to override.
Language changes apply immediately, including current status and error messages, and stay in this browser across reloads.
Use **Settings → Appearance** to choose Slate blue (default), Soft iris, Graphite, Quiet teal, Sage green, Dusty rose, Warm amber, Ocean blue, or Soft clay.
The color mode defaults to **Dark**. Choose **Light** or **Dark** manually; device theme changes do not affect OVS.
These choices stay in this browser across reloads; they are not room settings. If browser storage is blocked, choices last until reload.
Dialogs use short transitions and buttons give subtle pointer feedback. Keyboard actions stay immediate; reduced motion uses a brief dialog fade.
Notifications appear as dismissible bottom toasts without moving the page. **Settings → Notifications** selects Left, Center, or Right (default).
**Settings → About** shows the running Sync service and the Web frontend and Helper script bundled in the deployed image.

Press **Cmd/Ctrl + K** or select **Quick actions** beside the OVS logo to search available actions in English or Chinese.
Use **↑/↓** to select, **Enter** to run, and **Esc** to close. The menu opens and closes immediately and returns focus to your previous control.
Search stays in the current page. Actions follow room permissions and connection state.

| Input                                                                                                | Action                                                                                                                             |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `$ BV…`, `$ https://www.bilibili.com/video/…`, or a video link/BV identifier alone                   | Prefill the home picker or the host's Change video dialog, preserving the selected part. Review and confirm before changing media. |
| `/video`, `/local`                                                                                   | Open the video picker or select your own local file.                                                                               |
| `/play`, `/pause`, `/replay`, `/seek`                                                                | Control shared playback or focus the seek control.                                                                                 |
| `/invite`, `/members`, `/room`                                                                       | Open invitations, members, or room preferences when available.                                                                     |
| `/create`, `/join`, `/profile`                                                                       | Focus the home room form, invitation input, or your profile.                                                                       |
| `/appearance`, `/language`, `/about`                                                                 | Open an application settings panel.                                                                                                |
| `/theme light`, `/theme dark`, `/accent iris`, `/language en`, `/language zh-CN`, `/language system` | Change a browser-local preference directly.                                                                                        |

The `/` prefix filters commands. The `$` prefix selects the video-link action. Partial names and multiple search words also work.
Use `/mute`, `/fullscreen`, and `/danmaku` for browser-local sound, fullscreen, and Bilibili comment controls.

On home, select **Bilibili** or **Local file**. Preview a canonical Bilibili URL/BV identifier, or choose/drop a supported local video.
Select a multipart video's part in the preview. Short links must first be opened on Bilibili to obtain the canonical URL.
The room name is optional; the default is **Watch party**. Local filenames never become shared room names.
**Room settings** changes the creation draft: host-only playback and waiting for everyone are the defaults.
Select **Create room** to save the room with its initial media. The room begins paused.
The creator's selected local file stays available through this in-app transition.

Paste an invitation link or code on home, or open an invitation link to enter automatically.
Links use `/join#invite=...`; OVS removes the fragment before mounting provider components.
Pending invitations remain in the current browser history entry until joining succeeds, so helper installation and page reloads can resume joining.
After installing the helper, reload the original tab to enter the invited room automatically. You do not need to reopen the invitation or select **Join** again.
Bilibili loads automatically on entry and media changes, using each participant's own helper and access.
When a loaded Bilibili video has multiple parts or belongs to a collection, switch the right sidebar between **Members** and **Episodes**.
The current episode is marked. Only the host can select another episode for the room; playback restarts paused at zero.
On narrow screens, open **Members and episodes** in the room toolbar to use the same tabs in a dialog.
For local media, select your own matching file inside the player. Reloading requires local-file reselection.
There is no home room directory. An existing member can revisit an authorized room URL while the room remains open.

**Invite** shows the host's reusable link and code. Copy actions fall back to selectable text on ordinary HTTP.
**Replace invitation** resets both values. Sharing again, joining, leaving, and removing a participant keep the invitation unchanged.
Different participants can reuse it until the host replaces it or the room closes. The host can return through the room URL or the current invitation.
Only the host can retrieve invitations, replace media, change settings, remove participants, or close the room for everyone.
Room settings and destructive confirmation appear in dialogs. **Members** toggles a side panel or opens a narrow-screen dialog.

**Leave** asks for confirmation before leaving the active session. The OVS logo opens home in a new tab and supports middle click. After the host leaves, everyone can control playback without gaining management rights.
A returning host keeps Everyone enabled and can deliberately change it later. Ownership never transfers.
The final explicit departure closes the room immediately. Closing a room page starts a 30-second reconnection grace.
Refresh, brief disconnection, tab replacement, and backgrounding do not by themselves close the room.
After server restart, restored rooms have 60 seconds for reconnection before empty rooms close.
Restarted playback begins paused at zero with a fresh epoch. Invitations stop working after closure.

The header reports server availability. Failed persistent changes leave memory unchanged.
A failed automatic departure transition reports a storage error to remaining viewers and stops automatic lifecycle writes until restart.
Existing playback stays available; the operator must fix storage and restart OVS.
Create/redeem retry results remain in memory for 60 seconds. An uncertain creation checks its original request and known room ID.
Recovery never automatically creates another room or depends on a room list.

Sessions use a host-only HttpOnly cookie with rolling 365-day expiry, renewed at most daily.
**Forget this identity** revokes the current session. Owned rooms may become inaccessible; ownership does not transfer.
Cookies are scoped to the browser profile and OVS origin. Private profiles receive independent identities.

## Player controls

Play/pause, replay, seeking, volume, mute, and fullscreen are inside the video surface.
Shared controls follow server permissions. Volume, mute, fullscreen, quality, and danmaku affect only your browser.
The player has no playback-speed menu. Small synchronization rate corrections remain automatic.
Click the video surface or use Space/K anywhere on the foreground OVS page for playback; player focus is not required. Left/Right seeks five seconds; Up/Down changes volume by 10%.
M toggles mute, D toggles Bilibili danmaku, and F toggles fullscreen. Text inputs and sliders keep their native keyboard behavior.
Menus and dialogs keep their keyboard controls, including Space activation on buttons. Outside these surfaces and inputs, Space controls playback even when a button retains focus after a click or dialog dismissal. Enter still activates focused buttons. Focus uses subtle color feedback without outlines and stays on the current control. Switching tabs or putting the browser in the background does not pause playback. Shared controls and synchronization continue while connected.
Controls remain available while keyboard focus is inside them. Dialogs support Escape and restore focus.
Change video supports Enter to confirm. Playback starts unmuted at 50% volume; volume and mute choices survive reloads in this browser. When autoplay is blocked, select **Enable playback** inside the video.

Every participant supplies their own local file. OVS exchanges only a room-specific sampled SHA-256 digest, size, and duration.
Filenames, paths, handles, timestamps, object URLs, samples, and video bytes stay in the browser.
A worker uses `@noble/hashes` so matching works on ordinary HTTP without SubtleCrypto.
Equal size and digest, plus duration within 250 ms, permit matching. Sampled matching detects accidental differences; it does not prove identical content.

A new page takes playback ownership from the same identity's previous page in that room. The old page disposes its player.
A disconnected browser pauses after five seconds without liveness, reconnects, fetches state, and recalibrates its clock.
While a room command awaits its server acknowledgement, keep the player layout and button appearance stable and prevent duplicate controls. After more than three seconds without a result, an additional overlay offers **Check original command**, which retries with its original ID. This delay measures only the command round trip; video loading, buffering, and participant readiness have separate status and timers. Controls are never queued for offline replay.

Waiting freezes the connected participants for startup or sustained buffering. Ready late joiners catch up without enlarging an existing wait.
Buffering for 750 ms pauses the room; one second of stable readiness permits resumption.
A wait times out after 30 seconds and stays paused until an allowed controller retries.
Changing **Wait for everyone** pauses playback and cancels pending play intent. Changing control permission preserves playback.
A disconnected required participant retains a separate 15-second waiting grace.

## Bilibili helper and local preferences

Install the Tampermonkey browser extension independently. OVS installation buttons install only the instance-specific **OVS playback helper**.
A missing or outdated helper produces a bottom toast and an entry dialog. **Later** dismisses the dialog; local workflows remain available.
Use **Install OVS helper**, **Update helper**, or **Install matching helper**, then confirm installation/replacement in Tampermonkey.
Return to OVS and select **Reload page** to activate the installed script. Updating uses the same script name and namespace within an instance.
Automatic remote code updates remain disabled. A changed OVS origin needs a helper scoped to that origin.
The bundled `modules/helper/dist/release.json` supplies the helper release version from root `versions.toml` and a fingerprint of the built script. OVS also detects outdated helpers when a development update keeps the same release version. An outdated open application asks for a refresh before recommending a mismatched helper.
For development with frontend hot reload, install the helper from the Vite page. Vite supplies a helper scoped to that exact development origin.
After updating an existing development checkout, update the instance helper and reload so its build matches the frontend.

The helper runs only on the configured OVS origin, never on Bilibili pages or frames. Each profile uses its own platform access.
Sign in on Bilibili in that profile when required. Access failures leave only that participant unready.
Provider responses and signed media locations stay in helper memory. The room receives only `{bvid,cid,part,durationMs}`.
When a track's primary address is unsupported, the helper selects a permitted HTTPS CDN backup from the platform response. If none is supported, OVS reports an incompatible media address.
The page requests bounded byte ranges through opaque handles. It cannot supply URLs, headers, methods, or cookies.

The player lists the returned playable AVC qualities and requests the selected quality through the helper.
The dedicated quality button opens a small selection menu. The browser remembers the preferred quality across media changes and reloads.
Without a preference, or when the preferred tier is unavailable, choose the highest returned playable quality. Retry keeps the preference.
Switching reloads local media buffers, reports readiness, and converges to the authoritative room position without changing room playback intent.
Only an active loaded quality is displayed as selected. No adaptive Auto mode is offered.
Large DASH fragments, including those above 64 MiB, stream through bounded chunks without whole-fragment assembly.
The player limits prefetch and reclaims played buffers under memory pressure. Browser memory and codec limits still apply.
Quality switching needs new live-platform validation; the earlier B0 evidence covers the previous fixed-quality path.
DASH AVC/AAC remains the supported path. Live, DRM, paid episodic formats, other codecs, and mobile are unverified.

Danmaku follows observed playback through pause and seek. Visibility, density, and text size remain local.
Click the danmaku icon to toggle comments; hover over it for density, text size, status, and reload controls.
With keyboard focus on the icon, press Down to open settings and Escape to close. On touchscreens, long press the icon.
The player has no separate settings button; local videos show no danmaku controls.
Hidden comments and loading failures have separate status. **Reload danmaku** retries loading.
Only ordinary scrolling, top, and bottom text comments are rendered; executable modes are ignored.
Local files do not show quality or danmaku menus. There is no comment submission, OVS media relay, or media persistence.

Chromium and Firefox automation use synthetic VP8/WebM and native autoplay checks.
Live Bilibili quality switching, independent platform sessions, real mobile devices, and cross-region networks require explicit separate evidence.
The OVS origin and helper are trusted code. Plain HTTP also trusts the network path.
See [DESIGN](specs/DESIGN.md#8-bilibili-integration-and-required-proof-of-concept) for the accepted baseline and boundaries.

## Start development

Install these prerequisites:

- The latest stable Go release. `modules/sync/go.mod` declares the minimum supported version.
- Node 24.19.x and pnpm. `.node-version` selects Node 24.19.0.
- Make and Bash on Linux or macOS.
- [uv](https://docs.astral.sh/uv/getting-started/installation/) (provides `uvx`) for Makefile formatting and format checks.
- A C compiler for `make test-race`.
- Docker Engine with Buildx and Compose for container work.

Install pnpm with your existing tool manager or the [official standalone installer](https://pnpm.io/installation#using-a-standalone-script).
No specific pnpm version is required. CI and Docker install the latest release.
Docker activates pnpm through its bundled Corepack and disables automatic manifest pinning.
Installation scripts check system tools. They do not change system packages or Git state.
`make install` prints output to the terminal without creating a log file.

Manage frontend dependencies with `pnpm --dir modules/web add <package>`, `pnpm --dir modules/web remove <package>`, and `pnpm --dir modules/web update`.
Use the default `^` version ranges. Let the official Vite+ CLI manage its toolchain catalog, including matching version pins and overrides.
Reconcile that pairing with `pnpm --dir modules/web exec vp migrate --no-interactive --no-agent --no-editor --no-hooks`.
Keep the separate ESLint Vue template checks; a full migration can skip those rules and remove ESLint.
Use `pnpm --dir modules/web pkg` for package scripts and metadata. Do not edit `package.json` manually or mix npm/npx commands.
Let pnpm maintain `modules/web/pnpm-lock.yaml`; installation and CI use `--frozen-lockfile` for reproducible installs.

CI selects the latest stable Go release. Docker uses `golang:latest`; Make and Compose builds pull current base images.
Container images and CI actions use tags. The Go compiler has no fixed toolchain pin.

```bash
make install
make dev
```

Open `http://127.0.0.1:8080` to use the embedded application. The development command stores local data in ignored `data/`.
For frontend hot reload, run `make dev-web` in another terminal and open `http://127.0.0.1:5173` or `http://localhost:5173`.
Vite+ proxies health, API, and WebSocket requests to `127.0.0.1:8080`. The API and WebSocket proxies map only these two development origins to the backend origin.
The development server builds and serves the local helper and release metadata. Install the helper from the same development page, then reload. A helper installed from port `8080` or another hostname does not activate on that page.
Keep the default backend public origin when using this development proxy.

Go embedding requires generated frontend files. Run `make web-build` before direct Go commands. Run Go commands from `modules/sync`, or use `go -C modules/sync`.
The Make lint, check, test, development, and build targets prepare these assets automatically.

## Commands

Run `make help` to list the available targets.

| Target                                   | Purpose                                                                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `install`, `setup`                       | Install locked project dependencies and build the template                                                             |
| `deps`                                   | Check tool versions and install locked Go/frontend dependencies                                                        |
| `upgrade`                                | Upgrade frontend dependencies, then Go modules                                                                         |
| `upgrade-frontend`                       | Upgrade frontend dependencies within current majors and align the latest Vite+ toolchain                               |
| `upgrade-backend`                        | Upgrade Go modules within current module paths, including test dependencies                                            |
| `uninstall`                              | Remove frontend dependencies, build output, and local `data/`; preserve dependency lockfiles                           |
| `clean`                                  | Remove generated assets, binaries, and local `data/`; preserve dependencies                                            |
| `format`, `tidy`                         | Format Go, frontend, scripts, documentation, and configuration                                                         |
| `format-check`                           | Check the same formatting without changing source files                                                                |
| `lint`                                   | Run Go vet, Bash syntax checks, Oxlint, and ESLint Vue template checks                                                 |
| `check`                                  | Run `format-check`, `lint`, and Vue type checks                                                                        |
| `test`                                   | Run Go, frontend, and userscript unit/integration tests                                                                |
| `test-race`                              | Run Go tests with the race detector                                                                                    |
| `helper-build`                           | Build helper assets and copy them for Go embedding                                                                     |
| `web-build`                              | Generate `modules/sync/internal/web/dist/` for Go embedding                                                            |
| `build`                                  | Produce `modules/sync/build/ovs`, the project license, and dependency notices                                          |
| `dev`                                    | Run Go with loopback defaults and local storage                                                                        |
| `dev-web`                                | Run the Vite+ development server                                                                                       |
| `browser-install`                        | Install the Chromium and Firefox versions selected by Playwright                                                       |
| `test-e2e`                               | Check shared journeys and decoded-frame measurements in Chromium and Firefox, plus mixed-room playback                 |
| `image`                                  | Build the single application container                                                                                 |
| `image-smoke`                            | Check the built image with an isolated persistent volume                                                               |
| `proxy-smoke`                            | Check the built image behind containerized Caddy HTTPS, including trusted-proxy addresses and reconnect after a reload |
| `bump-major`, `bump-minor`, `bump-patch` | Increase a module version in `versions.toml`; no Git mutations                                                         |
| `release-commit`                         | Preview, stage, commit, and push release files after confirmation                                                      |
| `release-tag`                            | Confirm and push an annotated `vX.Y.Z` tag from clean, current `main`                                                  |

`make build` accepts `CHANNEL=dev`, `VERBOSE=1`, and `CLEAN=1`. `CLEAN=1` runs `make clean` first, including deletion of local `data/`. `versions.toml` supplies all module release versions; `versions.sync` selects the Go binary version.
Stop the development server before running `make clean`, `make uninstall`, or `make build CLEAN=1`. These commands reset the repository's `data/` directory, including its database and ownership lock. They preserve custom `OVS_DATA_DIR` locations, `.misc/`, `.tmp/`, dependency lockfiles, global caches, Docker resources, and system tools. Frontend tool caches inside `node_modules/` remain with `make clean` and are removed with `make uninstall`.
Container targets default to `ovs:s<sync>-w<web>-h<helper>`, using all three module versions, and accept an `IMAGE` override. The prefixes `s`, `w`, and `h` identify sync, web, and helper. `node scripts/versions.mjs image-tag` prints the combined tag without the `ovs:` prefix. `proxy-smoke` also accepts `CADDY_IMAGE=caddy:2`.

Make commands and lifecycle scripts use target labels and terminal colors. Set `NO_COLOR=1` to disable colors; redirected logs remain plain.
Use `VERBOSE=1` to show recipe commands and enable tracing in installation and build scripts.

`make tidy` and `make format` run the root `tidy.sh` script and update files in place.
Run `./tidy.sh` from the repository root, or invoke the script by its path from another working directory.
The script applies `gofmt` to Go files, including Go automation under `modules/sync/scripts/`.
Prettier formats frontend sources, browser tests, userscripts, Markdown documentation, and JSON/YAML configuration.
The `prettier-plugin-sh` plugin formats Bash scripts, including `tidy.sh`. Both packages are locked frontend development dependencies, installed by `make deps`.
The script runs [mbake](https://github.com/EbodShojaei/bake) through `uvx` to format `Makefile`, using repository-owned `.bake.toml` settings.
`./tidy.sh --check` checks all the same files without changing them; `make format-check` uses this mode.
Root `.prettierrc.cjs` supplies shared options and resolves the shell plugin from `modules/web/node_modules`, including for editor integrations.
The script explicitly reads `.gitignore` and `.prettierignore` to exclude dependencies, generated files, local state, artifacts, and lockfiles.
`.misc/` and `.tmp/` are excluded through `.gitignore`, so batch formatting skips both directories while VS Code Prettier can still format their files on save.
Frontend package format scripts also use `tidy.sh` to keep formatter commands in one place.
`make lint` checks backend and frontend code without applying fixes. `make check` includes lint and adds formatting and Vue type checks.
CI continues to use `make check`, so these checks run once through the shared targets.

`make upgrade-frontend` runs the latest official [Vite+ migrator](https://viteplus.dev/guide/upgrade-project) to align its toolchain catalog and aliases.
Then `pnpm dlx taze minor --write` updates other dependency ranges within their current major versions.
Vite+ toolchain packages are excluded from taze. The command finishes with `pnpm install --no-frozen-lockfile` to refresh the lockfile.
Review migration notices before accepting the result.

`make upgrade-backend` builds the embedded frontend assets, runs `go get -u -t ./...`, then runs `go mod tidy`.
The [Go command](https://go.dev/ref/mod#go-get) upgrades modules and test dependencies within their existing module paths.
Major versions that change a module path require a separate migration. Dependencies can raise the minimum Go version in `modules/sync/go.mod`.
The target removes any suggested `toolchain` directive so the project retains only its minimum Go requirement.

After either upgrade, review the manifest and lockfile changes. Run `make check`, `make test test-race`, and `make build`.

The Bash scripts under `scripts/` own dependency checks, installation, cleanup, and build sequencing.
Go commands under `modules/sync/scripts/gofmt/`, `modules/sync/scripts/notices/`, `modules/sync/scripts/image-smoke/`, `modules/sync/scripts/proxy-smoke/`, and `modules/sync/scripts/release/` own formatting checks, dependency notices, container and proxy verification, and release maintenance. `modules/sync/scripts/internal/smoke/` holds their shared API and room-socket helpers.
Use the matching Make targets as the common entry point.

## Release workflow

Use `$release-pr` in Codex or `/release-pr` in Claude Code to prepare a release from `dev` into `main`.
The repository instructions are in [release-pr](.agents/skills/release-pr/SKILL.md).
The workflow reviews the complete branch diff and opens or reuses the release PR before any version bump.
It waits for hosted PR CI. If CI fails, it diagnoses the cause, applies and validates a focused fix, then commits and pushes when explicitly authorized and waits again until CI passes.
Only after CI succeeds does it select a version increase, prepare `versions.toml`, and present validation and final PR text for approval.
After explicit approval, it runs `make release-commit YES=1`, updates the same PR, and verifies CI for the final commit through the same repair loop.
Invoking the workflow does not authorize Git writes. Existing explicit authorization for the named CI repair loop is reused.

For manual preparation, run one `make bump-major`, `make bump-minor`, or `make bump-patch` on `dev` or a release topic branch.
These targets change only root `versions.toml`, using `MAJOR.MINOR.PATCH` without a prefix or leading zeroes.
Select `MODULE=sync` (default), `MODULE=web`, or `MODULE=helper`. Each target rejects a second bump of the same module.
Private package manifests omit release versions; generated metadata always reads `versions.toml`.
No changelog is created. If `CHANGELOG.md` exists, prepare its matching release section before committing; preserve its spacing.

Run the relevant validation, review the diff, then use `make release-commit` when ready to stage, commit, and push.
The command requires a sync version greater than `HEAD` and rejects decreases in any module version and rejects unrelated tracked or staged changes.
It stages only `versions.toml` and an existing tracked `CHANGELOG.md`, then commits `chore(release): release ovs X.Y.Z`.
An existing `origin` source branch must match `HEAD`, so the push contains only the new release commit.
`YES=1` skips the commit prompt after explicit approval. A failed push retains the local commit; inspect remote state before retrying only the push.

After merging the PR, update a clean `main` checkout to the current `origin/main` and run `make release-tag` separately.
The command previews the tag and requires you to type `vX.Y.Z` in an interactive terminal. `YES=1` cannot bypass this confirmation.
It rejects existing release tags and pushes only the new annotated tag, using changelog notes when available.
A failed tag push retains the local tag; inspect remote state before retrying only that tag push.
OVS has no automated publication workflow. Pushing a tag does not publish an application image or GitHub release.

## Configuration

The application implements these variables:

| Variable              | Default  | Purpose                                                                    |
| --------------------- | -------- | -------------------------------------------------------------------------- |
| `OVS_LISTEN_ADDR`     | `:8080`  | HTTP listener; `make dev` defaults to `127.0.0.1:8080`                     |
| `OVS_DATA_DIR`        | `/data`  | SQLite database, sidecars, and application ownership lock                  |
| `OVS_PUBLIC_ORIGIN`   | Required | Canonical browser origin, such as `http://127.0.0.1:8080`                  |
| `OVS_LOG_LEVEL`       | `info`   | `debug`, `info`, `warn`, or `error`; logs are JSON on standard error       |
| `OVS_TRUSTED_PROXIES` | Empty    | Optional comma-separated CIDRs of reverse proxies, such as `172.30.0.2/32` |

Use a lowercase host. Omit default ports and trailing slashes from the public origin.
An `https://` public origin makes the session cookie `Secure`. Links, cookies, and the helper scope always come from this origin, never from request headers.

Address-based request limits use the direct peer address. When that peer matches `OVS_TRUSTED_PROXIES`, OVS reads `X-Forwarded-For` from right to left and uses the first address that is not a trusted proxy.
A missing or malformed header falls back to the proxy's own address, which shares one limit for all its clients. Trust only proxy addresses that clients cannot reach directly.
CIDRs must be masked, such as `10.0.0.0/8`; `/0` and IPv4-mapped prefixes are rejected. See [deployment examples](deploy/README.md#trusted-proxy-addresses) for each topology.
`modules/sync/build/ovs version` prints the build version. `modules/sync/build/ovs healthcheck` checks readiness using the configured listener.

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
export IMAGE="ovs:$(node scripts/versions.mjs image-tag)"
make image
OVS_PUBLIC_ORIGIN=http://127.0.0.1:8080 docker compose -f deploy/compose.yaml up -d --wait
```

Compose requires `IMAGE` in the shell environment. The command above combines the sync, web, and helper versions from `versions.toml`.
Export `IMAGE` again in a new shell or after changing versions. To use a custom image name, export that name before building and starting Compose.

Compose publishes OVS on `127.0.0.1:8080` and keeps `/data` in a named volume. For LAN access, set the Compose-only variable `OVS_BIND_ADDR` to the host's LAN address and `OVS_PUBLIC_ORIGIN` to the matching browser origin.
OVS itself never reads `OVS_BIND_ADDR`. Direct HTTP needs no certificate, but it does not protect traffic on the network.
For HTTPS, run Caddy on the host, in another container, or in an existing installation. See [deployment examples](deploy/README.md).
Choose the final public origin before you invite people. A new origin means new browser identities, new invitation links, and a new helper installation.
Give each OVS instance its own host name. Browsers share cookies across ports of one host, so an HTTP and an HTTPS instance on the same host name overwrite each other's session cookie.

To update OVS:

1. Check out the new version, refresh `IMAGE` with the export command above, and run `make image`.
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
Add each DDL change as a new numbered SQL file under `modules/sync/sql/migrations/`.
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
On Linux, install missing system libraries with `pnpm --dir modules/web exec playwright install --with-deps chromium firefox`.
After `make build`, select one project with `pnpm --dir modules/web run test:e2e --project=firefox` or `--project=chromium-firefox`.
The identity browser journey uses three isolated profiles to check room creation, sharing, reload continuity, isolation, settings, removal, closure, and identity reset.
It uses the keyboard for the skip link, saving a name, creating and joining rooms, and confirming closure, and checks landmarks, page titles, and focus after each change.
Browser screenshots cover light/dark themes at 390×844, 1024×768, and 1440×900 for home and a room with an unbroken 48-character name. Appearance checks cover live system changes, local persistence, keyboard selection, reduced motion, and blocked storage. Quick actions checks cover keyboard and IME input, focus restoration, permission restrictions, video prefilling without publication, and short and narrow viewports. Run `OVS_E2E_HOST=<host-LAN-IP> make test-e2e` to check ordinary HTTP outside the loopback secure-context exception.
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
