import { createHash } from 'node:crypto';
import { expect, test } from 'vite-plus/test';
import vectors from '../../../specs/fixtures/http-digests-v1.json';
import { consumeInvitation } from './invitation';

test('browser JSON encoding agrees with server HTTP request digests', () => {
  for (const vector of vectors)
    expect(createHash('sha256').update(JSON.stringify(vector.input)).digest('hex')).toBe(
      vector.digest,
    );
});
test('consumes invitation fragments before component startup', () => {
  history.replaceState(null, '', '/join#invite=AAECAwQFBgcICQoLDA0ODw');
  expect(consumeInvitation()).toBe('AAECAwQFBgcICQoLDA0ODw');
  expect(location.hash).toBe('');
  expect(consumeInvitation()).toBeUndefined();
  history.replaceState(null, '', '/join#invite=malformed');
  expect(consumeInvitation()).toBeUndefined();
  expect(location.hash).toBe('');
  history.replaceState(null, '', '/');
});
