# Synchronization boundary

`clock.ts` owns bounded four-timestamp estimation and uncertainty. `controller.ts` projects the server timeline and applies drift correction.
`PlayerPanel` owns its sampling timer and cancels the controller when media, adapter, visibility, or connection ownership changes.
OVS controls express intent directly; programmatic media events only trigger reconciliation and readiness, so they cannot create command feedback.
Native shared controls are hidden. Local mute and volume do not enter room messages.
Engine tests use controlled timestamps and adapters. Browser tests independently read synthetic source-frame pixels.
Full waiting and buffering policies remain Stage 3. Cross-region and physical-display acceptance remain unverified.
