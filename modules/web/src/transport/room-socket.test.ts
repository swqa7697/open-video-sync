import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import { translate } from '../i18n';
import { FakeSocket, roomFixture } from '../test-support/room';
import {
  RoomSocket,
  type EndReason,
  type ProbeResult,
  type SocketEvents,
} from './room-socket';

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function harness(results: ProbeResult[]) {
  const ended: EndReason[] = [],
    errors: string[] = [],
    signals: AbortSignal[] = [],
    pending: unknown[] = [];
  const events: SocketEvents = {
    snapshot() {},
    status() {},
    lease() {},
    pending: (command) => pending.push(command),
    error: (message) => errors.push(translate(message)),
    ended: (reason) => ended.push(reason),
  };
  const probe = vi.fn((signal: AbortSignal) => {
    signals.push(signal);
    return Promise.resolve(results.shift() ?? 'unreachable');
  });
  const socket = new RoomSocket(roomFixture.roomId, events, probe);
  return { socket, ended, errors, probe, signals, pending };
}

test.each([
  ['session_ended', 'session_ended'],
  ['room_unavailable', 'room_unavailable'],
] as const)(
  'a refused upgrade with an OVS %s answer stops retrying',
  async (result, reason) => {
    const { socket, ended } = harness([result]);
    socket.start();
    FakeSocket.instances[0]!.close();
    await vi.advanceTimersByTimeAsync(20000);
    expect(ended).toEqual([reason]);
    expect(FakeSocket.instances).toHaveLength(1);
    socket.dispose();
  }
);

test('unreachable and refused upgrades keep the backoff and explain repeated refusals once', async () => {
  const { socket, ended, errors, probe } = harness([
    'unreachable',
    'reachable',
    'reachable',
    'reachable',
  ]);
  socket.start();
  for (let attempt = 0; attempt < 4; attempt++) {
    FakeSocket.instances.at(-1)!.close();
    await vi.advanceTimersByTimeAsync(20000);
  }
  expect(probe).toHaveBeenCalledTimes(4);
  expect(FakeSocket.instances).toHaveLength(5);
  expect(ended).toEqual([]);
  expect(
    errors.filter((e) => e.includes('connection is refused'))
  ).toHaveLength(1);
  // Admission clears the refusal explanation; a welcomed connection that drops reconnects without probing.
  FakeSocket.instances.at(-1)!.welcome();
  expect(errors.at(-1)).toBe('');
  FakeSocket.instances.at(-1)!.close();
  await vi.advanceTimersByTimeAsync(20000);
  expect(probe).toHaveBeenCalledTimes(4);
  expect(FakeSocket.instances).toHaveLength(6);
  socket.dispose();
});

test.each([
  ['session.replaced', { reason: 'connection_replaced' }, [], 'replaced'],
  ['room.closed', { roomId: roomFixture.roomId, revision: 2 }, [], 'closed'],
  [
    'session.replaced',
    { reason: 'session_revoked' },
    ['room_unavailable'],
    'removed',
  ],
  [
    'session.replaced',
    { reason: 'session_revoked' },
    ['session_ended'],
    'session_ended',
  ],
  ['session.replaced', { reason: 'session_revoked' }, ['reachable'], 'revoked'],
] as const)(
  'lifecycle %s %o with probe answers %j ends as %s without reconnecting',
  async (type, payload, results, reason) => {
    const { socket, ended, pending } = harness([...results]);
    socket.start();
    const connection = FakeSocket.instances[0]!;
    connection.welcome();
    // An ended connection also ends a command still awaiting its result.
    socket.command({ action: 'play' });
    expect(pending.at(-1)).toBeDefined();
    connection.frame(type, payload);
    await vi.advanceTimersByTimeAsync(20000);
    expect(ended).toEqual([reason]);
    expect(pending.at(-1)).toBeUndefined();
    expect(socket.active).toBe(false);
    expect(FakeSocket.instances).toHaveLength(1);
    socket.dispose();
  }
);

test('disposal aborts an in-flight refusal probe and ignores its answer', async () => {
  const { socket, ended, signals } = harness([]);
  let answer: (value: ProbeResult) => void = () => {};
  const probe = new Promise<ProbeResult>((resolve) => (answer = resolve));
  const pending = new RoomSocket(
    roomFixture.roomId,
    {
      snapshot() {},
      status() {},
      lease() {},
      pending() {},
      error() {},
      ended: (reason) => ended.push(reason),
    },
    (signal) => {
      signals.push(signal);
      return probe;
    }
  );
  pending.start();
  FakeSocket.instances.at(-1)!.close();
  pending.dispose();
  answer('room_unavailable');
  await vi.advanceTimersByTimeAsync(20000);
  expect(signals[0]?.aborted).toBe(true);
  expect(ended).toEqual([]);
  socket.dispose();
});
