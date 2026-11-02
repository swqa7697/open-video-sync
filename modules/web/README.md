# Web module

The private `@ovs/web` pnpm package owns the Vue interface, browser player adapters, and synchronization engine.
Vue I18n owns interface translation. `src/i18n/en.json` defines the message schema; `zh-CN.json` must contain the same keys.
Use `t` when rendering and keep `Message` descriptors for stored status, errors, and notices so language switches update existing text.
Keep user names, room titles, video titles, and danmaku as text without translation. Use named parameters instead of sentence fragments.
The language store resolves the first browser language, follows `languagechange` in system mode, and saves only an allowlisted preference in `ovs.language`.
English is the fallback. Blocked storage still allows language changes until reload. Browser journeys cover both supported languages.
`HomeIntro.vue` randomly selects one of five localized headings on each home visit, using neutral greetings and short feature introductions. The choice stays in component memory through form edits and language changes, without timers or browser storage.
The package declares a local link to `../helper` and consumes the helper's public bridge parser, video codec allowlist, and generated release metadata through `@ovs/helper` exports.

Run these commands from the repository root:

```bash
pnpm --dir modules/web install --frozen-lockfile
pnpm --dir modules/helper run build
pnpm --dir modules/web run dev
pnpm --dir modules/web run typecheck
pnpm --dir modules/web run test
pnpm --dir modules/web run build
```

The frontend build writes `dist/`. Root `versions.toml` supplies `versions.web`, included in the built HTML metadata and `dist/release.json`.
The header settings menu groups appearance, language, and About. Appearance defaults to dark and changes only through a local choice.
About reads `/api/v2/version` for the running service and its embedded frontend and helper versions, independent of the installed browser helper.
The development server proxies API, health, and WebSocket routes to the Go server. Start that server with `make dev`.
Use `make dev-web` to build and serve the helper locally for `http://127.0.0.1:5173` or `http://localhost:5173`. Install from the development page and reload; each helper activates only on its exact origin.
Production browser journeys remain under root `tests/e2e/` because they exercise all three modules.
Use `make web-build` to copy generated assets for Go embedding, or `make build` for the complete application.
