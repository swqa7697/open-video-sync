# Version-1 implementation contracts

This document resolves P0 decisions in [DESIGN](DESIGN.md). The PRD remains the product source of truth.
Identity and room-management HTTP routes are implemented, with shared value validation in Go and TypeScript.
P1/P2 implement identity, membership, invitations, and bounded writes. P3–P5 implement snapshots, authenticated commands, local matching, and clock-based playback. Complete waiting policies remain P6.
The Bilibili descriptor remains provisional until B0 confirms identifiers and duration behavior. Syntax validation proves neither access nor player compatibility.

## Encoding and bounds

Use UTF-8 JSON objects with exact, case-sensitive fields. Reject unknown fields, missing required fields, duplicate keys at every depth, and trailing data.
Reject invalid UTF-8 and unpaired UTF-16 surrogate escapes. Count text limits in Unicode scalar values and UTF-8 bytes.
Do not trim or normalize display names, titles, or labels. Reject control characters U+0000–001F and U+007F–009F. Render text without HTML interpretation.
An empty display name clears the name. An empty label equals an omitted label. Other fields cannot be null unless specified below.

HTTP mutations require `application/json`, optionally with `charset=utf-8`. Bound reads before allocation. HTTP bodies and text frames have a 65,536-byte maximum.
Maximum container depth is eight, including the root. Reject binary WS frames and disable compression.
Wire integers use decimal integer literals without fractions or exponents. Each number must satisfy its field bounds and JavaScript's safe integer range.
TypeScript validators accept decoded values; receiving transports own raw-message limits and duplicate-key detection. Serializers emit integer literals.

`internal/contracts.DecodeObject` checks JSON structure. Specific decoders check allowlisted fields and values. They do not authorize actions.
TypeScript decoders return new allowlisted objects. Never serialize original input or arbitrary provider/player objects.
Both native suites consume [shared valid and invalid fixtures](fixtures/wire-v1.json).

| Value | Representation / inclusive bound | Owner |
| --- | --- | --- |
| Identity, room, member, epoch, connection, barrier, request IDs | 128 random bits as 32 lowercase hexadecimal characters | Server |
| Command and HTTP idempotency IDs | Same 128-bit format, from `crypto.getRandomValues` | Client |
| Session / CSRF tokens | Independent 256 random bits, unpadded base64url, 43 characters | P1 |
| Invitation link secret | 128 random bits, unpadded base64url, 22 characters | P2 |
| Invitation code | 16 independent Crockford Base32 characters | P2 |
| Display name | 0–48 scalar values, at most 192 bytes | P1; validator present |
| Room title | 1–120 scalar values, at most 480 bytes; require a non-whitespace character | P2 |
| Optional media label | 0–120 scalar values, at most 480 bytes; entered by host | P4; validator present |
| Duration | 1–604,800,000 integer milliseconds, seven days | P3/P4; validator present |
| Position | 0–selected duration; reject rather than clamp incoming commands | P3 |
| Local size | 1–17,592,186,044,416 bytes, 16 TiB; metadata only | P4; validator present |
| Local digest | Exactly 64 lowercase hexadecimal SHA-256 characters | P4; validator present |
| Bilibili `bvid` | `BV` plus ten Base58 characters: `1-9A-HJ-NP-Za-km-z` | B0/P8; provisional validator present |
| Bilibili `cid` | Decimal **string**, 1–20 digits, first digit nonzero | B0/P8; provisional validator present |
| Bilibili part | Integer 1–10,000 | B0/P8; provisional validator present |
| Revision / media generation | 0–9,007,199,254,740,991; initial revision 1, media generation 0 | P2/P3 |
| Monotonic timestamp | Nonnegative safe integer milliseconds since process/client start; never compare epochs | P3/P5 |
| Expiry timestamp | Nonnegative safe integer Unix milliseconds, named `expiresAtMs` | P1/P2 |

