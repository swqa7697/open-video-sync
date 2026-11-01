# Application protocol

This document defines the initial release's HTTP and WebSocket contracts.
[DESIGN](DESIGN.md) defines memory ownership and persistence. Serve the matching frontend and backend together.
The application protocol identifier is 2. The browser-local helper protocol and local fingerprint encoding each use identifier 1.
These identifiers describe independent encodings, not published application releases.

## Encoding and common values

Use strict UTF-8 JSON objects, allowlisted fields, duplicate-key rejection, depth eight, and 64-KiB HTTP/frame bounds.
Use integer milliseconds and JavaScript-safe integers. Reject malformed values before effects; validation does not replace authorization.
IDs use 128 random bits as 32 lowercase hexadecimal characters. Session and CSRF tokens use 256 random bits in unpadded base64url.
Invitation link secrets use 128 bits in unpadded base64url; codes use 16 Crockford Base32 characters.
Normalize only ASCII spaces/hyphens, case, and `O→0`, `I/L→1` for codes. Use HTTP-compatible cryptographic randomness.
Display names allow up to 48 Unicode scalar values and 192 UTF-8 bytes. Titles require 1–120 scalar values and at most 480 UTF-8 bytes.
Durations range from 1 ms to seven days. Local file sizes range from 1 byte to 16 TiB. Shared validators enforce descriptor fields and bounds.

`RoomSettings` is exactly `{controllers:"host"|"everyone", waitForAll:boolean}`.
Defaults are `host` and `true`. Reject unknown settings fields.
Local descriptors are `{kind:"local",fingerprintVersion:1,digest,sizeBytes,durationMs,label?}`.
Bilibili descriptors are `{kind:"bilibili",bvid,cid,part,durationMs}`. No URLs, files, paths, cookies, handles, or provider payloads are accepted.

Errors are `{code,message,requestId,retryable}` with bounded safe messages.
Use HTTP 400 for invalid input, 401 for authentication, 403 for authorization, 404 for missing resources, 409 for conflicts, 413 for oversized bodies, 415 for unsupported content types, 429 for rate or capacity limits, and 503 for unavailable persistence or a busy server.
An unsupported application protocol returns `upgrade_required` with reload guidance without processing the mutation.
No non-application API or socket route falls through to SPA HTML.

## HTTP

Use `/api/v2`, health endpoints under `/health`, and the helper distribution URL `/userscripts/ovs-bilibili.user.js`.
Bootstrap and authenticated mutations require the configured exact origin. Authenticated mutations also require the session-bound CSRF token.
Use the host-only HttpOnly session cookie. Keep API responses uncached. Validate expiry and authorization against application memory.

| Method and relative path                    | Input                               | Result                                                            |
| ------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------- |
| `GET /version`                              | None                                | Public `{sync,web,helper,commit,dirty,tag}` build metadata        |
| `POST /session`                             | `{}`                                | `{identity:{identityId,displayName},csrfToken,expiresAtMs}`       |
| `GET /me`                                   | None                                | Same profile/session shape                                        |
| `PATCH /me`                                 | `{displayName}`                     | Same profile/session shape                                        |
| `DELETE /session`                           | `{}`                                | `{forgotten:true}` after persistent revocation and socket closure |
| `GET /rooms`                                | Optional `cursor` and `limit`       | `{rooms:[{roomId,title,role}],nextCursor}` from memory            |
| `POST /rooms`                               | `{title,settings,media}`            | `{snapshot,invitation,replayed}`                                  |
| `POST /invitations/redeem`                  | Exactly `{linkSecret}` or `{code}`  | `{snapshot,replayed}`                                             |
| `GET /rooms/{roomId}`                       | None                                | Authorized snapshot from memory                                   |
| `PATCH /rooms/{roomId}/settings`            | `{epoch,expectedRevision,settings}` | `{snapshot}`                                                      |
| `GET /rooms/{roomId}/invitations`           | None                                | `{invitation}`; host only                                         |
| `POST /rooms/{roomId}/invitations`          | `{epoch,expectedRevision}`          | `{snapshot,invitation}`; host-only reset                          |
| `DELETE /rooms/{roomId}/members/{memberId}` | `{epoch,expectedRevision}`          | `{roomId,revision,removedMemberId}`                               |
| `POST /rooms/{roomId}/leave`                | `{epoch,expectedRevision}`          | Committed departure receipt; host membership retained for return  |
| `DELETE /rooms/{roomId}`                    | `{epoch,expectedRevision}`          | `{roomId,revision,closed:true}`                                   |

