# Web module

The private `@ovs/web` pnpm package owns the Vue interface, browser player adapters, and synchronization engine.
The package declares a local link to `../helper` and consumes the helper's public bridge parser and generated release metadata through `@ovs/helper` exports.

Run these commands from the repository root:

```bash
pnpm --dir modules/web install --frozen-lockfile
pnpm --dir modules/helper run build
pnpm --dir modules/web run dev
pnpm --dir modules/web run typecheck
pnpm --dir modules/web run test
pnpm --dir modules/web run build
```

The frontend build writes `dist/`. Root `versions.toml` supplies `versions.web`, included in the built HTML metadata.
The development server proxies API, health, WebSocket, and helper routes to the Go server. Start that server with `make dev`.
Production browser journeys remain under root `tests/e2e/` because they exercise all three modules.
Use `make web-build` to copy generated assets for Go embedding, or `make build` for the complete application.
