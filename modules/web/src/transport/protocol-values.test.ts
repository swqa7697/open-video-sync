import { expect, test } from 'vite-plus/test';

import { parseFrame } from './protocol-values';

test('raw frame validation retains exact JSON keys, integer literals and Unicode', () => {
  expect(parseFrame('{"v":1,"payload":{"name":"😀"}}')).toEqual({
    v: 1,
    payload: { name: '😀' },
  });
  expect(parseFrame('{"v":1,"payload":{"playback":{"rate":1.5}}}')).toEqual({
    v: 1,
    payload: { playback: { rate: 1.5 } },
  });
  expect(parseFrame('{"v":1,"payload":{"playback":{"rate":1.25e0}}}')).toEqual({
    v: 1,
    payload: { playback: { rate: 1.25 } },
  });
  for (const raw of [
    '{"v":1,"v":1}',
    '{"v":1,"p":{"x":1,"x":2}}',
    '{"v":1.0}',
    '{"v":1e0}',
    '{"v":1,"payload":{"positionMs":1.5}}',
    '{"v":1,"payload":{"rate":1.5,"rate":2}}',
    '{"v":1} {}',
    '{"x":"\\ud800"}',
  ])
    expect(() => parseFrame(raw)).toThrow();
});
