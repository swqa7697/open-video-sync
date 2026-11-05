import { expect, test } from 'vite-plus/test';

import { parseFrame } from './protocol-values';

test('raw frame validation retains exact JSON keys, integer literals and Unicode', () => {
  expect(parseFrame('{"v":2,"payload":{"name":"😀"}}')).toEqual({
    v: 2,
    payload: { name: '😀' },
  });
  expect(parseFrame('{"v":2,"payload":{"playback":{"rate":1.5}}}')).toEqual({
    v: 2,
    payload: { playback: { rate: 1.5 } },
  });
  expect(parseFrame('{"v":2,"payload":{"playback":{"rate":1.25e0}}}')).toEqual({
    v: 2,
    payload: { playback: { rate: 1.25 } },
  });
  for (const raw of [
    '{"v":2,"v":2}',
    '{"v":2,"p":{"x":1,"x":2}}',
    '{"v":2.0}',
    '{"v":2e0}',
    '{"v":2,"payload":{"positionMs":1.5}}',
    '{"v":2,"payload":{"rate":1.5,"rate":2}}',
    '{"v":2} {}',
    '{"x":"\\ud800"}',
  ])
    expect(() => parseFrame(raw)).toThrow();
});
