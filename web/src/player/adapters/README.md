# Player adapters

`local.ts` owns the video element binding, object URL, listeners, cancellation, observations, and disposal.
`PlayerAdapter` declares mandatory controls and optional rate/buffering capabilities. Files never enter a room serializer or serializable store.
The worker hashes at most three 1-MiB samples using the exact room-specific v1 encoding and pinned incremental SHA-256.
A disposed adapter cannot publish readiness or resume a newer player. Browser reload requires file reselection.
B0 has validated a separate Tampermonkey-assisted MediaSource prototype with danmaku and independent platform sessions on desktop Chromium and Firefox. See DESIGN §8 for the accepted interfaces and bounds.

`../bilibili/adapter.ts` implements the production Bilibili adapter with the same native observations and room synchronization controls. It owns bounded SIDX/MediaSource delivery, per-player helper channels, request cancellation, source buffers, and danmaku disposal.
The embedded `userscripts/` package keeps provider responses and signed locations in helper memory. The room receives only stable matching metadata. Local volume, mute, and danmaku settings stay outside shared state.
