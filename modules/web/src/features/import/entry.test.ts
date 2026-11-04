import { afterEach, expect, test } from 'vite-plus/test';

import { clearImport, consumeImport } from './entry';

afterEach(() => history.replaceState(null, '', '/'));

test.each([
  ['v=1&bvid=BV1TESTaaaaa&part=2', { bvid: 'BV1TESTaaaaa', part: 2 }],
  [
    'v=1&episodeId=9000000000011&part=1',
    { episodeId: '9000000000011', part: 1 },
  ],
  ['v=1&seasonId=9000000000021&part=1', { seasonId: '9000000000021', part: 1 }],
])(
  'imports bounded identifiers and survives a helper-install reload: %s',
  (hash, selection) => {
    history.replaceState(null, '', `/import#${hash}`);
    expect(consumeImport()).toEqual({ selection });
    expect(location.hash).toBe('');
    expect(consumeImport()).toEqual({ selection });
    clearImport();
    expect(consumeImport()).toEqual({ invalid: true });
  },
);

test.each([
  'v=2&bvid=BV1TESTaaaaa&part=1',
  'v=1&bvid=BV1TESTaaaaa&part=1&part=2',
  'v=1&bvid=BV1TESTaaaaa',
  'v=1&bvid=BV1TESTaaaaa&part=0',
  'v=1&bvid=BV1TESTaaaaa&part=10001',
  'v=1&bvid=BV1TESTaaaaa&part=1&url=https://secret.invalid',
  'v=1&episodeId=9000000000011&part=2',
  'v=1&seasonId=0&part=1',
  'v=1&bvid=ep9000000000011&part=1',
  'v=1&bvid=https://www.bilibili.com/video/BV1TESTaaaaa&part=1',
])('rejects malformed import data before retaining history: %s', (hash) => {
  history.replaceState(null, '', `/import#${hash}`);
  expect(consumeImport()).toEqual({ invalid: true });
  expect(location.hash).toBe('');
  expect(history.state).toBeNull();
});

test('does not consume invitation entry and revalidates restored history data', () => {
  history.replaceState(null, '', '/join#invite=synthetic');
  expect(consumeImport()).toBeUndefined();
  expect(location.hash).toBe('#invite=synthetic');
  history.replaceState(
    { pendingImport: { bvid: 'BV1TESTaaaaa' } },
    '',
    '/import',
  );
  expect(consumeImport()).toEqual({ invalid: true });
  expect(history.state).toBeNull();
  history.replaceState(
    null,
    '',
    '/import?video=untrusted#v=1&bvid=BV1TESTaaaaa&part=1',
  );
  expect(consumeImport()).toEqual({ invalid: true });
  expect(location.search).toBe('');
});