`GET /version` needs no session and performs no storage access. Return the running binary's build version and the release versions of its embedded frontend and helper. Keep this metadata uncached; it does not report the helper installed in the browser.

`Invitation` is `{linkSecret,code}`. It has no expiry. GET reuses the current invitation without rotating it.
While the room remains open, joining, failed joins, helper installation, reloads, leaving, sharing, removal, and elapsed time preserve the current invitation. Only an explicit host reset or room closure invalidates it. The current host can redeem the current invitation without changing membership. Empty rooms still close after the normal departure grace.
No snapshot, list, or non-host response contains invitation secrets.

Existing-room mutations use current runtime epoch/revision, even when their persistent fields are stored in SQLite.
Commit persistent changes first, then install memory state and increment runtime revision before acknowledging success.
Read-only room requests do not update activity timestamps or run SQLite transactions.

Creation and redemption use client-generated `Idempotency-Key` headers, with bounded in-memory receipts only.
Retain at most 256 receipts per identity and 4,096 per process for 60 seconds. Check authorization before returning a stored result.
Retain request digests and resource IDs, not copies of secret-bearing requests. Reject changed input under the same retained key.
A create replay returns the current authorized snapshot and host invitation; a redeem replay requires current membership.
Receipt eviction or process restart removes the recovery guarantee. A create retry sends `Idempotency-Replay-Only: true`;
the server returns a retained result or `request_outcome_unknown` without creating another room.
The cryptographically random creation key is also the room ID. Compute the room-specific fingerprint before creation. Persist the initial media in the creation transaction.
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
Capabilities include booleans for play, pause, seek, position, rate, buffering, and danmaku, plus bounded `positionResolutionMs`.
Readiness requires matching media and a real playable position within a 250-ms tolerance. Stale media/barrier reports have no effects.
Send readiness changes and current-barrier confirmations; do not send a separate diagnostic observation stream.

## WebSocket

Use `/ws/v2/rooms/{roomId}` with cookie, exact Origin, membership, and resource checks before admission.
Clock/heartbeat traffic and real-time commands never query SQLite.
The latest authenticated connection owns playback for its membership. Replacement closes the older connection and invalidates all its pending work.
The replaced page pauses and does not reconnect until explicitly reloaded or reopened.

Mutation envelopes are `{v:2,type,commandId,epoch,mediaGeneration,expectedRevision,payload}`:

- `playback.command`: `{action:"play"|"pause"|"replay"}` or `{action:"seek",positionMs}`. Memory-only.
- `media.select`: `{media:MediaDescriptor}`. Host only; persist the descriptor, then reset runtime playback and advance media generation.

Readiness uses `{v:2,type:"member.readiness",epoch,payload:Readiness}`.
Clock and heartbeat use `{v:2,type,requestId,payload}` with a four-timestamp clock exchange and heartbeat reply flag.
Reject unsupported message types. No frame can override its authenticated room, identity, or connection.

Server room envelopes are `{v:2,type,epoch,eventSeq,payload}`. Sequence is per connection, starts at 1, and is never persisted.

| Type               | Payload                                                                            |
| ------------------ | ---------------------------------------------------------------------------------- |
| `session.welcome`  | `{connectionId,snapshot}`                                                          |
| `room.snapshot`    | Full authorized snapshot                                                           |
| `command.result`   | `{commandId,accepted,revision,error}`; rejected revision or accepted error is null |
| `room.closed`      | `{roomId,revision}`                                                                |
| `session.replaced` | `{reason:"connection_replaced"\|"session_revoked"}`                                |
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
