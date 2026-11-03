# Helper module

The private `@ovs/helper` pnpm package owns the instance-scoped Bilibili Tampermonkey script, bounded media delivery, bridge JSON parser, and shared video codec allowlist.

Run these commands from the repository root:

```bash
pnpm --dir modules/helper run build
pnpm --dir modules/helper run test
```

The build reads `versions.helper` from root `versions.toml`. It writes `dist/helper.user.js` and `dist/release.json`.
The script includes the bridge parser, codec allowlist, release version, and a SHA-256 build fingerprint. The frontend checks the fingerprint during handshake, including when development changes keep the same release version. Origin and match placeholders remain for the server to scope at delivery.
The package exports `@ovs/helper/bridge-json`, `@ovs/helper/media-codecs`, and `@ovs/helper/release` for the frontend.
Generated metadata is not a second version source. The bridge protocol version remains separate from the release version.

Candidate video previews use a read-only bridge operation. They return bounded metadata without taking playback ownership or creating a stream handle. Closing or rejecting a preview preserves the current player's requests and handle.
Previews and opens check exact MediaSource codec support. Select the requested playable quality or the highest playable quality, then prefer AV1, HEVC, and AVC in that order. Keep the selected video and audio representations when refreshing expired locations.

Preview and open resolve metadata through two sequential API requests within a shared 24-second helper budget. Their frontend bridge allows 30 seconds. Each network request still has a 12-second maximum. Byte operations keep their separate 12-second total budget and 15-second bridge deadline.

`media-delivery.js` keeps signed locations and one network window of at most 2 MiB per track in helper memory. Network reads respect the fragment boundary and deliver page chunks of at most 256 KiB. Retain up to three permitted provider locations, try mirrors on network failures, timeouts, HTTP 403/410, 404/408, or 5xx, and try unused mirrors on sustained insufficient delivery. Verify initialization/index bytes before continuing on another source. Try each location at most once per byte operation, permit recovered sources in later operations, and exclude mismatched sources until expiry refresh. Cancellation, denied redirects, oversized responses, and HTTP 429 stop without trying another source. Retain a usable current source if alternatives fail validation. Mirror attempts and expiry refresh share a 12-second byte-operation deadline. Exact Content-Range validation rejects shifted or incomplete responses.

Timeouts halve the read-ahead cap down to 256 KiB while retaining at least the requested bytes. Keep the smaller cap across retries and location refresh. After two consecutive full network windows each complete within one quarter of their request timeout, double the cap toward 2 MiB. The frontend retries transient media network errors, timeouts, HTTP 408, and 5xx at the same cursor up to three times with 250, 500, and 1000 ms delays. Retain appended data during recovery and cancel obsolete retries on seek or disposal.

Byte requests can include a fragment `end`, byte `rate`, and `seek` generation. The nonblocking `seek` operation cancels obsolete media reads and refresh requests without cancelling unrelated API or danmaku requests. Keep two active requests, with separate per-second bounds of 128 byte calls and 32 other calls. The helper build fingerprint includes the delivery module; install the updated helper when OVS requests an update.

`make helper-build` also copies the distribution into `modules/sync/internal/helper/dist/` for Go embedding.
The server serves the script and release metadata under the existing `/userscripts/` routes.
Install the helper from the running OVS instance so its deployment origin is correct.
For frontend hot reload, `make dev-web` serves the generated files with the exact `localhost:5173` or `127.0.0.1:5173` origin. Install from that development page and reload.
