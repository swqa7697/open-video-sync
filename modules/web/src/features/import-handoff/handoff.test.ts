import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import {
  ImportHandoff,
  type HandoffChannel,
  type ImportRequest,
  type ImportResult,
} from './handoff';

class Channel implements HandoffChannel {
  static instances = new Set<Channel>();
  listeners = new Set<(event: MessageEvent<unknown>) => void>();
  closed = false;
  constructor() {
    Channel.instances.add(this);
  }
  addEventListener(
    _type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners.add(listener);
  }
  removeEventListener(
    _type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    this.listeners.delete(listener);
  }
  postMessage(message: unknown): void {
    for (const channel of Channel.instances)
      if (channel !== this)
        for (const listener of channel.listeners)
          listener(
            new MessageEvent('message', { data: structuredClone(message) }),
          );
  }
  close(): void {
    this.closed = true;
    Channel.instances.delete(this);
  }
}

const room = {
  roomId: 'a'.repeat(32),
  epoch: 'b'.repeat(32),
  mediaGeneration: 1,
  expectedRevision: 2,
};
const media = {
  kind: 'bilibili' as const,
  bvid: 'BV1TESTaaaaa',
  cid: '1',
  part: 1,
  durationMs: 10000,
};
const handoffs: ImportHandoff[] = [];
function handoff(options: ConstructorParameters<typeof ImportHandoff>[0] = {}) {
  const instance = new ImportHandoff(options, () => new Channel());
  handoffs.push(instance);
  return instance;
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const item of handoffs.splice(0)) item.dispose();
  for (const item of Channel.instances) item.close();
  vi.useRealTimers();
});

test('discovery leaves execution untouched and ignores inactive or other-room pages', async () => {
  const execute = vi.fn(async (): Promise<ImportResult> => ({
    status: 'accepted',
  }));
  let active = false;
  handoff({ room: () => (active ? room : undefined), execute });
  handoff({ room: () => ({ ...room, roomId: 'c'.repeat(32) }), execute });
  const client = handoff();
  const absent = client.discover(room.roomId);
  await vi.advanceTimersByTimeAsync(1200);
  expect(await absent).toBeUndefined();
  active = true;
  expect(await client.discover(room.roomId)).toMatchObject(room);
  expect(execute).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test('a changed room or disconnected owner rejects an old selection before execution', async () => {
  let current: typeof room | undefined = { ...room };
  const execute = vi.fn(async (): Promise<ImportResult> => ({
    status: 'accepted',
  }));
  handoff({ room: () => current, execute });
  const client = handoff();
  const destination = (await client.discover(room.roomId))!;
  current = { ...room, mediaGeneration: 2, expectedRevision: 3 };
  expect(await client.submit(destination, media)).toEqual({ status: 'stale' });
  current = undefined;
  expect(await client.submit(destination, media)).toEqual({
    status: 'unavailable',
  });
  expect(execute).not.toHaveBeenCalled();
});

test('server acceptance is awaited and an exact retry reuses its result after the room changes', async () => {
  let accept: (value: ImportResult) => void = () => {};
  const result = new Promise<ImportResult>((resolve) => (accept = resolve));
  let current = { ...room };
  const execute = vi.fn((_request: ImportRequest) => result);
  handoff({ room: () => current, execute });
  const client = handoff(),
    secondClient = handoff();
  const destination = (await client.discover(room.roomId))!;
  const requestId = 'd'.repeat(32);
  const first = client.submit(destination, media, requestId);
  const duplicate = secondClient.submit(destination, media, requestId);
  await vi.advanceTimersByTimeAsync(0);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute.mock.calls[0]![0].requestId).toBe(requestId);
  current = { ...room, expectedRevision: 3, mediaGeneration: 2 };
  accept({ status: 'accepted' });
  expect(await first).toEqual({ status: 'accepted' });
  expect(await duplicate).toEqual({ status: 'accepted' });
  expect(await client.submit(destination, media, requestId)).toEqual({
    status: 'accepted',
  });
  expect(execute).toHaveBeenCalledTimes(1);
});

test('an uncertain retry retains the original command identity and cannot change the payload', async () => {
  const execute = vi.fn(
    async (_request: ImportRequest): Promise<ImportResult> => ({
      status: execute.mock.calls.length === 1 ? 'outcome_unknown' : 'accepted',
    }),
  );
  handoff({ room: () => room, execute });
  const client = handoff();
  const destination = (await client.discover(room.roomId))!;
  const requestId = 'd'.repeat(32);
  expect(await client.submit(destination, media, requestId)).toEqual({
    status: 'outcome_unknown',
  });
  expect(await client.submit(destination, media, requestId)).toEqual({
    status: 'accepted',
  });
  expect(execute.mock.calls.map(([request]) => request.requestId)).toEqual([
    requestId,
    requestId,
  ]);
  const changed = client.submit(destination, { ...media, part: 2 }, requestId);
  await vi.advanceTimersByTimeAsync(15000);
  expect(await changed).toEqual({ status: 'outcome_unknown' });
  expect(execute).toHaveBeenCalledTimes(2);
});

test('unknown or malformed messages cannot submit media or settle another request', async () => {
  const execute = vi.fn(async (): Promise<ImportResult> => ({
    status: 'accepted',
  }));
  handoff({ room: () => room, execute });
  const client = handoff();
  const destination = (await client.discover(room.roomId))!;
  const stranger = new Channel();
  const envelope = {
    v: 1,
    kind: 'submit',
    requestId: 'd'.repeat(32),
    target: destination,
    media,
  };
  for (const invalid of [
    { ...envelope, v: 2 },
    { ...envelope, secret: 'excluded' },
    { ...envelope, requestId: 'invalid' },
    { ...envelope, target: { ...destination, tabId: 'f'.repeat(32) } },
    { ...envelope, target: { ...destination, expectedRevision: 0 } },
    { ...envelope, media: { ...media, cookie: 'excluded' } },
  ])
    stranger.postMessage(invalid);
  await vi.advanceTimersByTimeAsync(0);
  expect(execute).not.toHaveBeenCalled();
  expect(() => client.submit(destination, { ...media, part: 0 })).toThrow();
});

test('submission timeout stays uncertain; abort and disposal release listeners and timers', async () => {
  handoff({ room: () => room, execute: () => new Promise(() => {}) });
  const client = handoff();
  const destination = (await client.discover(room.roomId))!;
  const pending = client.submit(destination, media);
  await vi.advanceTimersByTimeAsync(15000);
  expect(await pending).toEqual({ status: 'outcome_unknown' });
  const abort = new AbortController();
  const aborted = client.submit(destination, media, undefined, abort.signal);
  abort.abort();
  expect(await aborted).toEqual({ status: 'outcome_unknown' });
  const discovery = client.discover('f'.repeat(32));
  const submission = client.submit(destination, media);
  const channel = [...Channel.instances].at(-1)!;
  client.dispose();
  expect(await discovery).toBeUndefined();
  expect(await submission).toEqual({ status: 'outcome_unknown' });
  expect(channel.listeners.size).toBe(0);
  expect(channel.closed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

test('a browser without BroadcastChannel retains the explicit room-opening path', async () => {
  const client = new ImportHandoff({}, () => {
    throw Error('unavailable');
  });
  handoffs.push(client);
  expect(await client.discover(room.roomId)).toBeUndefined();
  expect(
    await client.submit({ ...room, tabId: 'c'.repeat(32) }, media),
  ).toEqual({ status: 'unavailable' });
});
