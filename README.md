# Open Video Sync

OVS is a private, self-hosted application for synchronized viewing. Each participant supplies their own media. OVS carries control state only.

This repository includes persistent anonymous identities and private rooms with invitation links and codes.
Hosts can save room preferences, rotate invitations, remove participants, and close rooms. Participants can leave rooms.
The Go application embeds the Vue frontend and stores identities, membership, and room settings in SQLite.
Playback and the room WebSocket protocol are not implemented. Bilibili and danmaku require the separate proof of concept described in [DESIGN](specs/DESIGN.md#8-bilibili-integration-and-required-proof-of-concept).
This intermediate stage does not complete the [PRD](specs/PRD.md).

## Use identities and rooms

Open OVS to restore or create your identity automatically. A display name is optional.
Create a room with a title, or enter a private invitation code. Invitation links use `/join#invite=...`; the page removes the fragment before mounting components.
Links and codes expire after seven days. Replacement invalidates both previous secrets. Removing a participant also invalidates previous invitations.
Membership survives browser reload and server restart. Room pages use **Refresh room** to retrieve changes made by other participants.
Host preferences are saved for later playback stages. They do not enable playback in this version.

Sessions use a host-only HttpOnly cookie with a rolling 365-day expiry, renewed at most once daily on bootstrap.
**Forget this identity** revokes the current session. Owned rooms may become inaccessible; ownership does not transfer.
Cookies are scoped to the browser profile and OVS origin. Private profiles receive independent identities.
Invitation secrets appear only when created or replaced. If a response is lost, retry the original request; replace the invitation to obtain new sharing details.

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
Vite+ proxies health and API requests to `127.0.0.1:8080`. The API proxy maps the exact development Origin to the backend Origin.
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
| `browser-install` | Install the Chromium version selected by Playwright |
| `test-e2e` | Build and check identity and room journeys in Chromium over direct HTTP |
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
No production route upgrades to WebSocket before session and membership authorization exists.

## Storage and deployment

SQLite uses WAL, foreign keys, a five-second busy timeout, and `synchronous=FULL`.
The application uses one database connection and one writer with 128 pending transactions.
Room coordinators admit 64 pending operations each and expire after one minute without operations.
Durable operations have a five-second deadline. Saturated queues return `busy`.
Defaults also cap stored rooms at 1,000 and owned rooms at 20 per identity. These bounds are resource controls, not capacity guarantees.
Three migrations create the ledger, identities/sessions, and rooms/memberships/invitations/idempotency outcomes.
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
The browser journey uses three isolated profiles to check room creation, sharing, reload continuity, isolation, settings, removal, closure, and identity reset.
Browser screenshots cover light/dark themes and 375/768/1440-pixel widths. Run `OVS_E2E_HOST=<host-LAN-IP> make test-e2e` to check ordinary HTTP outside the loopback secure-context exception.
The isolated WebSocket test checks transport setup only.
Shared Go/TypeScript fixtures check profile, settings, and media metadata validation. See [version-1 contracts](specs/wire-v1.md) for exact shapes, bounds, and implementation ownership.
There is no synchronized playback, media transfer, platform credential handling, or live-platform test in this stage.
Room expiry cleanup, automatic storage recovery, sockets, and playback remain later-stage work.

GitHub Actions runs the same checks. A local pass does not establish a successful hosted CI run.
Linux/amd64 and Chromium were checked during scaffolding. macOS, other architectures, other browsers, TLS, and live Caddy topologies remain unverified.
See [DESIGN](specs/DESIGN.md) for the remaining architecture, release gates, and acceptance matrix.
