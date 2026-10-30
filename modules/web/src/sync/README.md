# Synchronization boundary

`clock.ts` owns bounded four-timestamp estimation and uncertainty. `controller.ts` projects the server timeline and applies drift correction.
`PlayerPanel` owns its sampling timer and cancels the controller when media, adapter, visibility, or connection ownership changes.
OVS controls express intent directly; programmatic media events only trigger reconciliation and readiness, so they cannot create command feedback.
Native shared controls are hidden. Local mute and volume do not enter room messages.
Engine tests use controlled timestamps and adapters. Browser tests independently read synthetic source-frame pixels.
The server owns frozen readiness cohorts, buffering waits, ready late joining, and fixed deadlines in memory.
The controller applies a playing timeline only when the local player is ready. Barrier readiness also checks browser autoplay permission and playable media state.
Cross-region and physical-display acceptance remain unverified.
