# Sync module

The Go module owns the OVS server, SQLite persistence, and HTTP and WebSocket transports.
`sql/schema.sql` always defines the complete, current database schema; `sql/embed.go` embeds that definition.
`sql/migrations/` records changes between versions for historical reference only and is not executed at startup.
Root `deploy/` contains application deployment examples.
Root [Dockerfile](../../Dockerfile) and `.dockerignore` build and bundle all three modules using the repository root as their context.

Run these commands from the repository root:

```bash
make web-build
go -C modules/sync test ./...
go -C modules/sync test -race ./...
make build
```

`make web-build` copies generated frontend and helper distributions into the server's embedding packages.
`make build` writes the binary and dependency notices under `modules/sync/build/`.
Root `versions.toml` supplies the server version through `versions.sync`.
The independent [scripts Go module](../../scripts/README.md) owns repository automation, including deployment and release commands.
Use root Make targets to run these commands and validate both Go modules.
See the [project README](../../README.md) and [deployment guide](../../deploy/README.md).
