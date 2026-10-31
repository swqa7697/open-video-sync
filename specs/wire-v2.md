# Version-2 application contract

This is the application protocol implemented by Stage 4a / P8a.
[DESIGN](DESIGN.md) defines memory ownership and persistence.
P8a changes the embedded frontend and backend together. Do not add parallel version-1 and version-2 room engines.
The browser-local Bilibili helper protocol and local fingerprint encoding retain their existing versions.

## Encoding and common values

Retain strict UTF-8 JSON objects, allowlisted fields, duplicate-key rejection, depth eight, and 64-KiB HTTP/frame bounds.
Use integer milliseconds and JavaScript-safe integers. Reject malformed values before effects; validation does not replace authorization.
IDs remain 128 random bits as 32 lowercase hexadecimal characters. Session and CSRF tokens remain 256 random bits in unpadded base64url.
Invitation link secrets remain 128 bits in unpadded base64url; codes remain 16 Crockford Base32 characters.
Normalize only ASCII spaces/hyphens, case, and `O→0`, `I/L→1` for codes. Use HTTP-compatible cryptographic randomness.
Keep existing name, title, descriptor, duration, and size bounds from the shared validators.

`RoomSettings` is exactly `{controllers:"host"|"everyone", waitForAll:boolean}`.
Defaults are `host` and `true`. Reject legacy settings on v2 requests rather than ignoring extra fields.
Local descriptors remain `{kind:"local",fingerprintVersion:1,digest,sizeBytes,durationMs,label?}`.
Bilibili descriptors remain `{kind:"bilibili",bvid,cid,part,durationMs}`. No URLs, files, paths, cookies, handles, or provider payloads are accepted.

Errors remain `{code,message,requestId,retryable}` with bounded safe messages.
Retain existing HTTP status mappings for invalid input, authentication, authorization, missing resource, stale state, limits, and unavailable persistence.
An old application route/protocol returns `upgrade_required` with reload guidance, without processing the old mutation.
No non-application API or socket route falls through to SPA HTML.

## HTTP

Use `/api/v2`. Health paths and the helper distribution URL do not change.
Bootstrap and authenticated mutations require the configured exact origin. Authenticated mutations also require the session-bound CSRF token.
Use the host-only HttpOnly session cookie. Keep API responses uncached. Validate expiry and authorization against application memory.

| Method and relative path                    | Input                                  | Result                                                            |
| ------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| `GET /version`                              | None                                   | Public `{sync,web,helper}` build-version strings                  |
| `POST /session`                             | `{}`                                   | `{identity:{identityId,displayName},csrfToken,expiresAtMs}`       |
| `GET /me`                                   | None                                   | Same profile/session shape                                        |
| `PATCH /me`                                 | `{displayName}`                        | Same profile/session shape                                        |
| `DELETE /session`                           | `{}`                                   | `{forgotten:true}` after persistent revocation and socket closure |
| `GET /rooms`                                | Optional existing `cursor` and `limit` | `{rooms:[{roomId,title,role}],nextCursor}` from memory            |
| `POST /rooms`                               | `{title,settings,media}`               | `{snapshot,invitation,replayed}`                                  |
| `POST /invitations/redeem`                  | Exactly `{linkSecret}` or `{code}`     | `{snapshot,replayed}`                                             |
| `GET /rooms/{roomId}`                       | None                                   | Authorized snapshot from memory                                   |
| `PATCH /rooms/{roomId}/settings`            | `{epoch,expectedRevision,settings}`    | `{snapshot}`                                                      |
| `GET /rooms/{roomId}/invitations`           | None                                   | `{invitation}`; host only                                         |
| `POST /rooms/{roomId}/invitations`          | `{epoch,expectedRevision}`             | `{snapshot,invitation}`; host-only reset                          |
| `DELETE /rooms/{roomId}/members/{memberId}` | `{epoch,expectedRevision}`             | `{roomId,revision,removedMemberId}`                               |
| `POST /rooms/{roomId}/leave`                | `{epoch,expectedRevision}`             | Committed departure receipt; host membership retained for return  |
| `DELETE /rooms/{roomId}`                    | `{epoch,expectedRevision}`             | `{roomId,revision,closed:true}`                                   |

`GET /version` needs no session and performs no storage access. Return the running binary's build version and the release versions of its embedded frontend and helper. Keep this metadata uncached; it does not report the helper installed in the browser.

`Invitation` is `{linkSecret,code}`. It has no expiry. GET reuses the current invitation without rotating it.
While the room remains open, joining, failed joins, helper installation, reloads, leaving, sharing, removal, and elapsed time preserve the current invitation. Only an explicit host reset or room closure invalidates it. The current host can redeem the current invitation without changing membership. Empty rooms still close after the normal departure grace.
No snapshot, list, or non-host response contains invitation secrets.

Existing-room mutations use current runtime epoch/revision, even when their persistent fields are stored in SQLite.
Commit persistent changes first, then install memory state and increment runtime revision before acknowledging success.
Read-only room requests do not update activity timestamps or run SQLite transactions.

Creation and redemption retain client-generated `Idempotency-Key` headers, with bounded in-memory receipts only.
Retain at most 256 receipts per identity and 4,096 per process for 60 seconds. Check authorization before returning a stored result.
Retain request digests and resource IDs, not copies of secret-bearing requests. Reject changed input under the same retained key.
A create replay returns the current authorized snapshot and host invitation; a redeem replay requires current membership.
Receipt eviction or process restart removes the recovery guarantee. A create retry sends `Idempotency-Replay-Only: true`;
the server returns a retained result or `request_outcome_unknown` without creating another room.
The cryptographically random creation key is also the room ID. Compute the existing room-specific fingerprint before creation. Persist the initial media in the creation transaction.
After an uncertain expired create request, GET that known room ID to recover an authorized result. If unavailable, require explicit new intent; never depend on a room list.
Do not automatically create a second room to resolve an unknown outcome. Redemption of an existing membership remains naturally idempotent.

