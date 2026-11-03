import { afterEach, expect, test, vi } from 'vite-plus/test';

import { HelperBridge, helperRelease } from './bridge';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
test('a player accepts only its exact channel and disposal rejects pending replies', async () => {
  const posted: Record<string, unknown>[] = [];
  vi.spyOn(window, 'postMessage').mockImplementation((raw) => {
    posted.push(JSON.parse(raw as string) as Record<string, unknown>);
  });
  const bridge = new HelperBridge(),
    pending = bridge.call('session');
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  const request = posted[0]!;
  const reply = {
    channel: 'ovs-bilibili-response',
    client: request.client,
    id: request.id,
    ok: true,
    value: { loggedIn: true },
  };
  const deliver = (
    value: unknown,
    origin = location.origin,
    source: Window | null = window,
  ) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        origin,
        source,
        data: JSON.stringify(value),
      }),
    );
  deliver({ ...reply, client: 'b'.repeat(32) });
  deliver(reply, 'https://foreign.invalid');
  deliver(reply, location.origin, null);
  window.dispatchEvent(
    new MessageEvent('message', {
      origin: location.origin,
      source: window,
      data: JSON.stringify(reply).replace('"value":', '"value":null,"value":'),
    }),
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  deliver(reply);
  await expect(pending).resolves.toEqual({ loggedIn: true });
  // Failure replies become a few actionable groups; access failures report access_denied.
  for (const [code, status, reload, text] of [
    ['login-required', 'access_denied', false, 'Sign in to Bilibili'],
    ['access-expired', 'access_denied', false, 'refused access'],
    ['unsupported-codec', 'unsupported', false, 'cannot decode'],
    ['http-503', 'error', false, 'Could not reach Bilibili'],
    [
      'destination-denied',
      'error',
      false,
      'media address this helper cannot use',
    ],
    ['redirect-denied', 'error', false, 'media address this helper cannot use'],
    ['helper-incompatible', 'error', true, 'Update the OVS Bilibili helper'],
    ['segment-limit', 'error', false, 'cannot use'],
  ] as const) {
    const failing = bridge.call('session'),
      sent = posted.at(-1)!;
    deliver({
      channel: reply.channel,
      client: sent.client,
      id: sent.id,
      ok: false,
      error: code,
    });
    await expect(failing).rejects.toMatchObject({
      code,
      status,
      reload,
      message: expect.stringContaining(text),
    });
  }
  const pendingCalls = Array.from({ length: 4 }, () => bridge.call('session'));
  const rejected = pendingCalls.map((call) =>
    expect(call).rejects.toMatchObject({ name: 'AbortError' }),
  );
  bridge.seek('h1-1234', 1, 2);
  expect(posted.at(-1)).toMatchObject({
    op: 'seek',
    handle: 'h1-1234',
    generation: 1,
    seek: 2,
  });
  bridge.close(2);
  await Promise.all(rejected);
  expect(posted.at(-1)?.op).toBe('dispose');
});

test('slow resolution replies arrive without extending byte-request deadlines', async () => {
  vi.useFakeTimers();
  vi.spyOn(window, 'postMessage').mockImplementation((raw) => {
    const request = JSON.parse(raw as string) as Record<string, unknown>;
    setTimeout(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          source: window,
          origin: location.origin,
          data: JSON.stringify({
            channel: 'ovs-bilibili-response',
            client: request.client,
            id: request.id,
            ok: true,
            value: { completed: true },
          }),
        }),
      );
    }, 22000);
  });
  const bridge = new HelperBridge(),
    resolving = ['preview', 'open'].map((op) =>
      expect(bridge.call(op)).resolves.toEqual({ completed: true }),
    ),
    reading = expect(bridge.call('bytes')).rejects.toMatchObject({
      code: 'bridge-timeout',
    });
  await vi.advanceTimersByTimeAsync(15000);
  await reading;
  await vi.advanceTimersByTimeAsync(7000);
  await Promise.all(resolving);
  bridge.close(2, false);
});
test('startup waits for late manager registration without opening media first', async () => {
  vi.useFakeTimers();
  let requests = 0;
  let build: string | undefined = helperRelease.build;
  vi.spyOn(window, 'postMessage').mockImplementation((raw) => {
    const q = JSON.parse(raw as string) as Record<string, unknown>;
    if (q.op !== 'hello') return;
    if (++requests < 3) return;
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: location.origin,
        data: JSON.stringify({
          channel: 'ovs-bilibili-response',
          client: q.client,
          id: q.id,
          ok: true,
          value: {
            version: 1,
            helper: helperRelease.version,
            maxChunk: 262144,
            ...(build !== undefined ? { build } : {}),
          },
        }),
      }),
    );
  });
  const bridge = new HelperBridge(),
    hello = bridge.hello();
  await vi.advanceTimersByTimeAsync(1000);
  await expect(hello).resolves.toBeUndefined();
  expect(requests).toBe(3);
  // A legacy helper can share the same release number but lack episode metadata.
  build = undefined;
  await expect(bridge.hello()).rejects.toMatchObject({
    code: 'helper-incompatible',
  });
  build = '0'.repeat(64);
  await expect(bridge.hello()).rejects.toMatchObject({
    code: 'helper-incompatible',
  });
  build = 'invalid';
  await expect(bridge.hello()).rejects.toMatchObject({ code: 'invalid-reply' });
  bridge.close(2);
});
