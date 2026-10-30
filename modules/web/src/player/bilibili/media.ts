import { boundedText, exact, HelperError, integer, object } from './bridge';
export interface TrackInfo {
  id: number;
  codec: string;
  mime: string;
  init: [number, number];
  index: [number, number];
}
export interface MediaInfo {
  bvid: string;
  cid: string;
  part: number;
  duration: number;
  title: string;
  parts: number;
  handle: string;
  tracks: TrackInfo[];
  quality: number;
  qualities: number[];
}
export interface Segment {
  offset: number;
  length: number;
  time: number;
  end: number;
}
export function parseSelection(
  input: string,
  part: number
): { bvid: string; part: number } {
  const raw = input.trim();
  if (
    !Number.isSafeInteger(part) ||
    part < 1 ||
    part > 10000 ||
    raw.length > 2048
  )
    throw new Error(
      'Enter a canonical Bilibili video URL or BV identifier and a valid part.'
    );
  if (/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(raw)) return { bvid: raw, part };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Enter a canonical Bilibili video URL or BV identifier.');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    !['www.bilibili.com', 'bilibili.com'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error(
      'Open the video on Bilibili and copy its canonical video URL. Short links cannot be expanded here.'
    );
  const match = url.pathname.match(
    /^\/video\/(BV[1-9A-HJ-NP-Za-km-z]{10})\/?$/
  );
  if (!match)
    throw new Error(
      'Open the video on Bilibili and copy its canonical video URL.'
    );
  const selected = url.searchParams.has('p')
    ? Number(url.searchParams.get('p'))
    : part;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 10000)
    throw new Error('Enter a valid Bilibili part.');
  return { bvid: match[1]!, part: selected };
}
export function decodeInfo(
  value: unknown,
  bvid: string,
  part: number
): MediaInfo {
  const v = object(value);
  exact(v, [
    'bvid',
    'cid',
    'part',
    'duration',
    'title',
    'parts',
    'handle',
    'tracks',
    'quality',
    'qualities',
  ]);
  if (
    v.bvid !== bvid ||
    v.part !== part ||
    typeof v.cid !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(v.cid) ||
    typeof v.duration !== 'number' ||
    !Number.isFinite(v.duration) ||
    v.duration < 0.001 ||
    v.duration > 604800 ||
    !Array.isArray(v.tracks) ||
    v.tracks.length !== 2
  )
    throw new HelperError('invalid-reply');
  const range = (value: unknown): [number, number] => {
    if (!Array.isArray(value) || value.length !== 2)
      throw new HelperError('invalid-reply');
    const start = integer(value[0], 0, 65535),
      end = integer(value[1], start, 65535);
    return [start, end];
  };
  const tracks = v.tracks.map((value, index) => {
    const t = object(value);
    exact(t, ['id', 'codec', 'mime', 'init', 'index']);
    const codec = boundedText(t.codec, 60);
    if (
      t.mime !== (index === 0 ? 'video/mp4' : 'audio/mp4') ||
      !(index === 0 ? /^avc1\.[a-zA-Z0-9.]+$/ : /^mp4a\.[a-zA-Z0-9.]+$/).test(
        codec
      )
    )
      throw new HelperError('unsupported-codec');
    return {
      id: integer(t.id, 1, 1000000),
      codec,
      mime: t.mime as string,
      init: range(t.init),
      index: range(t.index),
    };
  });
  const handle = boundedText(v.handle, 100);
  if (!/^h[0-9]+-[0-9-]+$/.test(handle)) throw new HelperError('invalid-reply');
  const quality = integer(v.quality, 1, 127);
  if (
    !Array.isArray(v.qualities) ||
    !v.qualities.length ||
    v.qualities.length > 32
  )
    throw new HelperError('invalid-reply');
  const qualities = v.qualities.map((q) => integer(q, 1, 127));
  if (
    new Set(qualities).size !== qualities.length ||
    !qualities.includes(quality)
  )
    throw new HelperError('invalid-reply');
  return {
    quality,
    qualities,
    bvid,
    cid: v.cid,
    part,
    duration: v.duration,
    title: boundedText(v.title, 160),
    parts: integer(v.parts, part, 10000),
    handle,
    tracks,
  };
}
// Parse a bounded ISO-BMFF SIDX. Nested indexes and unsafe offsets are unsupported.
export function parseIndex(data: Uint8Array, offset: number): Segment[] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const fail = (): never => {
    throw new HelperError('invalid-index');
  };
  let at = 0;
  while (at + 8 <= data.length) {
    const size = v.getUint32(at),
      type = String.fromCharCode(...data.subarray(at + 4, at + 8));
    if (size < 8 || at + size > data.length) return fail();
    if (type !== 'sidx') {
      at += size;
      continue;
    }
    const end = at + size;
    if (size < 32) return fail();
    const version = v.getUint8(at + 8),
      scale = v.getUint32(at + 16);
    let cursor = at + 20,
      time: number,
      first: number;
    if (version === 0) {
      time = v.getUint32(cursor);
      first = v.getUint32(cursor + 4);
      cursor += 8;
    } else if (version === 1 && size >= 40) {
      time = Number(v.getBigUint64(cursor));
      first = Number(v.getBigUint64(cursor + 8));
      cursor += 16;
    } else return fail();
    if (!scale || !Number.isSafeInteger(time) || !Number.isSafeInteger(first))
      return fail();
    cursor += 2;
    const count = v.getUint16(cursor);
    cursor += 2;
    if (!count || count > 10000 || cursor + count * 12 > end) return fail();
    let position = offset + end + first;
    const segments: Segment[] = [];
    for (let i = 0; i < count; i++) {
      const reference = v.getUint32(cursor),
        duration = v.getUint32(cursor + 4);
      cursor += 12;
      const length = reference & 0x7fffffff;
      if (
        reference >>> 31 ||
        length < 1 ||
        length > 4 * 1024 * 1024 ||
        !duration ||
        !Number.isSafeInteger(position + length) ||
        (time + duration) / scale > 604801
      )
        return fail();
      segments.push({
        offset: position,
        length,
        time: time / scale,
        end: (time + duration) / scale,
      });
      position += length;
      time += duration;
    }
    return segments;
  }
  return fail();
}
