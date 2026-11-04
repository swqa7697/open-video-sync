import {
  parseSelection,
  type BilibiliSelection,
} from '../../player/bilibili/media';

export interface ImportEntry {
  selection?: BilibiliSelection;
  invalid?: boolean;
}

function decodeEntry(value: unknown): BilibiliSelection {
  if (typeof value !== 'string' || !value || value.length > 256)
    throw new Error('invalid import');
  const params = new URLSearchParams(value);
  const keys = [...params.keys()];
  const identifier = ['bvid', 'episodeId', 'seasonId'].filter((key) =>
    params.has(key),
  );
  const rawPart = params.get('part') ?? '';
  if (
    keys.length !== 3 ||
    new Set(keys).size !== 3 ||
    identifier.length !== 1 ||
    keys.some((key) => !['v', 'part', ...identifier].includes(key)) ||
    params.get('v') !== '1' ||
    !/^[1-9][0-9]{0,4}$/.test(rawPart)
  )
    throw new Error('invalid import');
  const key = identifier[0]!;
  const id = params.get(key)!;
  if (key === 'bvid' && !/^BV[1-9A-HJ-NP-Za-km-z]{10}$/.test(id))
    throw new Error('invalid import');
  if (key !== 'bvid' && (!/^[1-9][0-9]{0,14}$/.test(id) || rawPart !== '1'))
    throw new Error('invalid import');
  return parseSelection(
    key === 'bvid' ? id : `${key === 'episodeId' ? 'ep' : 'ss'}${id}`,
    Number(rawPart),
  );
}

// Read before mounting provider components. Retain only validated identifiers in
// this history entry so helper installation and reload can resume the import.
export function consumeImport(): ImportEntry | undefined {
  if (location.pathname !== '/import') return;
  const state: unknown = history.state;
  const raw: unknown = location.hash
    ? location.hash.slice(1)
    : state && typeof state === 'object' && 'pendingImport' in state
      ? state.pendingImport
      : undefined;
  let entry: ImportEntry;
  try {
    if (location.search) throw new Error('invalid import');
    entry = { selection: decodeEntry(raw) };
  } catch {
    entry = { invalid: true };
  }
  history.replaceState(
    entry.selection ? { pendingImport: raw } : null,
    '',
    '/import',
  );
  return entry;
}

export function clearImport(): void {
  if (location.pathname === '/import')
    history.replaceState(null, '', '/import');
}
