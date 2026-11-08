import { id, integer, object, shape, text } from './api';

export interface PlayerCapabilities {
  canPlay: boolean;
  canPause: boolean;
  canSeek: boolean;
  canReadPosition: boolean;
  canSetPlaybackRate: boolean;
  canDetectBuffering: boolean;
  canShowDanmaku: boolean;
  positionResolutionMs: number;
}
export type ReadinessStatus =
  | 'no_media'
  | 'loading'
  | 'ready'
  | 'buffering'
  | 'gesture_required'
  | 'mismatch'
  | 'access_denied'
  | 'unsupported'
  | 'error';
export interface Readiness {
  status: ReadinessStatus;
  mediaGeneration: number;
  barrierId: string | null;
  sampledAtClientMs: number;
  positionMs: number | null;
  durationMs: number | null;
  capabilities: PlayerCapabilities;
}
export function decodeReadiness(value: unknown): Readiness {
  const v = object(value),
    c = object(v.capabilities);
  shape(v, [
    'status',
    'mediaGeneration',
    'barrierId',
    'sampledAtClientMs',
    'positionMs',
    'durationMs',
    'capabilities',
  ]);
  shape(c, [
    'canPlay',
    'canPause',
    'canSeek',
    'canReadPosition',
    'canSetPlaybackRate',
    'canDetectBuffering',
    'canShowDanmaku',
    'positionResolutionMs',
  ]);
  if (
    ![
      'no_media',
      'loading',
      'ready',
      'buffering',
      'gesture_required',
      'mismatch',
      'access_denied',
      'unsupported',
      'error',
    ].includes(text(v.status))
  )
    throw new Error('Invalid readiness.');
  for (const key of Object.keys(c))
    if (key !== 'positionResolutionMs' && typeof c[key] !== 'boolean')
      throw new Error('Invalid capabilities.');
  const resolution = integer(c.positionResolutionMs);
  if (resolution < 1 || resolution > 60000)
    throw new Error('Invalid resolution.');
  const position = v.positionMs === null ? null : integer(v.positionMs),
    duration = v.durationMs === null ? null : integer(v.durationMs);
  if (
    (position !== null && position > 604800000) ||
    (duration !== null && (duration < 1 || duration > 604800000))
  )
    throw new Error('Invalid position.');
  return {
    status: v.status as ReadinessStatus,
    mediaGeneration: integer(v.mediaGeneration),
    barrierId: v.barrierId === null ? null : id(v.barrierId),
    sampledAtClientMs: integer(v.sampledAtClientMs),
    positionMs: position,
    durationMs: duration,
    capabilities: {
      canPlay: c.canPlay as boolean,
      canPause: c.canPause as boolean,
      canSeek: c.canSeek as boolean,
      canReadPosition: c.canReadPosition as boolean,
      canSetPlaybackRate: c.canSetPlaybackRate as boolean,
      canDetectBuffering: c.canDetectBuffering as boolean,
      canShowDanmaku: c.canShowDanmaku as boolean,
      positionResolutionMs: resolution,
    },
  };
}
// JSON.parse alone loses duplicate keys. Walk raw frames before decoding the allowlist.
export function parseFrame(raw: string): Record<string, unknown> {
  if (raw.length > 65536 || new TextEncoder().encode(raw).length > 65536)
    throw new Error('Frame too large.');
  let at = 0;
  const space = () => {
    while (/\s/.test(raw[at] ?? '') && at < raw.length) at++;
  };
  const string = (): string => {
    const start = at++;
    let escaped = false;
    while (at < raw.length) {
      const c = raw[at++]!;
      if (!escaped && c === '"') {
        const value: unknown = JSON.parse(raw.slice(start, at));
        if (
          typeof value !== 'string' ||
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
            value,
          )
        )
          throw new Error('Invalid string.');
        return value;
      }
      if (c === '\\' && !escaped) escaped = true;
      else escaped = false;
    }
    throw new Error('Invalid JSON.');
  };
  const visit = (depth: number, fractional = false): void => {
    space();
    const c = raw[at];
    if (c === '{' || c === '[') {
      if (depth >= 8) throw new Error('JSON too deep.');
      at++;
      space();
      const end = c === '{' ? '}' : ']';
      const keys = new Set<string>();
      if (raw[at] === end) {
        at++;
        return;
      }
      for (;;) {
        let key: string | undefined;
        if (c === '{') {
          if (raw[at] !== '"') throw new Error('Invalid key.');
          key = string();
          if (keys.has(key)) throw new Error('Duplicate key.');
          keys.add(key);
          space();
          if (raw[at++] !== ':') throw new Error('Invalid object.');
        }
        visit(depth + 1, key === 'rate');
        space();
        const next = raw[at++];
        if (next === end) break;
        if (next !== ',') throw new Error('Invalid JSON.');
        space();
      }
    } else if (c === '"') string();
    else {
      // Only playback rates admit fractional JSON numbers. All other numeric
      // fields retain canonical integer literals; their allowlists validate bounds.
      const pattern = fractional
        ? /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/
        : /^(?:true|false|null|0|[1-9][0-9]*)/;
      const token = pattern.exec(raw.slice(at))?.[0];
      if (!token) throw new Error('Invalid value.');
      at += token.length;
    }
  };
  visit(0);
  space();
  if (at !== raw.length) throw new Error('Invalid JSON.');
  return object(JSON.parse(raw));
}
