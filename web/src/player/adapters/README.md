# Player adapters

`local.ts` owns the video element binding, object URL, listeners, cancellation, observations, and disposal.
`PlayerAdapter` declares mandatory controls and optional rate/buffering capabilities. Files never enter a room serializer or serializable store.
The worker hashes at most three 1-MiB samples using the exact room-specific v1 encoding and pinned incremental SHA-256.
A disposed adapter cannot publish readiness or resume a newer player. Browser reload requires file reselection.
Finalize Bilibili only after the separate proof of concept passes, including danmaku and independent platform sessions.