## Room snapshots

Use the following exact shape. `ID` denotes the common ID format; nullable fields explicitly use null.

```text
{
  roomId, title, epoch, revision, mediaGeneration, hostMemberId, selfMemberId,
  settings: RoomSettings,
  media: MediaDescriptor | null,
  playback: {
    phase: "empty" | "paused" | "waiting" | "playing" | "ended",
    positionMs, anchorServerMs, desiredPlaying: boolean
  },
  barrier: {
    barrierId, requiredMemberIds: ID[], reason: "play" | "buffering",
    targetPositionMs, deadlineServerMs
  } | null,
  members: [{
    memberId, displayName, role: "host" | "participant",
    presence: "offline" | "connected",
    readiness: Readiness | null
  }],
  serverNowMs
}
```

Revision is an in-memory counter, starting at 1 for each new epoch.
Media generation starts at 0 without media or 1 with restored selected media, and advances on replacement within that epoch.
Do not compare these counters across epochs or store them in SQLite.
Only `playing` advances the timeline. Only `waiting` has a barrier. Restart has position zero, no barrier, and no desired play.
A loaded descriptor restarts paused; absent media restarts empty. Base playback rate is always 1.0 and needs no wire field.
Only ready local players apply a playing timeline. A late joiner loads, permits playback, and catches up without enlarging an existing barrier.

`Readiness` is `{status,mediaGeneration,barrierId,sampledAtClientMs,positionMs,durationMs,capabilities}`.
Keep statuses `no_media`, `loading`, `ready`, `buffering`, `gesture_required`, `mismatch`, `access_denied`, `unsupported`, `error`.
Position, duration, and barrier ID may be null. Null readiness is not implicit readiness.
Capabilities retain the existing booleans for play, pause, seek, position, rate, buffering, and danmaku, plus bounded `positionResolutionMs`.
Readiness requires matching media and a real playable position within the existing 250-ms tolerance. Stale media/barrier reports have no effects.
Send readiness changes and current-barrier confirmations; do not send a separate diagnostic observation stream.

## WebSocket

Use `/ws/v2/rooms/{roomId}` with cookie, exact Origin, membership, and resource checks before admission.
Clock/heartbeat traffic and real-time commands never query SQLite.
The latest authenticated connection owns playback for its membership. Replacement closes the older connection and invalidates all its pending work.
There is no `member.activate` operation. The replaced page pauses and does not reconnect until explicitly reloaded or reopened.

Mutation envelopes are `{v:2,type,commandId,epoch,mediaGeneration,expectedRevision,payload}`:

- `playback.command`: `{action:"play"|"pause"|"replay"}` or `{action:"seek",positionMs}`. Memory-only.
- `media.select`: `{media:MediaDescriptor}`. Host only; persist the descriptor, then reset runtime playback and advance media generation.

Readiness uses `{v:2,type:"member.readiness",epoch,payload:Readiness}`.
Clock and heartbeat use `{v:2,type,requestId,payload}` with the existing four timestamps and heartbeat reply flag.
Remove `waiting.exclude` and `member.observation`. No frame can override its authenticated room, identity, or connection.

Server room envelopes remain `{v:2,type,epoch,eventSeq,payload}`. Sequence is per connection, starts at 1, and is never persisted.

| Type               | Payload                                                                            |
| ------------------ | ---------------------------------------------------------------------------------- |
| `session.welcome`  | `{connectionId,snapshot}`                                                          |
| `room.snapshot`    | Full authorized snapshot                                                           |
| `command.result`   | `{commandId,accepted,revision,error}`; rejected revision or accepted error is null |
| `room.closed`      | `{roomId,revision}`                                                                |
| `session.replaced` | `{reason:"connection_replaced"                                                     | "session_revoked"}` |
| `server.stopping`  | `{reason:"shutdown"}`                                                              |
| `error`            | Safe public error                                                                  |

Use full snapshots after meaningful changes; coalesce replaceable queued snapshots before assigning event sequence numbers.
Do not publish a snapshot merely because a timer fired. Preserve results and lifecycle messages; disconnect slow clients instead of blocking the room.
An unexpected sequence gap causes a fresh connection/snapshot, not event-log replay.

For command retry, check current in-memory authorization/connection and epoch, then recent ID/input, then expected revision/media generation.
A duplicate retained result returns its accepted revision without reapplying the operation. Changed input under that ID is invalid.
Use a canonical allowlisted operation digest; never retain raw provider objects or credentials. Exact digest encoding is an internal implementation detail, not a cross-language wire API.
Room receipts are bounded to 256 entries for 60 seconds. An evicted accepted command fails its stale revision; reconcile without automatic replay.
No receipts, runtime counters, waiting state, or playback positions survive restart.

## P8a compatibility work

Shared v2 fixtures verify the current settings and metadata boundaries. Fingerprint version-1 vectors remain unchanged.
The obsolete v1 application reference and fixtures are retired.
Preserve the existing session cookie so identity and membership survive the upgrade.
Legacy hash-only invitations keep their existing verification until host replacement; historical expiry is ignored. A host GET for such a record returns `invitation_reset_required` (409), prompting an explicit reset; no unknown secret is reconstructed. This is a development-only migration path.
Use a new recorded schema migration; preserve persistent data and explicitly discard only retired runtime records and settings.
Update frontend retry, sharing, settings, and tab-replacement behavior with the server. No mixed-version playback fallback is required.
