import { expect, test } from 'vite-plus/test';

import { parseFrame } from './protocol-values';

test('raw frame validation retains exact JSON keys, integer literals and Unicode', () => {
  expect(parseFrame('{"v":2,"payload":{"name":"😀"}}')).toEqual({
    v: 2,
    payload: { name: '😀' },
  });
  for (const raw of [
    '{"v":2,"v":2}',
    '{"v":2,"p":{"x":1,"x":2}}',
    '{"v":2.0}',
    '{"v":2e0}',
    '{"v":2} {}',
    '{"x":"\\ud800"}',
  ])
    expect(() => parseFrame(raw)).toThrow();
});
