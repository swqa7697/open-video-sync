import { LocalizedError, message, type Message } from '../i18n';
import {
  decodeMedia,
  decodePlaybackRate,
  decodeProfilePatch,
  decodeRoomSettings,
  type MediaDescriptor,
  type RoomSettings,
} from './contracts';
import { decodeReadiness, type Readiness } from './protocol-values';

export interface Session {
  identity: { identityId: string; displayName: string };
  csrfToken: string;
  expiresAtMs: number;
}
export interface Member {
  memberId: string;
  displayName: string;
  role: 'host' | 'participant';
  presence: 'offline' | 'connected';
  readiness: Readiness | null;
}
export interface Snapshot {
  roomId: string;
  title: string;
  epoch: string;
  revision: number;
  hostMemberId: string;
  selfMemberId: string;
  settings: RoomSettings;
  mediaGeneration: number;
  media: MediaDescriptor | null;
  playback: {
    phase: 'empty' | 'paused' | 'waiting' | 'playing' | 'ended';
    positionMs: number;
    anchorServerMs: number;
    rate: number;
    desiredPlaying: boolean;
  };
  barrier: {
    barrierId: string;
    requiredMemberIds: string[];
    reason: 'play' | 'buffering';
    targetPositionMs: number;
    deadlineServerMs: number;
  } | null;
  serverNowMs: number;
  members: Member[];
}
export interface Invitation {
  linkSecret: string;
  code: string;
}
export interface RoomSummary {
  roomId: string;
  title: string;
  role: 'host' | 'participant';
}
export interface RoomResult {
  snapshot: Snapshot;
  invitation: Invitation | null;
  replayed: boolean;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid server response.');
  return value as Record<string, unknown>;
}
export function shape(value: Record<string, unknown>, fields: string[]): void {
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw new Error('Invalid server response.');
}
function positive(value: unknown): number {
  const n = integer(value);
  if (n < 1) throw new Error('Invalid server response.');
  return n;
}
export function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid server response.');
  return value;
}
export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid server response.');
  return value;
}
export function id(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{32}$/.test(result))
    throw new Error('Invalid server response.');
  return result;
}
function role(value: unknown): 'host' | 'participant' {
  if (value !== 'host' && value !== 'participant')
    throw new Error('Invalid server response.');
  return value;
}
function title(value: unknown): string {
  const result = text(value);
  if (
    !result.trim() ||
    Array.from(result).length > 120 ||
    new TextEncoder().encode(result).length > 480
  )
    throw new Error('Invalid server response.');
  return result;
}
export function decodeSession(value: unknown): Session {
  const v = object(value),
    profile = object(v.identity);
  shape(v, ['identity', 'csrfToken', 'expiresAtMs']);
  shape(profile, ['identityId', 'displayName']);
  const csrfToken = text(v.csrfToken);
  if (!/^[A-Za-z0-9_-]{43}$/.test(csrfToken))
    throw new Error('Invalid server response.');
  return {
    identity: {
      identityId: id(profile.identityId),
      displayName: decodeProfilePatch({ displayName: profile.displayName })
        .displayName,
    },
    csrfToken,
    expiresAtMs: integer(v.expiresAtMs),
  };
}
export function decodeSnapshot(value: unknown): Snapshot {
  const v = object(value);
  shape(v, [
    'roomId',
    'title',
    'epoch',
    'revision',
    'mediaGeneration',
    'hostMemberId',
    'selfMemberId',
    'settings',
    'media',
    'playback',
    'barrier',
    'members',
    'serverNowMs',
  ]);
  if (
    !Array.isArray(v.members) ||
    v.members.length < 1 ||
    v.members.length > 32
  )
    throw new Error('Invalid server response.');
  const playback = object(v.playback);
  shape(playback, [
    'phase',
    'positionMs',
    'anchorServerMs',
    'rate',
    'desiredPlaying',
  ]);
  const media = v.media === null ? null : decodeMedia(v.media);
  const generation = integer(v.mediaGeneration);
  if (
    !['empty', 'paused', 'waiting', 'playing', 'ended'].includes(
      text(playback.phase),
    ) ||
    typeof playback.desiredPlaying !== 'boolean'
  )
    throw new Error('Invalid playback.');
  const positionMs = integer(playback.positionMs),
    anchorServerMs = integer(playback.anchorServerMs),
    rate = decodePlaybackRate(playback.rate);
  if (
    (!media &&
      (playback.phase !== 'empty' ||
        generation !== 0 ||
        positionMs !== 0 ||
        playback.desiredPlaying ||
        rate !== 1)) ||
    (media &&
      (generation < 1 ||
        playback.phase === 'empty' ||
        positionMs > media.durationMs))
  )
    throw new Error('Invalid timeline.');
  let barrier: Snapshot['barrier'] = null;
  if (v.barrier !== null) {
    const b = object(v.barrier);
    shape(b, [
      'barrierId',
      'requiredMemberIds',
      'reason',
      'targetPositionMs',
      'deadlineServerMs',
    ]);
    if (
      !Array.isArray(b.requiredMemberIds) ||
      b.requiredMemberIds.length > 32 ||
      !['play', 'buffering'].includes(text(b.reason))
    )
      throw new Error('Invalid barrier.');
    barrier = {
      barrierId: id(b.barrierId),
      requiredMemberIds: b.requiredMemberIds.map(id),
      reason: b.reason as 'play' | 'buffering',
      targetPositionMs: integer(b.targetPositionMs),
      deadlineServerMs: integer(b.deadlineServerMs),
    };
  }
  if ((playback.phase === 'waiting') !== (barrier !== null))
    throw new Error('Invalid barrier.');
  const members: Member[] = v.members.map((value: unknown) => {
    const m = object(value);
    shape(m, ['memberId', 'displayName', 'role', 'presence', 'readiness']);
    if (!['offline', 'connected'].includes(text(m.presence)))
      throw new Error('Invalid member.');
    const displayName = text(m.displayName);
    decodeProfilePatch({ displayName });
    return {
      memberId: id(m.memberId),
      displayName,
      role: role(m.role),
      presence: m.presence as Member['presence'],
      readiness: m.readiness === null ? null : decodeReadiness(m.readiness),
    };
  });
  if (
    barrier &&
    (barrier.requiredMemberIds.some(
      (mid) => !members.some((m) => m.memberId === mid),
    ) ||
      new Set(barrier.requiredMemberIds).size !==
        barrier.requiredMemberIds.length ||
      barrier.targetPositionMs > (media?.durationMs ?? 0))
  )
    throw new Error('Invalid barrier members.');
  const hostMemberId = id(v.hostMemberId),
    selfMemberId = id(v.selfMemberId);
  if (
    new Set(members.map((m) => m.memberId)).size !== members.length ||
    !members.some((m) => m.memberId === selfMemberId) ||
    members.filter((m) => m.role === 'host').length !== 1 ||
    !members.some((m) => m.memberId === hostMemberId && m.role === 'host')
  )
    throw new Error('Invalid server response.');
  return {
    roomId: id(v.roomId),
    title: title(v.title),
    epoch: id(v.epoch),
    revision: positive(v.revision),
    hostMemberId,
    selfMemberId,
    settings: decodeRoomSettings(v.settings),
    members,
    mediaGeneration: generation,
    media,
    barrier,
    playback: {
      phase: playback.phase as Snapshot['playback']['phase'],
      positionMs,
      anchorServerMs,
      rate,
      desiredPlaying: playback.desiredPlaying,
    },
    serverNowMs: integer(v.serverNowMs),
  };
}
export function decodeInvitation(value: unknown): Invitation {
  const v = object(value),
    linkSecret = text(v.linkSecret),
    code = text(v.code);
  shape(v, ['linkSecret', 'code']);
  if (
    !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(linkSecret) ||
    !/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/.test(code)
  )
    throw new Error('Invalid server response.');
  return {
    linkSecret,
    code,
  };
}
export function decodeRoomResult(value: unknown): RoomResult {
  const v = object(value);
  shape(
    v,
    Object.hasOwn(v, 'invitation')
      ? ['snapshot', 'invitation', 'replayed']
      : ['snapshot', 'replayed'],
  );
  if (typeof v.replayed !== 'boolean')
    throw new Error('Invalid server response.');
  return {
    snapshot: decodeSnapshot(v.snapshot),
    invitation: v.invitation == null ? null : decodeInvitation(v.invitation),
    replayed: v.replayed,
  };
}
export function decodeList(value: unknown): {
  rooms: RoomSummary[];
  nextCursor: string | null;
} {
  const v = object(value);
  shape(v, ['rooms', 'nextCursor']);
  if (!Array.isArray(v.rooms) || v.rooms.length > 100)
    throw new Error('Invalid server response.');
  return {
    rooms: v.rooms.map((value: unknown) => {
      const r = object(value);
      shape(r, ['roomId', 'title', 'role']);
      return {
        roomId: id(r.roomId),
        title: title(r.title),
        role: role(r.role),
      };
    }),
    nextCursor: v.nextCursor === null ? null : id(v.nextCursor),
  };
}

