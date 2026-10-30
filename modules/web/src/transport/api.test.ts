import { createHash } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import vectors from '../../../../specs/fixtures/http-digests-v2.json';
import { NetworkError, request, ResponseError } from './api';
import { consumeInvitation } from './invitation';

afterEach(() => vi.unstubAllGlobals());

test('browser JSON encoding agrees with server HTTP request digests', () => {
  for (const vector of vectors)
    expect(
      createHash('sha256').update(JSON.stringify(vector.input)).digest('hex')
    ).toBe(vector.digest);
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
test('classifies transport failures separately from unusable OVS answers', async () => {
  const signal = new AbortController().signal;
  const failing = (status: number) =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.error(new TypeError('connection reset'));
        },
      }),
      { status }
    );
  // A connection that drops while the body streams is a network failure, not bad data.
  vi.stubGlobal('fetch', () => Promise.resolve(failing(200)));
  await expect(
    request('/me', 'GET', '', undefined, signal)
  ).rejects.toBeInstanceOf(NetworkError);
  vi.stubGlobal('fetch', () =>
    Promise.resolve(new Response('<html>Bad gateway</html>', { status: 502 }))
  );
  await expect(
    request('/me', 'GET', '', undefined, signal)
  ).rejects.toMatchObject({ status: 502 });
  vi.stubGlobal('fetch', () =>
    Promise.resolve(new Response('<html>ok</html>', { status: 200 }))
  );
  await expect(
    request('/me', 'GET', '', undefined, signal)
  ).rejects.toBeInstanceOf(ResponseError);
});
