# Helper module

The private `@ovs/helper` pnpm package owns the instance-scoped Bilibili Tampermonkey script and its bridge JSON parser.

Run these commands from the repository root:

```bash
pnpm --dir modules/helper run build
pnpm --dir modules/helper run test
```

The build reads `versions.helper` from root `versions.toml`. It writes `dist/helper.user.js` and `dist/release.json`.
The script includes the bridge parser and release version. Origin and match placeholders remain for the server to scope at delivery.
The package exports `@ovs/helper/bridge-json` and `@ovs/helper/release` for the frontend.
Generated metadata is not a second version source. The bridge protocol version remains separate from the release version.

`make helper-build` also copies the distribution into `modules/sync/internal/helper/dist/` for Go embedding.
The server serves the script and release metadata under the existing `/userscripts/` routes.
Install the helper from the running OVS instance so its deployment origin is correct.