const errors: Record<string, Message> = {
  request_outcome_unknown: message('api.request_outcome_unknown'),
  invalid_input: message('api.invalid_input'),
  invalid_command: message('api.invalid_command'),
  session_required: message('api.session_required'),
  forbidden: message('api.forbidden'),
  not_found: message('api.not_found'),
  invalid_invitation: message('api.invalid_invitation'),
  upgrade_required: message('api.upgrade_required'),
  stale_state: message('api.stale_state'),
  idempotency_conflict: message('api.idempotency_conflict'),
  message_too_large: message('api.message_too_large'),
  unsupported_content_type: message('api.unsupported_content_type'),
  rate_limited: message('api.rate_limited'),
  capacity_reached: message('api.capacity_reached'),
  busy: message('api.busy'),
  storage_unavailable: message('api.storage_unavailable'),
};
// Codes whose recovery needs a fresh page: the page state or session is no longer usable.
const reloadCodes = new Set([
  'session_required',
  'upgrade_required',
  'idempotency_conflict',
  'unsupported_content_type',
  'unknown',
]);
export class APIError extends LocalizedError {
  readonly reload: boolean;
  constructor(public code: string) {
    super(errors[code] ?? message('api.unknown'));
    this.reload = reloadCodes.has(code);
  }
}
// NetworkError means OVS did not answer: the connection failed or a proxy returned its own page.
export class NetworkError extends LocalizedError {
  constructor(readonly status?: number) {
    super(
      status === undefined
        ? message('api.network')
        : message('api.proxy', { status }),
    );
  }
}
// ResponseError means OVS answered with data this page cannot use.
export class ResponseError extends LocalizedError {
  readonly reload = true;
  constructor() {
    super(message('api.response'));
  }
}
export async function request(
  path: string,
  method: string,
  csrf: string,
  payload: unknown,
  signal: AbortSignal,
  key?: string,
  replayOnly = false,
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (csrf) headers['X-OVS-CSRF'] = csrf;
  }
  if (key) headers['Idempotency-Key'] = key;
  if (replayOnly) headers['Idempotency-Replay-Only'] = 'true';
  let response: Response;
  try {
    response = await fetch(`/api/v2${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      signal,
      ...(method !== 'GET' ? { body: JSON.stringify(payload) } : {}),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new NetworkError();
  }
  // Bound decoded data even when a proxy produces an unexpected response.
  const reader = response.body?.getReader();
  if (!reader)
    throw response.ok ? new ResponseError() : new NetworkError(response.status);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 65536) throw new ResponseError();
      chunks.push(chunk.value);
    }
  } catch (error) {
    // An errored stream rejects cancel with the same failure; classify the original error.
    await reader.cancel().catch(() => {});
    if (signal.aborted || error instanceof ResponseError) throw error;
    throw new NetworkError();
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    // A proxy error page is not an OVS answer; an OK non-JSON body is an unusable answer.
    throw response.ok ? new ResponseError() : new NetworkError(response.status);
  }
  if (!response.ok) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new NetworkError(response.status);
    const code = (value as Record<string, unknown>).code;
    throw new APIError(
      typeof code === 'string' && Object.hasOwn(errors, code)
        ? code
        : 'unknown',
    );
  }
  return value;
}
// getRandomValues is available on ordinary HTTP; randomUUID is not required.
export function requestKey(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}
export function defaultSettings(): RoomSettings {
  return {
    controllers: 'host',
    waitForAll: true,
  };
}
