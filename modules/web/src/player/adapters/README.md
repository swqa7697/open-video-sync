# Player adapters

`local.ts` owns the video element binding, object URL, listeners, cancellation, observations, and disposal.
`PlayerAdapter` declares mandatory controls and optional rate/buffering capabilities. Files never enter a room serializer or serializable store.
The worker hashes at most three 1-MiB samples using the exact room-specific v1 encoding and incremental SHA-256.
A disposed adapter cannot publish readiness or resume a newer player. Browser reload requires file reselection.
B0 has validated a separate Tampermonkey-assisted MediaSource prototype with danmaku and independent platform sessions on desktop Chromium and Firefox. See DESIGN §8 for the accepted interfaces and bounds.

`../bilibili/adapter.ts` implements the production Bilibili adapter with the same native observations and room synchronization controls. It owns bounded SIDX/MediaSource delivery, per-player helper channels, request cancellation, source buffers, and danmaku disposal.
The backend `modules/sync/internal/helper` package keeps provider responses and signed locations in helper memory. The room receives only stable matching metadata. Local volume, mute, and danmaku settings stay outside shared state.

The helper exposes actual AVC track quality IDs. Initial loading selects the highest playable tier unless a browser-local quality preference is available. An unavailable preferred tier falls back to the highest playable tier without erasing that preference. Selecting a quality disposes the previous adapter, opens a new player channel, and reports readiness before converging to room playback.
SIDX direct references use their full 31-bit size. The adapter reads and appends chunks of at most 256 KiB without assembling whole fragments, including references above 64 MiB.
Audio/video work alternates within bounded passes. Each track owns one cursor and at most one pending chunk. SIDX byte rates estimate 32 MiB video / 4 MiB audio budgets with 1–12 seconds ahead and bounded history.
Browser quota pressure triggers eviction and one retry, then holds the same chunk while playback can free space. No playable headroom means a bounded playback failure.
Seeks reset incomplete parsers and discard late replies. Browser memory and codec limits still apply; the byte budgets estimate compressed buffering rather than actual allocations.
Root `versions.toml` supplies the helper release version; `modules/helper/dist/release.json` is generated metadata for script delivery, handshake validation, and onboarding. The protocol version remains separate.
Live quality-switching evidence is required beyond the historical B0 fixed-quality baseline.
