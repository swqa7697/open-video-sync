import { object, shape } from './api';

export interface HistoryVideo {
  kind: 'bilibili';
  bvid: string;
  cid: string;
  part: number;
  episodeId?: string;
  title: string;
  episodeTitle: string;
}
export interface HistoryEntry {
  entryId: string;
  video: HistoryVideo;
  lastPlayedAtMs: number;
}
export interface WatchHistory {
  entries: HistoryEntry[];
  recordingEnabled: boolean;
}

function historyText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    Array.from(value).length > 160 ||
    new TextEncoder().encode(value).byteLength > 640
  )
    throw new Error('Invalid history response.');
  return value;
}
export function decodeHistoryVideo(value: unknown): HistoryVideo {
  const v = object(value);
  shape(v, [
    'kind',
    'bvid',
    'cid',
    'part',
    'title',
    'episodeTitle',
    ...(Object.hasOwn(v, 'episodeId') ? ['episodeId'] : []),
  ]);
  if (
    v.kind !== 'bilibili' ||
    typeof v.bvid !== 'string' ||
    !/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(v.bvid) ||
    typeof v.cid !== 'string' ||
    !/^[1-9][0-9]{0,19}$/.test(v.cid) ||
    typeof v.part !== 'number' ||
    !Number.isSafeInteger(v.part) ||
    v.part < 1 ||
    v.part > 10000 ||
    (Object.hasOwn(v, 'episodeId') &&
      (typeof v.episodeId !== 'string' ||
        !/^[1-9][0-9]{0,14}$/.test(v.episodeId) ||
        v.part !== 1))
  )
    throw new Error('Invalid history response.');
  return {
    kind: 'bilibili',
    bvid: v.bvid,
    cid: v.cid,
    part: v.part,
    ...(typeof v.episodeId === 'string' ? { episodeId: v.episodeId } : {}),
    title: historyText(v.title),
    episodeTitle: historyText(v.episodeTitle),
  };
}
export function decodeWatchHistory(value: unknown): WatchHistory {
  const v = object(value);
  shape(v, ['entries', 'recordingEnabled']);
  if (
    !Array.isArray(v.entries) ||
    v.entries.length > 100 ||
    typeof v.recordingEnabled !== 'boolean'
  )
    throw new Error('Invalid history response.');
  const ids = new Set<string>();
  const entries = v.entries.map((value) => {
    const entry = object(value);
    shape(entry, ['entryId', 'video', 'lastPlayedAtMs']);
    if (
      typeof entry.entryId !== 'string' ||
      !/^[a-f0-9]{32}$/.test(entry.entryId) ||
      ids.has(entry.entryId) ||
      typeof entry.lastPlayedAtMs !== 'number' ||
      !Number.isSafeInteger(entry.lastPlayedAtMs) ||
      entry.lastPlayedAtMs < 0
    )
      throw new Error('Invalid history response.');
    ids.add(entry.entryId);
    return {
      entryId: entry.entryId,
      video: decodeHistoryVideo(entry.video),
      lastPlayedAtMs: entry.lastPlayedAtMs,
    };
  });
  return { entries, recordingEnabled: v.recordingEnabled };
}
export function historyVideoURL(video: HistoryVideo): string {
  return video.episodeId
    ? `https://www.bilibili.com/bangumi/play/ep${video.episodeId}`
    : `https://www.bilibili.com/video/${video.bvid}?p=${video.part}`;
}
