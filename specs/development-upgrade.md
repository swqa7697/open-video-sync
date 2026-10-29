# Development schema upgrade

This transition applies to development installations with application protocol v1 and schema migrations 0001–0005.
It is separate from release notes because those versions were not published releases.

Stop OVS and copy the entire data directory, including SQLite sidecars, before upgrading. Preserve ownership and file modes.
Start the new binary against the same `/data`. Migration 0006 runs transactionally; do not edit earlier migrations or reset the database.
The process rejects migration errors and unknown newer schemas. To recover from an upgrade failure, fix the cause before restarting.

Identity/session cookies, display names, rooms, hosts, memberships, and allowlisted selected media survive.
Controller permission is preserved. Old `waitMode=all` becomes `waitForAll=true`; other retired preferences are discarded.
Playback checkpoints, command receipts, retry results, activity fields, and runtime counters are removed.
Playback restarts paused at zero. Reload old browser pages to use protocol v2. Helper protocol 1 and local fingerprints are unchanged.

Old invitations contain hashes only. Their original validity and expiry remain until the host explicitly replaces them.
Sharing an old invitation returns `invitation_reset_required`; the room shows a replacement prompt.
Rooms whose expired invitation rows were already removed also remain accessible and require explicit replacement.
Select **Replace invitation** to create recoverable values without expiry. Old links/codes then stop working.
The upgrade does not silently rotate invitations. New installations never need this transition.

Invitation values are now recoverable in private storage for repeated host sharing. Protect `/data` as credential-bearing storage.
Session bearer tokens remain hash-only. OVS provides no automatic downgrade or online database recovery.