Code normalization removes only ASCII spaces and hyphens, folds ASCII lowercase, and maps `O→0`, `I/L→1`.
Then require exactly 16 characters from `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Do not remove other whitespace or punctuation. Hash the canonical code.
Reject noncanonical base64url secrets, including padding or nonzero unused bits. Hash decoded secret bytes.
Browser randomness must work on HTTP; do not require `crypto.randomUUID` or `SubtleCrypto`.

## HTTP requests, responses, and errors

HTTP versioning comes from `/api/v1`; bodies have no `v` property. API responses use JSON and `Cache-Control: no-store`.
Health endpoints retain their existing empty 204 responses. All shapes below are exact; optional fields are explicitly marked.

`POST /session` takes `{}`. `GET /me` has no body. Both return:

```json
{
  "identity": { "identityId": "00112233445566778899aabbccddeeff", "displayName": "Guest" },
  "csrfToken": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "expiresAtMs": 1824681600000
}
```

Tokens and IDs in examples are synthetic. `PATCH /me` takes `{displayName}` and returns the same response shape.
`DELETE /session` takes `{}` and returns `{forgotten:true}` after revocation. The bearer token appears only in the HttpOnly cookie.
Keep CSRF in frontend memory; send it through `X-OVS-CSRF` on authenticated HTTP mutations. Never persist it in frontend storage.
Require exact configured Origin for bootstrap and authenticated mutations. Bootstrap also needs address-based rate limiting.
P1 implements cookie expiry, daily renewal, CSRF comparison, and revocation. Value validation alone does not implement those features.

| Endpoint under `/api/v1` | Exact body / query | Successful response |
| --- | --- | --- |
| `GET /rooms` | Optional `cursor` and `limit`; no body | `{rooms:RoomSummary[], nextCursor:string\|null}` |
| `POST /rooms` | `{title,settings}` | `{snapshot,invitation:Invitation\|null,replayed}` |
| `POST /invitations/redeem` | Exactly `{linkSecret}` or `{code}` | `{snapshot,replayed}` |
| `GET /rooms/{roomId}` | No body | `RoomSnapshot` |
| `PATCH /rooms/{roomId}/settings` | `{epoch,expectedRevision,settings}`; full settings replacement | `{snapshot}` |
| `POST /rooms/{roomId}/invitations` | `{epoch,expectedRevision}` | `{snapshot,invitation}` |
| `DELETE /rooms/{roomId}/members/{memberId}` | `{epoch,expectedRevision}` | `{roomId,revision,removedMemberId}` |
| `DELETE /rooms/{roomId}` | `{epoch,expectedRevision}` | `{roomId,revision,closed:true}` |

`RoomSummary` is `{roomId,title,role,revision,lastActiveAtMs}`. Roles are `host` or `participant`.
List only the caller's memberships, ordered by room ID. Default page size is 20; maximum is 100.
The cursor is the last returned room ID, validated as an ID; it grants no access. Return null at the end.
`Invitation` is `{linkSecret,code,generation,expiresAtMs}`. Output codes are canonical, ungrouped strings; UI groups them for display.
Invitations never appear in snapshots, lists, logs, or stored plaintext. Build sharing links from the configured public origin.

Every existing-room mutation enters the coordinator. Validate current membership/authority before exposing revision or epoch conflicts.
Require current epoch and expected revision for settings, invitation rotation, removal/self-leave, and closure.
Each accepted mutation increments revision once, commits before publication, and returns the committed revision.
Stale requests receive `stale_state`; fetch a new authorized snapshot and require new user intent.
Closure and self-leave return receipts because snapshot access has ended. Never acknowledge an uncommitted receipt.
Snapshots come from activated coordinators. Listing does not activate all rooms. Activation changes epoch, not durable revision.

Create and redeem require an `Idempotency-Key` header in the client ID format. Neither takes expected revision or epoch.
Scope keys to identity and operation. Retain a request digest and nonsecret room outcome for 24 hours, transactionally with the mutation.
Check current session and relevant resource/membership authority before returning stored outcomes. Retrying cannot recreate a closed/deleted room.
Same key with a different normalized request returns `idempotency_conflict`. Existing-member redemption creates no additional membership or revision.
A create retry returns the current authorized snapshot, `invitation:null`, and `replayed:true`. Recover secrets through explicit host rotation.
Redeem retries return a current snapshot with `replayed:true`. Recorded membership permits recovery after invitation expiry/rotation; removal ends that recovery path.
New redemption attempts use uniform `invalid_invitation` errors for unknown, expired, revoked, and closed-room invitations.

Errors have exactly `{code,message,requestId,retryable}`. For example:

```json
{
  "code": "invalid_input",
  "message": "Invalid request.",
  "requestId": "00112233445566778899aabbccddeeff",
  "retryable": false
}
```

Generate request IDs server-side. Do not echo arbitrary headers. Use bounded static messages without provider/input data or validation details.

| Code | HTTP status | Retryable |
| --- | --- | --- |
| `invalid_input`, `invalid_command` | 400 | false |
| `session_required` | 401 | false |
| `forbidden` | 403 | false |
| `not_found`, `invalid_invitation` | 404 | false |
| `stale_state`, `idempotency_conflict` | 409 | false |
| `message_too_large` | 413 | false |
| `unsupported_content_type` | 415 | false |
| `rate_limited`, `capacity_reached` | 429 | true |
| `busy`, `storage_unavailable` | 503 | true |
| `upgrade_required` | 400; WS protocol rejection after upgrade when necessary | false |

`retryable` does not authorize replaying playback intent. Uncertain outcomes retain their original idempotency/command identity and rules.

## Settings and descriptors

Settings contain exactly the eight fields in DESIGN §5.2. Send every field. Defaults apply only when constructing a new object:

```json
{
  "controllers": "host",
  "syncMode": "adaptive",
  "waitMode": "all",
  "waitOnBuffering": true,
  "waitTimeoutMs": 30000,
  "lateJoin": "catch_up",
  "softDriftMs": 100,
  "hardDriftMs": 750
}
```

Preserve `waitOnBuffering` with `waitMode=none`; it has no effect until waiting is enabled.
Validate DESIGN's ranges and `hardDriftMs > softDriftMs` on write and load.
Stored settings use a separate `{v:1,value:settings}` wrapper. Do not send storage-only fields on the wire.

Local descriptors contain exactly `{kind:"local",fingerprintVersion:1,digest,sizeBytes,durationMs}` and optional `label`.
Bilibili descriptors contain exactly `{kind:"bilibili",bvid,cid,part,durationMs}`.
Never accept extra URLs, filenames, paths, cookies, handles, timestamps, provider objects, or bytes.
Store descriptors with a separate versioned wrapper and validate on write/load. Descriptors cannot establish media authorization.

## Snapshot and WS shapes

`RoomSnapshot` has exactly these fields:

```text
{
  roomId, title, epoch, revision, mediaGeneration, hostMemberId, selfMemberId,
  settings: RoomSettings, media: MediaDescriptor | null,
  playback: {
    phase: "empty" | "paused" | "waiting" | "playing" | "ended",
    positionMs, anchorServerMs, baseRate: 1, desiredPlaying: boolean
  },
  barrier: {
    barrierId, requiredMemberIds: ID[], reason: "play" | "buffering",
    targetPositionMs, deadlineServerMs
  } | null,
  members: [{
    memberId, displayName, role: "host" | "participant",
    presence: "offline" | "connected", playbackActive: boolean,
    excludedFromWaiting: boolean,
    readiness: {
      status, mediaGeneration, barrierId: ID | null, sampledAtClientMs,
      positionMs: integer | null, durationMs: integer | null,
      capabilities: PlayerCapabilities
    } | null
  }],
  serverNowMs
}
```

`PlayerCapabilities` has exactly DESIGN §7.1's eight fields. Position resolution is an integer from 1–60,000 ms.
Readiness uses DESIGN §5.4's nine statuses. Null means no current-generation report, never implicit readiness.
Rosters exclude global identity IDs, connection IDs, invitation data, and credentials.
`selfMemberId` identifies the authenticated caller’s membership so clients can leave without comparing display names.
It is response-specific and is never accepted as authentication.
Snapshots contain at most the configured 32 members and 32 barrier member IDs. Barrier member IDs reference current roster members.
No media initially means generation 0, phase `empty`, position 0, no barrier, and no desired play.
Only `waiting` has a barrier. Only `playing` advances its anchor. Reports cannot replace the authoritative position.
P3 checks relational invariants after wire validation. Metadata validators cannot authorize room mutations.

Client mutation envelopes have exactly `{v:1,type,commandId,epoch,mediaGeneration,expectedRevision,payload}`.
Payloads are `{action:"play"|"pause"|"replay"}` or `{action:"seek",positionMs}` for `playback.command`;
`{media:MediaDescriptor}` for `media.select`; and `{memberId,excluded:boolean}` for `waiting.exclude`.
WS mutations require the current active lease. HTTP management uses authority independently of player-tab activity.
`member.activate` uses `{v:1,type,requestId,epoch}` to transfer the authenticated member's lease explicitly.
Readiness uses `{v:1,type:"member.readiness",epoch,payload:Readiness}`. Observations use the same envelope with `type:"member.observation"` and no barrier ID.
Bind room, identity, connection generation, and lease server-side; client frames cannot override them.

Server room envelopes have exactly `{v:1,type,epoch,eventSeq,payload}`; sequence starts at 1 per connection.
`session.welcome` carries `{connectionId,connectionGeneration,playbackLease,snapshot}`. `playbackLease` is a boolean for this connection; roster activity alone cannot identify which tab owns the lease. Successful explicit activation sends another welcome with the same connection identity and current lease. `room.snapshot` carries the snapshot directly.
`command.result` carries `{commandId,accepted,revision:integer|null,error:PublicError|null}`.
Accepted results contain the original committed revision and no error. Rejections contain an error and no committed revision.
Follow stale-command rejection with a current snapshot. Never replay rejected intent automatically.
`member.status` carries `{memberId,presence,playbackActive,excludedFromWaiting,readiness}`.
`room.closed` carries `{roomId,revision}`; `session.replaced` carries `{reason:"lease_transferred"|"session_revoked"}`; `error` carries `PublicError`.

Clock/heartbeat frames use `{v:1,type,requestId,payload}` without consuming room sequence numbers.
`clock.ping` carries `{clientSendMs}`; `clock.pong` echoes it with `{clientSendMs,serverReceiveMs,serverSendMs}`.
Heartbeat carries `{reply:boolean}`; reply to false once with true. It cannot renew membership or change revision.
P3 owns exhaustive frame decoding, admission, ordering, and lifecycle. P5 owns clock estimation and reconnect.

## Canonical request digests

Hash validated normalized operations, never raw JSON. Reject unknown fields before normalization.
Use SHA-256 over compact UTF-8 JSON for these arrays; fixed positions avoid object-key order differences:

```text
settings = [controllers,syncMode,waitMode,waitOnBuffering,waitTimeoutMs,lateJoin,softDriftMs,hardDriftMs]
local    = ["local",fingerprintVersion,digest,sizeBytes,durationMs,labelOrEmptyString]
bilibili = ["bilibili",bvid,cid,part,durationMs]
playback = ["ovs-command-v1","playback.command",epoch,mediaGeneration,expectedRevision,action,positionOrNull]
media    = ["ovs-command-v1","media.select",epoch,mediaGeneration,expectedRevision,descriptorArray]
exclude  = ["ovs-command-v1","waiting.exclude",epoch,mediaGeneration,expectedRevision,memberId,excluded]
create   = ["ovs-http-v1","rooms.create",title,settingsArray]
redeem   = ["ovs-http-v1","invitations.redeem","link"|"code",canonicalSecret]
```

Emit decimal integers and no spaces or trailing newline. Preserve Unicode scalars as UTF-8.
Escape only quotation marks and backslashes in text; control characters were already rejected. Disable Go's default HTML escaping.
Command/idempotency ID is the lookup key, excluded from the digest. Scope lookups to room/identity or identity/HTTP operation.
Store digests and nonsecret outcomes only, never canonical invitation input. P2 implements HTTP digest code and [shared cross-language vectors](fixtures/http-digests-v1.json). P3 owns command digests.
For WS retries, check current authority/lease and epoch, then stored ID/digest, then expected revision and media generation.
This permits an accepted media-selection retry with its original generation. A different digest is `invalid_command`.
Old epochs require new intent. Deduplication expires after 24 hours; no offline command queue exists.

## Runtime bounds and ownership decisions

Room resource limits use `rooms.Limits`, validated at startup. `OVS_MAX_ACTIVE_ROOMS` and `OVS_MAX_ROOM_MEMBERS` expose the selected room bounds.
Coordinators evict after one minute without operations; activation creates a fresh epoch. P3 retains coordinators with live sockets.
The initial storage failure latch stops writes and fails readiness until restart; P7 owns automated recovery.
Keep remaining runtime admission limits in one validated configuration as their owning packages add admission. Wire bounds stay in contracts and shared fixtures.
Initial bounds are resource controls, not capacity or latency guarantees.

| Boundary | Initial decision | Owner |
| --- | --- | --- |
| Coordinator input | 64 pending operations; immediate `busy` when full | P2 |
| SQLite writer | One worker, 128 pending transactions; immediate `busy` when full | P2 |
| Connection output | 64 frames or 256 KiB; disconnect/resnapshot on overflow | P3 |
| Socket write deadline | Five seconds; caller owns cancellation | P3 |
| Durable mutation deadline | Five seconds including queue time; cancelled queued work has no effects | P2/P3 |
| Bootstrap | 30/minute/address, burst 10 | P1 |
| Profile mutation | 30/minute/identity, burst 10 | P1 |
| Room creation | 5/minute/identity and address, burst 5 | P2 |
| Invitation attempts | 10/minute/address, burst 10; also 10/minute/identity | P2 |
| HTTP management | 60/minute/identity, burst 20 | P2 |
| Address bucket storage | 4,096 buckets, ten-minute idle expiry; reject unseen addresses on saturation | P1/P2 |
| Readiness tolerance | Within 250 ms of target after completed load/seek, matching generation and descriptor | P3/P6 |
| Clock window | Five initial samples, latest 20; use lowest-RTT five or all if fewer | P5 |
| Usable sample | Ordered finite nonnegative timestamps, network RTT 0–2,000 ms, age ≤30 s | P5 |
| Usable estimate | At least three samples since reset; subset median offset; uncertainty = largest half-RTT plus subset offset spread | P5 |
| Clock degradation | Uncertainty >250 ms or no usable estimate; no synchronized readiness or small rate correction | P5 |

Calibration collects five samples even though three usable samples can establish an estimate. Quantize client sends down and receives up to integer milliseconds; symmetric rounding can produce negative apparent RTT on sub-millisecond loopback paths. Timestamp quantization adds up to one millisecond of clock error per endpoint. Reject negative network delay; do not clamp it.
Asymmetric path error remains unobservable. Estimator uncertainty is not a verified bound on actual player skew.
DESIGN's existing member, room, socket, telemetry, heartbeat, reconnect, waiting, and checkpoint limits still apply.

Until P9 implements trusted proxy CIDRs, effective address is the IP from `RemoteAddr` only. Ignore all forwarding headers.
P9 accepts forwarding information only from configured proxy peers, validates the complete address list, and walks right-to-left to the first untrusted hop.
Reject malformed forwarding data from trusted peers. Never derive public origin from forwarding information.

P1 injects `now func() time.Time` for expiry and `io.Reader` for randomness; production uses `time.Now` and `crypto/rand.Reader`.
P2 services own small transaction interfaces. SQLite adapters implement atomic capability operations; keep begin/commit/rollback inside that boundary.
Do not expose `*sql.DB` to domain rules or add empty repository layers in P0.
P3 injects process-monotonic milliseconds separately from wall time. Never persist an anchor for extrapolation across restart.
Coordinators own timers and cancellation. The registry owns coordinator shutdown/eviction. The writer owns its single worker.
Connection sinks accept bounded frames without blocking a room. Transport owns socket loops, deadlines, and closure.
Serializable DTOs and Pinia stores cannot own timers or goroutines. P4 adapters own elements, files, workers, object URLs, and disposal.

## Local fingerprint and measurement preparation

P4 uses DESIGN §7.2's three samples. Encode every length prefix and unsigned integer as eight-byte big-endian.
Hash `LP(UTF8("ovs-local-v1"))`, `LP(UTF8(roomId))`, `U64(sizeBytes)`, then three repetitions of `U64(offset), U64(length), sampleBytes`.
`LP(bytes)` means `U64(byteLength)` followed by bytes. Preserve start/middle/end order even when ranges overlap or coincide.
Emit lowercase SHA-256 hex. Include no filename, timestamp, duration, or label. Probe duration separately; matching allows a 250 ms difference.
The [shared fingerprint vectors](fixtures/local-fingerprints-v1.json) cover tiny, overlapping, and separated samples with independent Go and browser checks. The worker uses pinned `@noble/hashes` 2.0.1 incremental SHA-256 without SubtleCrypto.

Prepare synthetic video with visible frame numbers and source timecode. Use only generated geometric patterns and text, without third-party media.
Keep the fixture, recipe, hash, environment, and measurement protocol in ignored `.misc/` as implementation evidence.
P5 needs two actual foreground players, independent displayed-time observations, separate control latency/skew, and declared observation uncertainty.
Neither `currentTime`, ACKs, nor predicted targets alone prove displayed convergence.
Test loopback HTTP and an ordinary LAN HTTP origin. Assert `isSecureContext === false` on the latter.
This prevents localhost exceptions from hiding unavailable randomness, file-selection, or hashing APIs. Stage 0 preparation does not establish P4/P5 acceptance.

## P3–P5 implementation limits

The socket route is `/ws/v1/rooms/{roomId}`. Exact Origin, session cookie, membership, and resource admission precede upgrade.
A membership may open four sockets; the instance may open 500. Welcome explicitly identifies playback lease ownership.
Accepted media selection permits validated local and Bilibili stable descriptors. The server validates metadata without fetching platform data.
Startup waiting freezes active participants and the host, requires current-barrier readiness, and pauses at its deadline.
`waiting.exclude` validates its envelope but returns `invalid_command` until P6 completes policy handling.
Full buffering, late-join, disconnected-cohort handling, and waiting-settings transitions remain P6.
Readiness transitions currently publish bounded complete snapshots; observation frames are validated and never change the timeline.
Periodic checkpoints and shutdown preserve position. Reactivation restores paused without advancing through downtime.
The storage failure latch requires restart; P7 owns automatic recovery.

## Production Bilibili helper (P8)

`GET /userscripts/ovs-bilibili.user.js` returns helper release 1.0.0, protocol 1, generated from validated `OVS_PUBLIC_ORIGIN`.
The embedded source has no runtime dependency download or automatic update. Manual updates retain the same origin and permission scope.
The userscript match specifies the exact scheme and hostname. Runtime activation additionally checks the exact port and top-level window.
Only `GM_xmlhttpRequest` and `unsafeWindow` are granted. Approved destinations and B0 request limits remain those in DESIGN §8.3.1.

Both bridge ends reject duplicate keys, malformed Unicode/numbers, and JSON nesting beyond eight levels.
Operation and reply decoders reject unknown fields before effects.
Same-window, exact-origin JSON messages use `ovs-bilibili-request` / `ovs-bilibili-response`, a random 128-bit `client` channel, and positive integer request `id`.
Hello requires `{op:"hello",version:1}` and responds with `{version:1,helper:"1.0.0",maxChunk:262144}`.
Startup retries hello at most five times within 2.5 seconds while the manager registers its document listener.
A new channel invalidates the preceding owner, pending requests, and handles. Other operations require the current channel.
Open/dispose use increasing generations; range and danmaku calls require the current generation and opaque handle.
Replies echo channel and ID. Page deadlines and disposal remove pending waiters; late replies cannot reach a replacement player.
Bridge data never enters room sockets, HTTP mutations, SQLite, diagnostics, or serializable frontend stores.

Bilibili matching requires identical BV ID, CID, and part, with duration within 250 ms.
Loading and access failures remain local readiness states. Comment failure does not become a playback failure.
Generation replacement, room disposal, and playback-lease loss cancel delivery and clear native buffers and overlays.
Danmaku renders bounded text modes 1/4/5 against observed media time. Visibility, density, and size are local preferences.
The trusted OVS page can invoke this bridge. Plain HTTP also trusts the network; the bridge is not a defense against malicious same-origin code.
