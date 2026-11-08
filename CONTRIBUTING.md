# Development

Read [AGENTS.md](AGENTS.md) for repository rules, [PRD](specs/PRD.md) for product requirements, and [DESIGN](specs/DESIGN.md) for technical contracts.

## Prerequisites

- Latest stable Go; `modules/sync/go.mod` and `scripts/go.mod` declare the minimum versions.
- Node as selected by `.node-version`, and pnpm. No specific pnpm version is required.
- Make and Bash on Linux or macOS.
- `uv` with `uvx` for Makefile formatting.
- A C compiler for the Go race detector.
- Docker with Buildx and Compose for container validation; OpenSSH for remote deployment.

## Local development

```bash
make install
make dev
```

Open <http://127.0.0.1:8080>. Local data stays in ignored `data/`.
For frontend hot reload, run `make dev-web` in another terminal and open <http://127.0.0.1:5173> or <http://localhost:5173>.
The development proxy forwards API, health, and WebSocket requests to Go. Keep the default backend public origin.
Install the Bilibili helper from the frontend development page and reload; the helper is scoped to that exact origin.

Run `make help` for all commands. `make format` changes files; `make check` runs read-only format, lint, and type checks.
The root `.prettierrc` defines shared formatting for JavaScript, TypeScript, Vue, Bash, documentation, and configuration.
Prettier organizes JavaScript, TypeScript, and Vue imports: it sorts and combines imports and removes unused bindings.
Place new imports in the groups defined in [AGENTS.md](AGENTS.md); Prettier preserves blank-line boundaries and organizes each group.
Keep one blank line between the final import and the following code or its comments; `make format` fixes this and `make check` enforces it.
The Go formatter uses `golang.org/x/tools/imports` from the locked `scripts` module to organize imports and apply `gofmt` formatting.
VS Code applies Prettier on save and uses the Go extension's organize-imports action for Go files.
Keep required side effects as bare imports (`import './style.css'` in JavaScript or `_` imports in Go).
For JavaScript, TypeScript, or Vue files with intentional import evaluation order, add `// organize-imports-ignore` to preserve that order.
`make clean`, `make uninstall`, and `make build CLEAN=1` delete repository-local `data/`. Stop the development server before using them.

## Modules and builds

| Module                             | Responsibility                                               |
| ---------------------------------- | ------------------------------------------------------------ |
| [sync](modules/sync/README.md)     | Go server, SQLite persistence, HTTP and WebSocket transports |
| [web](modules/web/README.md)       | Vue interface, player adapters, synchronization              |
| [helper](modules/helper/README.md) | Tampermonkey helper and browser bridge                       |

`make build` builds helper assets, then the frontend, then the Go binary with both distributions embedded.
Output goes to `modules/sync/build/`. Run `make web-build` before direct server Go commands because Go embeds generated frontend assets.

Repository automation has an independent Go module under [scripts](scripts/README.md), with its own `go.mod` and `go.sum`.
Root Make targets check and test both Go modules. Automation tests do not require frontend assets.

`versions.toml` is the sole release-version source for sync, web, and helper. Private package manifests omit release versions.
Builds capture the full image reference, release status, Git commit, dirty state, and exact Git tag. About displays image identity above component versions, with commit details only for development builds. `make image` and `make deploy` capture this metadata automatically, including explicit `IMAGE` overrides. For direct Docker builds, use the same image name for the snapshot and Docker tag:

```bash
docker build -f deploy/Dockerfile -t my-ovs:testing \
  --build-arg OVS_BUILD_INFO="$(IMAGE=my-ovs:testing node scripts/versions.mjs build-info)" .
```

`modules/sync/sql/schema.sql` always defines the complete, current database schema. Update it whenever the schema changes.
Go embedding stays in `modules/sync/sql/embed.go`. Startup initializes an empty database transactionally from that definition and records the supported schema version with SQLite `user_version` and the included migration ledger. Startup validates an existing current database without running migration SQL.
Add immutable, consecutively numbered SQL files under `modules/sync/sql/migrations/` for incremental changes. Migration IDs are independent of the release-level schema version: one schema release can include several migrations. Register each ID in the ordered registry; choose the schema version for the release separately. The deployment-only `ovs migrate` command takes the data-directory lock, validates the applied ledger prefix and recorded checksums, and applies all pending IDs in one transaction before recording the target schema version. `make deploy` invokes this command with the candidate image after stopping OVS and before starting the replacement. New databases use the latest complete definition directly, without running historical migrations. For a local database upgrade, stop OVS, run the candidate binary with `OVS_DATA_DIR` pointing to that directory and the `migrate` argument, then start it. No public-origin configuration is required for migration.

