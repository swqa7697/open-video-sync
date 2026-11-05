# Synchronization boundary

`clock.ts` owns bounded four-timestamp estimation and uncertainty. `controller.ts` projects the server timeline and applies drift correction.
The room timeline carries a shared base playback rate from 0.5× to 2× in 0.25× steps. Rate changes retain playback position and play intent. Drift correction temporarily scales this rate by 0.95–1.05 and restores the base rate when settled. Paused and waiting players retain the selected rate. Adapters without rate control use seek correction at 1× and pause with unsupported readiness at other rates.
`PlayerPanel` owns its sampling timer and cancels the controller when media, adapter, or connection ownership changes. Page visibility does not pause playback or disable synchronization. Returning to the foreground requests clock calibration while retaining any usable estimate.
OVS controls express intent directly; programmatic media events only trigger reconciliation and readiness, so they cannot create command feedback.
Native shared controls are hidden. Local mute and volume do not enter room messages.
Engine tests use controlled timestamps and adapters. Browser tests independently read synthetic source-frame pixels.
The server owns frozen readiness cohorts, buffering waits, ready late joining, and fixed deadlines in memory.
The controller applies a playing timeline only when the local player is ready. Barrier readiness also checks browser autoplay permission and playable media state.
Cross-region and physical-display acceptance remain unverified.
