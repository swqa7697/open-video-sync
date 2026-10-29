import { afterEach, expect, test, vi } from 'vite-plus/test';
import { HelperBridge } from './bridge';
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
  const deliver = (value: unknown, origin = location.origin, source: Window | null = window) =>
    window.dispatchEvent(
      new MessageEvent('message', { origin, source, data: JSON.stringify(value) }),
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
  const pendingCalls = Array.from({ length: 4 }, () => bridge.call('session'));
  const rejected = pendingCalls.map((call) =>
    expect(call).rejects.toMatchObject({ name: 'AbortError' }),
  );
  bridge.close(2);
  await Promise.all(rejected);
  expect(posted.at(-1)?.op).toBe('dispose');
});

test('startup waits for late manager registration without opening media first', async () => {
  vi.useFakeTimers();
  let requests = 0;
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
          value: { version: 1, helper: '1.0.0', maxChunk: 262144 },
        }),
      }),
    );
  });
  const bridge = new HelperBridge(),
    hello = bridge.hello();
  await vi.advanceTimersByTimeAsync(1000);
  await expect(hello).resolves.toBeUndefined();
  expect(requests).toBe(3);
  bridge.close(2);
});