## Dependencies

Use pnpm for frontend package operations and `pnpm pkg` for package metadata. Keep `modules/web/pnpm-lock.yaml` generated by pnpm.
Use default `^` ranges, with the Vite+ CLI managing its own catalog pins and overrides. Retain separate Vue template checks.
`make upgrade-frontend` runs the official Vite+ migrator and updates other dependencies within their current major versions.
`make upgrade-backend` updates server Go dependencies within their current module paths, including test dependencies.
`make upgrade-tools` updates the independent Go automation dependencies. `make upgrade` includes both targets and the frontend upgrade.
Review manifest and lockfile changes, then run the validation sequence below.

## Validation

```bash
make check
make test test-race
make build
```

For browser behavior, install Playwright browsers with `make browser-install`, then run `make test-e2e`.
Browser journeys use up to four workers locally and two in CI, bounded by available CPUs, with a fresh application instance and database for each test. CI retains browser failure screenshots and traces for seven days.
Set `OVS_E2E_PORT` to choose the first worker port when running another suite at the same time; the default is 18080.
Use observable state or explicit response gates instead of sleeps. Keep timer boundaries in fake-clock tests.
The routine suite captures screenshots on failure and retains failure traces.
Run optional decoded-frame and control-latency trials separately with `make test-e2e-measure`.
Container checks use `make image image-smoke`; reverse-proxy checks use `make proxy-smoke`.
See [deployment validation](deploy/README.md#remote-deployment-validation) and [network checks](tests/network/README.md) for specialized checks.
Routine tests remain offline. Live Bilibili and actual-network checks require separate validation.
Retain implementation evidence under ignored `.misc/`. Local results do not establish hosted CI success.

### Bilibili test data

Tracked tests, shared contract fixtures, and smoke clients use invented Bilibili metadata.
Use format-valid `BV1TESTaaaaa`-style values and decimal IDs from the synthetic `9000000000001` series.
These values are test conventions, not identifiers reserved by Bilibili. Never resolve them against the platform.
Keep malformed and numeric-boundary cases where validation needs them.
Parser and security tests retain canonical platform domains and URL shapes with synthetic resource IDs.
Use invented titles, including long Chinese text for layout coverage, and generate media bytes locally.
The Bilibili browser journeys execute the adapter and bundled helper with intercepted platform requests; they do not prove live platform compatibility.

There is currently no automated live-Bilibili runner or live CI job.
If both local development and CI need live coverage, use a separate, explicitly enabled runner with this input contract:

- Read selections from `OVS_LIVE_BILIBILI_CASES_FILE`, pointing to an untracked JSON file such as `.misc/live-bilibili/cases.json`.
  Track only the schema and an empty example; supply each case's alias, selection, and expected access outcome outside Git.
- Use the same runner locally and in a manually dispatched CI workflow.
  Inject case data through a repository secret and write the input file under ignored `.misc/` for the job.
  GitHub supports passing [Actions secrets as environment variables](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).
  Never put real links or IDs in workflow defaults, command arguments, or test names.
- Resolve CIDs, titles, and other platform metadata at runtime. Assert playback, seeking, decoded-frame progress, danmaku, and session isolation by case alias.
  Do not compare exact public titles or retain raw provider responses.
- Run a real browser with the installed Tampermonkey helper and bounded request/test deadlines.
  Keep required platform access in each participant's browser; do not inject cookies, browser profiles, or signed playback URLs through CI secrets.
  Report missing input, browser access, or network prerequisites as unverified; fail an explicitly requested live run when prerequisites are absent.
- Keep screenshots and traces local unless scrubbed, because they can include real titles and resource IDs.
  Upload only a summary with case aliases and results. Keep routine PR validation independent of this live job.

## Release preparation

Use the repository's [release-pr](.agents/skills/release-pr/SKILL.md) instructions.
Version bump targets change `versions.toml` without staging, committing, or pushing.
Keep module versions independent. Publish changelog entries under date-only headings, `## [YYYY-MM-DD]`, with the newest release first.
`make release-tag` uses that newest entry's date as the annotated tag, `vYYYY-MM-DD`, and includes only that entry's notes. Tagging requires a separate request and confirmation on clean, current `main`.
