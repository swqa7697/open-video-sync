import { decodeProfilePatch, decodeRoomSettings, type RoomSettings } from './contracts';

export interface Session {
  identity: { identityId: string; displayName: string };
  csrfToken: string;
  expiresAtMs: number;
}
export interface Member {
  memberId: string;
  displayName: string;
  role: 'host' | 'participant';
  presence: 'offline';
  playbackActive: false;
  excludedFromWaiting: false;
  readiness: null;
}
export interface Snapshot {
  roomId: string;
  title: string;
  epoch: string;
  revision: number;
  hostMemberId: string;
  selfMemberId: string;
  settings: RoomSettings;
  mediaGeneration: 0;
  media: null;
  playback: {
    phase: 'empty';
    positionMs: 0;
    anchorServerMs: 0;
    baseRate: 1;
    desiredPlaying: false;
  };
  barrier: null;
  serverNowMs: number;
  members: Member[];
}
export interface Invitation {
  linkSecret: string;
  code: string;
  generation: number;
  expiresAtMs: number;
}
export interface RoomSummary {
  roomId: string;
  title: string;
  role: 'host' | 'participant';
  revision: number;
  lastActiveAtMs: number;
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
function shape(value: Record<string, unknown>, fields: string[]): void {
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
function text(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid server response.');
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid server response.');
  return value;
}
export function id(value: unknown): string {
  const result = text(value);
  if (!/^[a-f0-9]{32}$/.test(result)) throw new Error('Invalid server response.');
  return result;
}
function role(value: unknown): 'host' | 'participant' {
  if (value !== 'host' && value !== 'participant') throw new Error('Invalid server response.');
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
  if (!/^[A-Za-z0-9_-]{43}$/.test(csrfToken)) throw new Error('Invalid server response.');
  return {
    identity: {
      identityId: id(profile.identityId),
      displayName: decodeProfilePatch({ displayName: profile.displayName }).displayName,
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
    v.members.length > 32 ||
    v.media !== null ||
    v.barrier !== null ||
    v.mediaGeneration !== 0
  )
    throw new Error('Invalid server response.');
  const playback = object(v.playback);
  shape(playback, ['phase', 'positionMs', 'anchorServerMs', 'baseRate', 'desiredPlaying']);
  if (
    playback.phase !== 'empty' ||
    playback.positionMs !== 0 ||
    playback.anchorServerMs !== 0 ||
    playback.baseRate !== 1 ||
    playback.desiredPlaying !== false
  )
    throw new Error('Invalid server response.');
  const members: Member[] = v.members.map((value: unknown) => {
    const m = object(value);
    shape(m, [
      'memberId',
      'displayName',
      'role',
      'presence',
      'playbackActive',
      'excludedFromWaiting',
      'readiness',
    ]);
    if (
      m.presence !== 'offline' ||
      m.playbackActive !== false ||
      m.excludedFromWaiting !== false ||
      m.readiness !== null
    )
      throw new Error('Invalid server response.');
    const displayName = text(m.displayName);
    decodeProfilePatch({ displayName });
    return {
      memberId: id(m.memberId),
      displayName,
      role: role(m.role),
      presence: 'offline',
      playbackActive: false,
      excludedFromWaiting: false,
      readiness: null,
    };
  });
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
    mediaGeneration: 0,
    media: null,
    barrier: null,
    playback: {
      phase: 'empty',
      positionMs: 0,
      anchorServerMs: 0,
      baseRate: 1,
      desiredPlaying: false,
    },
    serverNowMs: integer(v.serverNowMs),
  };
}
export function decodeInvitation(value: unknown): Invitation {
  const v = object(value),
    linkSecret = text(v.linkSecret),
    code = text(v.code);
  shape(v, ['linkSecret', 'code', 'generation', 'expiresAtMs']);
  if (
    !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(linkSecret) ||
    !/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{16}$/.test(code)
  )
    throw new Error('Invalid server response.');
  return {
    linkSecret,
    code,
    generation: positive(v.generation),
    expiresAtMs: integer(v.expiresAtMs),
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
  if (typeof v.replayed !== 'boolean') throw new Error('Invalid server response.');
  return {
    snapshot: decodeSnapshot(v.snapshot),
    invitation: v.invitation == null ? null : decodeInvitation(v.invitation),
    replayed: v.replayed,
  };
}
export function decodeList(value: unknown): { rooms: RoomSummary[]; nextCursor: string | null } {
  const v = object(value);
  shape(v, ['rooms', 'nextCursor']);
  if (!Array.isArray(v.rooms) || v.rooms.length > 100) throw new Error('Invalid server response.');
  return {
    rooms: v.rooms.map((value: unknown) => {
      const r = object(value);
      shape(r, ['roomId', 'title', 'role', 'revision', 'lastActiveAtMs']);
      return {
        roomId: id(r.roomId),
        title: title(r.title),
        role: role(r.role),
        revision: positive(r.revision),
        lastActiveAtMs: integer(r.lastActiveAtMs),
      };
    }),
    nextCursor: v.nextCursor === null ? null : id(v.nextCursor),
  };
}

const errors: Record<string, string> = {
  invalid_input: 'Check the entered values.',
  session_required: 'Your identity session ended. Reload to start a new identity.',
  forbidden: 'You do not have permission for this action.',
  not_found: 'This room is unavailable.',
  invalid_invitation: 'This invitation is invalid or expired.',
  stale_state: 'The room changed. Refresh the room, then choose your action again.',
  idempotency_conflict: 'This request key was already used.',
  message_too_large: 'The request is too large.',
  unsupported_content_type: 'The request needs JSON.',
  rate_limited: 'Too many requests. Try again later.',
  capacity_reached: 'Capacity reached. Try again later.',
  busy: 'The server is busy. Try again.',
  storage_unavailable: 'Storage is unavailable. Try again later.',
};
export class APIError extends Error {
  constructor(public code: string) {
    super(errors[code] ?? 'The request failed.');
  }
}
export async function request(
  path: string,
  method: string,
  csrf: string,
  payload: unknown,
  signal: AbortSignal,
  key?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    if (csrf) headers['X-OVS-CSRF'] = csrf;
  }
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(`/api/v1${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    signal,
    ...(method !== 'GET' ? { body: JSON.stringify(payload) } : {}),
  });
  // Bound decoded data even when a proxy produces an unexpected response.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The server returned an empty response.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > 65536) throw new Error('The server response is too large.');
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!response.ok) {
    const error = object(value);
    throw new APIError(
      typeof error.code === 'string' && Object.hasOwn(errors, error.code) ? error.code : 'unknown',
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
    syncMode: 'adaptive',
    waitMode: 'all',
    waitOnBuffering: true,
    waitTimeoutMs: 30000,
    lateJoin: 'catch_up',
    softDriftMs: 100,
    hardDriftMs: 750,
  };
}
