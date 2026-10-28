import { expect, test } from 'vite-plus/test';
import { parseFrame } from './protocol-values';
test('raw frame validation retains exact JSON keys, integer literals and Unicode', () => {
  expect(parseFrame('{"v":1,"payload":{"name":"😀"}}')).toEqual({ v: 1, payload: { name: '😀' } });
  for (const raw of [
    '{"v":1,"v":1}',
    '{"v":1,"p":{"x":1,"x":2}}',
    '{"v":1.0}',
    '{"v":1e0}',
    '{"v":1} {}',
    '{"x":"\\ud800"}',
  ])
    expect(() => parseFrame(raw)).toThrow();
});
