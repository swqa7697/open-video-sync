// Version-2 value boundaries. These do not authorize actions or implement routes.
// Server wire rules and response/envelope shapes: specs/WIRE.md.
export interface ProfilePatch {
  displayName: string;
}

export interface RoomSettings {
  controllers: 'host' | 'everyone';
  waitForAll: boolean;
}

export type MediaDescriptor =
  | {
      kind: 'local';
      fingerprintVersion: 1;
      digest: string;
      sizeBytes: number;
      durationMs: number;
      label?: string;
    }
  | {
      kind: 'bilibili';
      bvid: string;
      cid: string;
      part: number;
      durationMs: number;
    };

const maxDurationMs = 604_800_000;
const maxFileBytes = 17_592_186_044_416;

function invalid(): never {
  // Keep diagnostics bounded and free from input/provider data.
  throw new Error('invalid input');
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  return value as Record<string, unknown>;
}

function shape(value: Record<string, unknown>, fields: string[]): void {
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  ) {
    invalid();
  }
}

function text(value: unknown, maxCodepoints: number, maxBytes: number): string {
  if (typeof value !== 'string') return invalid();
  const points = Array.from(value);
  if (
    points.length > maxCodepoints ||
    new TextEncoder().encode(value).length > maxBytes ||
    points.some((point) => {
      const code = point.codePointAt(0)!;
      return (
        code <= 0x1f ||
        (code >= 0x7f && code <= 0x9f) ||
        (code >= 0xd800 && code <= 0xdfff)
      );
    })
  ) {
    return invalid();
  }
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    return invalid();
  }
  return value;
}

function choice<T extends string>(value: unknown, options: readonly T[]): T {
  for (const option of options) {
    if (value === option) return option;
  }
  return invalid();
}

export function decodeProfilePatch(value: unknown): ProfilePatch {
  const input = object(value);
  shape(input, ['displayName']);
  return { displayName: text(input.displayName, 48, 192) };
}

export function decodeRoomSettings(value: unknown): RoomSettings {
  const input = object(value);
  shape(input, ['controllers', 'waitForAll']);
  if (typeof input.waitForAll !== 'boolean') return invalid();
  const settings: RoomSettings = {
    controllers: choice(input.controllers, ['host', 'everyone']),
    waitForAll: input.waitForAll,
  };
  return settings;
}

// Input is a decoded JSON value. HTTP/WS transport owns raw message limits.
// Outbound serializers must use this returned allowlist rather than input objects.
export function decodeMedia(value: unknown): MediaDescriptor {
  const input = object(value);
  const durationMs = integer(input.durationMs, 1, maxDurationMs);
  if (input.kind === 'local') {
    const fields = [
      'kind',
      'fingerprintVersion',
      'digest',
      'sizeBytes',
      'durationMs',
    ];
    const label = Object.hasOwn(input, 'label')
      ? text(input.label, 120, 480)
      : undefined;
    if (label !== undefined) fields.push('label');
    shape(input, fields);
    if (input.fingerprintVersion !== 1) return invalid();
    const digest = text(input.digest, 64, 64);
    if (!/^[a-f0-9]{64}$/.test(digest)) return invalid();
    const media: MediaDescriptor = {
      kind: 'local',
      fingerprintVersion: 1,
      digest,
      sizeBytes: integer(input.sizeBytes, 1, maxFileBytes),
      durationMs,
    };
    if (label !== undefined) media.label = label;
    return media;
  }
  if (input.kind === 'bilibili') {
    shape(input, ['kind', 'bvid', 'cid', 'part', 'durationMs']);
    const bvid = text(input.bvid, 12, 12);
    const cid = text(input.cid, 20, 20);
    if (!/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(bvid)) {
      return invalid();
    }
    if (!/^[1-9][0-9]{0,19}$/.test(cid)) return invalid();
    return {
      kind: 'bilibili',
      bvid,
      cid,
      part: integer(input.part, 1, 10_000),
      durationMs,
    };
  }
  return invalid();
}
