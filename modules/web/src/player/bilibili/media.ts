import { videoCodecRank } from '@ovs/helper/media-codecs';
import { LocalizedError, message } from '../../i18n';
import { boundedText, exact, HelperError, integer, object } from './bridge';

export interface TrackInfo {
  id: number;
  codec: string;
  mime: string;
  init: [number, number];
  index: [number, number];
}
export interface Episode {
  bvid: string;
  part: number;
  title: string;
  episodeId?: string;
}
export type BilibiliSelection =
  | { bvid: string; part: number; episodeId?: string }
  | { seasonId: string; part: 1 }
  | { episodeId: string; part: 1 };
export interface Playlist {
  title: string;
  episodes: Episode[];
}
export function sameEpisode(
  a: Pick<Episode, 'bvid' | 'part' | 'episodeId'> | undefined,
  b: Pick<Episode, 'bvid' | 'part' | 'episodeId'>,
): boolean {
  return (
    !!a && a.bvid === b.bvid && a.part === b.part && a.episodeId === b.episodeId
  );
}
export interface MediaPreview {
  bvid: string;
  episodeId?: string;
  cid: string;
  part: number;
  duration: number;
  title: string;
  parts: number;
  tracks: TrackInfo[];
  quality: number;
  qualities: number[];
  playlist?: Playlist;
}
export interface MediaInfo extends MediaPreview {
  handle: string;
}
export function decodePlaylist(
  value: unknown,
  bvid: string,
  part: number,
  episodeId?: string,
): Playlist {
  const v = object(value);
  exact(v, ['title', 'episodes']);
  if (
    !Array.isArray(v.episodes) ||
    v.episodes.length < 2 ||
    v.episodes.length > 500
  )
    throw new HelperError('invalid-reply');
  const seen = new Set<string>();
  const episodes = v.episodes.map((value) => {
    const e = object(value);
    exact(e, [
      'bvid',
      'part',
      'title',
      ...(Object.hasOwn(e, 'episodeId') ? ['episodeId'] : []),
    ]);
    const id = boundedText(e.bvid, 12),
      page = integer(e.part, 1, 10000),
      title = boundedText(e.title, 160),
      key = `${id}:${page}`;
    if (!/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(id) || !title || seen.has(key))
      throw new HelperError('invalid-reply');
    seen.add(key);
    const episodeId = Object.hasOwn(e, 'episodeId')
      ? decodeEpisodeId(e.episodeId)
      : undefined;
    if (episodeId && page !== 1) throw new HelperError('invalid-reply');
    return { bvid: id, part: page, title, ...(episodeId ? { episodeId } : {}) };
  });
  if (!seen.has(`${bvid}:${part}`)) throw new HelperError('invalid-reply');
  if (
    episodeId &&
    (episodes.some((e) => !e.episodeId) ||
      episodes.find((e) => e.bvid === bvid && e.part === part)?.episodeId !==
        episodeId)
  )
    throw new HelperError('invalid-reply');
  return { title: boundedText(v.title, 160), episodes };
}
export interface Segment {
  offset: number;
  length: number;
  time: number;
  end: number;
}
export function parseSelection(input: string, part: number): BilibiliSelection {
  const raw = input.trim();
  if (
    !Number.isSafeInteger(part) ||
    part < 1 ||
    part > 10000 ||
    raw.length > 2048
  )
    throw new LocalizedError(message('media.validSelection'));
  if (/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(raw)) return { bvid: raw, part };
  const bangumi = raw.match(/^(ss|ep)([1-9][0-9]{0,14})$/i);
  if (bangumi)
    return bangumi[1]!.toLowerCase() === 'ss'
      ? { seasonId: bangumi[2]!, part: 1 }
      : { episodeId: bangumi[2]!, part: 1 };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LocalizedError(message('media.validURL'));
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    !['www.bilibili.com', 'bilibili.com'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new LocalizedError(message('media.noShortLinks'));
  const episode = url.pathname.match(
    /^\/bangumi\/play\/(ss|ep)([1-9][0-9]{0,14})\/?$/,
  );
  if (episode)
    return episode[1] === 'ss'
      ? { seasonId: episode[2]!, part: 1 }
      : { episodeId: episode[2]!, part: 1 };
  const match = url.pathname.match(
    /^\/video\/(BV[1-9A-HJ-NP-Za-km-z]{10})\/?$/,
  );
  if (!match) throw new LocalizedError(message('media.canonicalURL'));
  const selected = url.searchParams.has('p')
    ? Number(url.searchParams.get('p'))
    : part;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > 10000)
    throw new LocalizedError(message('media.validPart'));
  return { bvid: match[1]!, part: selected };
}
function decodeEpisodeId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,14}$/.test(value))
    throw new HelperError('invalid-reply');
  return value;
}
export function selectionInput(selection: BilibiliSelection): string {
  if ('episodeId' in selection && selection.episodeId)
    return `ep${selection.episodeId}`;
  if ('seasonId' in selection) return `ss${selection.seasonId}`;
  return 'bvid' in selection ? selection.bvid : '';
}
export function decodeInfo(
  value: unknown,
  bvid: string,
  part: number,
  episodeId?: string,
): MediaInfo {
  const { handle: rawHandle, ...preview } = object(value);
  const handle = boundedText(rawHandle, 100);
  if (!/^h[0-9]+-[0-9-]+$/.test(handle)) throw new HelperError('invalid-reply');
  return {
    ...decodePreview(preview, {
      bvid,
      part,
      ...(episodeId ? { episodeId } : {}),
    }),
    handle,
  };
}
export function decodePreview(
  value: unknown,
  selection: BilibiliSelection,
): MediaPreview {
  const v = object(value);
  exact(v, [
    'bvid',
    'cid',
    'part',
    'duration',
    'title',
    'parts',
    'tracks',
    'quality',
    'qualities',
    ...(Object.hasOwn(v, 'episodeId') ? ['episodeId'] : []),
    ...(Object.hasOwn(v, 'playlist') ? ['playlist'] : []),
  ]);
  const bvid = boundedText(v.bvid, 12),
    part = selection.part;
  const episodeId = Object.hasOwn(v, 'episodeId')
    ? decodeEpisodeId(v.episodeId)
    : undefined;
  if (
    !/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(bvid) ||
    ('bvid' in selection && bvid !== selection.bvid) ||
    (('seasonId' in selection || 'episodeId' in selection) && !episodeId) ||
    ('episodeId' in selection && episodeId !== selection.episodeId) ||
    (episodeId && part !== 1) ||
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
      !(index === 0
        ? videoCodecRank(codec) >= 0
        : /^mp4a\.[A-Za-z0-9]+(?:\.[A-Za-z0-9]+)*$/.test(codec))
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
    ...(episodeId ? { episodeId } : {}),
    cid: v.cid,
    part,
    duration: v.duration,
    title: boundedText(v.title, 160),
    parts: integer(v.parts, part, 10000),
    tracks,
    ...(Object.hasOwn(v, 'playlist')
      ? { playlist: decodePlaylist(v.playlist, bvid, part, episodeId) }
      : {}),
  };
}
// Parse a bounded ISO-BMFF SIDX. Nested indexes and unsafe offsets are unsupported.
export function parseIndex(data: Uint8Array, offset: number): Segment[] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const fail = (): never => {
    throw new HelperError('invalid-index');
  };
  if (!Number.isSafeInteger(offset) || offset < 0) return fail();
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
