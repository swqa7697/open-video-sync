# Repository automation

This directory owns cross-module builds, formatting, releases, deployment, and application smoke checks.
Go commands use an independent module defined by `go.mod` and `go.sum` in this directory.
The server module remains under `modules/sync/`. Neither Go module imports the other.

Use root Make targets as the common entry point:

| Command directory | Make targets                                                                              | Purpose                                                             |
| ----------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `gofmt/`          | `format`, `format-check`                                                                  | Format or check all repository Go source                            |
| `release/`        | `bump-major`, `bump-minor`, `bump-patch`, `release-commit`, `release-tag`                 | Prepare module versions and manage approved release Git actions     |
| `deploy/`         | `deploy`, `deploy-status`, `deploy-logs`, `deploy-restart`, `deploy-stop`, `deploy-smoke` | Deploy and manage the complete application through SSH              |
| `notices/`        | `build`, `image`                                                                          | Collect compiled server and frontend production dependency licenses |
| `image-smoke/`    | `image-smoke`                                                                             | Check the application image and persistence across replacement      |
| `proxy-smoke/`    | `proxy-smoke`                                                                             | Check HTTPS, proxy trust, and WebSocket reconnect through Caddy     |

Git staging, commits, and pushes require an explicit request. See [AGENTS.md](../AGENTS.md) and the [release preparation instructions](../CONTRIBUTING.md#release-preparation).

Run these commands from the repository root to validate Go automation without building frontend assets:

```bash
go -C scripts vet ./...
go -C scripts test ./...
go -C scripts test -race ./...
```

`make check`, `make test`, and `make test-race` cover both Go modules.
`make deps` downloads dependencies for both modules. `make upgrade-tools` updates only automation dependencies.

Smoke clients define the response fields they inspect under `internal/smoke/`, following [the public wire contract](../specs/WIRE.md).
Smoke clients use public HTTP and WebSocket endpoints and do not import server internal packages.
The image check also reads an isolated database copy to verify the persisted schema version.
See [deployment validation](../deploy/README.md#remote-deployment-validation) for the isolated SSH test requirements.

The notice generator accepts `-sync` to select the server module and `-frontend` to read pnpm license metadata.
Both paths are relative to the command's working directory. `go -C scripts` sets that directory to `scripts/`.
Run `make web-build` before collecting server notices because the server embeds generated frontend and helper assets:

```bash
make web-build
go -C scripts run ./notices -sync ../modules/sync
```

`scripts/build.sh` and the root Dockerfile supply both paths when they collect the complete application notices.
