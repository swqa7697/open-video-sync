import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import PlayerPanel from './PlayerPanel.vue';
import { decodeSnapshot } from '../../transport/api';
import { FakeSocket, roomFixture } from '../../test-support/room';

vi.mock('../../player/fingerprint', () => ({ localFingerprint: async () => 'f'.repeat(64) }));

const self = 'e'.repeat(32);
// The host selected a 9-byte local file; this page is a participant with the same file.
const room = (phase: 'playing' | 'paused' | 'waiting', revision: number) => ({
  ...roomFixture,
  revision,
  selfMemberId: self,
  mediaGeneration: 1,
  media: {
    kind: 'local',
    fingerprintVersion: 1,
    digest: 'f'.repeat(64),
    sizeBytes: 9,
    durationMs: 10000,
  },
  barrier:
    phase === 'waiting'
      ? {
          barrierId: 'a'.repeat(32),
          requiredMemberIds: [self],
          reason: 'play',
          targetPositionMs: 0,
          deadlineServerMs: 30000,
        }
      : null,
  playback: {
    phase,
    positionMs: phase === 'waiting' ? 0 : 1000,
    anchorServerMs: 0,
    desiredPlaying: phase !== 'paused',
  },
  members: [
    { ...roomFixture.members[0], presence: 'connected' },
    {
      memberId: self,
      displayName: 'Viewer',
      role: 'participant',
      presence: 'connected',
      readiness: null,
    },
  ],
});
// Settles play() as browsers do: at once with enough data; otherwise it fires waiting and stays
// pending until pause() cancels it with AbortError. A seek leaves too little data to play.
function fakeMedia(video: HTMLVideoElement) {
  const media = { readyState: 4, paused: true, seeking: false, blocked: false, interrupted: 0 };
  let position = 0,
    pending: Array<(error: DOMException) => void> = [];
  Object.defineProperties(video, {
    duration: { value: 10 },
    videoWidth: { value: 640 },
    readyState: { get: () => media.readyState },
    paused: { get: () => media.paused },
    seeking: { get: () => media.seeking },
    currentTime: {
      get: () => position,
      set: (value: number) => {
        position = value;
        media.seeking = true;
        media.readyState = 1;
        setTimeout(() => {
          media.seeking = false;
          media.readyState = 2;
          video.dispatchEvent(new Event('seeked'));
        });
      },
    },
  });
  video.load = () => {};
  video.play = () => {
    if (media.blocked) return Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
    media.paused = false;
    if (media.readyState >= 3) return Promise.resolve();
    setTimeout(() => video.dispatchEvent(new Event('waiting')));
    return new Promise<void>((_, reject) => pending.push(reject));
  };
  video.pause = () => {
    media.paused = true;
    const cancelled = pending;
    pending = [];
    setTimeout(() => {
      for (const reject of cancelled) reject(new DOMException('Interrupted', 'AbortError'));
      media.interrupted += cancelled.length;
    });
  };
  return { media, pending: () => pending.length };
}
async function join(phase: 'playing' | 'waiting') {
  const wrapper = mount(PlayerPanel, {
    props: { room: decodeSnapshot(room(phase, 1)) },
    attachTo: document.body,
  });
  const socket = FakeSocket.instances[0]!;
  socket.readyState = 1;
  socket.frame('session.welcome', { connectionId: 'c'.repeat(32), snapshot: room(phase, 1) });
  await flushPromises();
  const video = wrapper.get('video').element;
  return { wrapper, socket, video, ...fakeMedia(video) };
}
async function select(wrapper: VueWrapper, video: HTMLVideoElement): Promise<void> {
  const input = wrapper.get('#local-video');
  Object.defineProperty(input.element, 'files', {
    value: [new File(['synthetic'], 'private.webm')],
  });
  await input.trigger('change');
  video.dispatchEvent(new Event('loadeddata'));
  await flushPromises();
}
const reported = (socket: FakeSocket) =>
  socket.sent
    .map((text) => JSON.parse(text) as { type: string; payload: { status?: string } })
    .filter((frame) => frame.type === 'member.readiness')
    .map((frame) => frame.payload.status);
beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  const nativeURL = URL;
  vi.stubGlobal(
    'URL',
    class extends nativeURL {
      static createObjectURL(): string {
        return 'blob:fixture-panel';
      }
      static revokeObjectURL(): void {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

test('a room pause that interrupts a pending play is not a player failure', async () => {
  const { wrapper, socket, video, media, pending } = await join('playing');
  // Calibrate the clock with zero offset so the controller follows the playing room.
  for (const text of socket.sent) {
    const ping = JSON.parse(text) as { type: string; requestId: string; payload: object };
    if (ping.type !== 'clock.ping') continue;
    const sent = (ping.payload as { clientSendMs: number }).clientSendMs;
    socket.onmessage?.({
      data: JSON.stringify({
        v: 2,
        type: 'clock.pong',
        requestId: ping.requestId,
        payload: { clientSendMs: sent, serverReceiveMs: sent, serverSendMs: sent },
      }),
    });
  }
  await select(wrapper, video);
  // The controller seeks to the room position, and play() waits for data there.
  await vi.waitFor(() => expect(pending()).toBe(1), { timeout: 2000 });
  socket.frame('room.snapshot', room('paused', 2));
  await vi.waitFor(() => expect(media.interrupted).toBe(1));
  await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="media-status"]').attributes('data-state')).toBe('buffering');
  expect(reported(socket)).not.toContain('error');
  wrapper.unmount();
});
test('an interrupted Enable playback shows no failure and keeps focus in the player', async () => {
  const { wrapper, socket, video, media } = await join('waiting');
  media.blocked = true;
  await select(wrapper, video);
  await vi.waitFor(() =>
    expect(wrapper.get('[data-testid="media-status"]').attributes('data-state')).toBe(
      'gesture_required',
    ),
  );
  const enable = wrapper.findAll('button').find((button) => button.text() === 'Enable playback')!;
  // Permission arrives with the gesture, but the data no longer covers the wait position.
  media.blocked = false;
  media.readyState = 2;
  (enable.element as HTMLButtonElement).focus();
  await enable.trigger('click');
  // Waiting reports buffering, so the wait's reconcile pauses and cancels the user's play.
  await vi.waitFor(() => expect(media.interrupted).toBe(1));
  await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(wrapper.get('[data-testid="media-status"]').attributes('data-state')).toBe('buffering');
  expect(document.activeElement?.id).toBe('player-title');
  expect(reported(socket)).not.toContain('error');
  wrapper.unmount();
});
