import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import PlayerPanel from './PlayerPanel.vue';
import { decodeSnapshot } from '../../transport/api';
import { FakeSocket, roomFixture } from '../../test-support/room';
import { BilibiliAdapter } from '../../player/bilibili/adapter';
import type { MediaInfo } from '../../player/bilibili/media';

vi.mock('../../player/fingerprint', () => ({
  localFingerprint: async () => 'f'.repeat(64),
}));

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
  const media = {
    readyState: 4,
    paused: true,
    seeking: false,
    blocked: false,
    interrupted: 0,
  };
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
    if (media.blocked)
      return Promise.reject(new DOMException('Blocked', 'NotAllowedError'));
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
      for (const reject of cancelled)
        reject(new DOMException('Interrupted', 'AbortError'));
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
  socket.frame('session.welcome', {
    connectionId: 'c'.repeat(32),
    snapshot: room(phase, 1),
  });
  await flushPromises();
  const video = wrapper.get('video').element;
  return { wrapper, socket, video, ...fakeMedia(video) };
}
async function select(
  wrapper: VueWrapper,
  video: HTMLVideoElement
): Promise<void> {
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
    .map(
      (text) =>
        JSON.parse(text) as { type: string; payload: { status?: string } }
    )
    .filter((frame) => frame.type === 'member.readiness')
    .map((frame) => frame.payload.status);
beforeEach(() => {
  localStorage.clear();
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
    }
  );
});

// A component scenario owns the quality menu and browser preference lifecycle. The
// helper regressions separately verify highest/fallback selection from synthetic metadata.
test('quality choices use a small menu and survive player recreation', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('hover: hover'),
  }));
  const media = {
    kind: 'bilibili' as const,
    bvid: 'BV1hf4y1N75G',
    cid: '1',
    part: 1,
    durationMs: 10000,
  };
  const snapshot = decodeSnapshot({
    ...roomFixture,
    mediaGeneration: 1,
    media,
    playback: { ...roomFixture.playback, phase: 'paused' },
  });
  let selectedQuality = 120;
  vi.spyOn(BilibiliAdapter.prototype, 'load').mockImplementation(
    async (_bvid, _part, _signal, quality) => {
      selectedQuality = quality ?? 120;
      return media;
    }
  );
  vi.spyOn(BilibiliAdapter.prototype, 'mediaInfo', 'get').mockImplementation(
    (): MediaInfo => ({
      ...media,
      duration: 10,
      title: 'Synthetic quality selection',
      parts: 1,
      quality: selectedQuality,
      qualities: [120, 80],
      handle: 'h1-1234',
      tracks: [],
    })
  );
  vi.spyOn(BilibiliAdapter.prototype, 'getState').mockReturnValue({
    positionMs: 0,
    durationMs: 10000,
    paused: true,
    seeking: false,
    status: 'ready',
  });
  async function open() {
    const wrapper = mount(PlayerPanel, {
      props: { room: snapshot },
      attachTo: document.body,
    });
    fakeMedia(wrapper.get('video').element);
    const socket = FakeSocket.instances.at(-1)!;
    socket.readyState = 1;
    socket.frame('session.welcome', { connectionId: 'c'.repeat(32), snapshot });
    await flushPromises();
    return wrapper;
  }
  let wrapper = await open();
  try {
    expect(wrapper.get('.quality-trigger').text()).toBe('4K');
    await wrapper.get('.quality-trigger').trigger('click');
    expect(wrapper.find('.player-menu:not(.quality-menu)').exists()).toBe(
      false
    );
    const option = wrapper
      .findAll('[role="menuitemradio"]')
      .find((node) => node.text() === '1080p')!;
    await option.trigger('click');
    await flushPromises();
    expect(wrapper.get('.quality-trigger').text()).toBe('1080p');
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    wrapper.unmount();
    wrapper = await open();
    expect(wrapper.get('.quality-trigger').text()).toBe('1080p');
    await wrapper.get('.quality-trigger').trigger('click');
    expect(wrapper.get('[aria-checked="true"]').text()).toBe('1080p');
    await wrapper.get('[role="menu"]').trigger('keydown', { key: 'Escape' });
    expect(document.activeElement).toBe(
      wrapper.get('.quality-trigger').element
    );
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Player settings"]').exists()).toBe(false);
    const trigger = wrapper.get('.danmaku-toggle');
    await wrapper
      .get('.danmaku-control')
      .trigger('pointerenter', { pointerType: 'mouse' });
    await flushPromises();
    expect(wrapper.get('.danmaku-menu').text()).toContain('Danmaku settings');
    await wrapper.get('input[id$="-density"]').setValue(12);
    await wrapper.get('input[id$="-size"]').setValue(24);
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-density"]').element.value
    ).toBe('12');
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-size"]').element.value
    ).toBe('24');
    await trigger.trigger('click');
    expect(trigger.attributes('aria-pressed')).toBe('false');
    expect(wrapper.get('.danmaku-menu').text()).toContain('Hidden by you');
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-density"]').element.value
    ).toBe('12');
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-size"]').element.value
    ).toBe('24');
    await wrapper
      .get('.danmaku-control')
      .trigger('pointerleave', { pointerType: 'mouse' });
    await vi.waitFor(() =>
      expect(wrapper.find('.danmaku-menu').exists()).toBe(false)
    );
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(document.activeElement).toBe(
      wrapper.get('input[id$="-density"]').element
    );
    await wrapper.get('.danmaku-menu').trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('.danmaku-menu').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
  } finally {
    wrapper.unmount();
  }
});
afterEach(() => vi.unstubAllGlobals());

test('a room pause that interrupts a pending play is not a player failure', async () => {
  const { wrapper, socket, video, media, pending } = await join('playing');
  // Calibrate the clock with zero offset so the controller follows the playing room.
  for (const text of socket.sent) {
    const ping = JSON.parse(text) as {
      type: string;
      requestId: string;
      payload: object;
    };
    if (ping.type !== 'clock.ping') continue;
    const sent = (ping.payload as { clientSendMs: number }).clientSendMs;
    socket.onmessage?.({
      data: JSON.stringify({
        v: 2,
        type: 'clock.pong',
        requestId: ping.requestId,
        payload: {
          clientSendMs: sent,
          serverReceiveMs: sent,
          serverSendMs: sent,
        },
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
  expect(
    wrapper.get('[data-testid="media-status"]').attributes('data-state')
  ).toBe('buffering');
  expect(reported(socket)).not.toContain('error');
  wrapper.unmount();
});
test('an interrupted Enable playback shows no failure and keeps focus in the player', async () => {
  const { wrapper, socket, video, media } = await join('waiting');
  media.blocked = true;
  await select(wrapper, video);
  await vi.waitFor(() =>
    expect(
      wrapper.get('[data-testid="media-status"]').attributes('data-state')
    ).toBe('gesture_required')
  );
  const enable = wrapper
    .findAll('button')
    .find((button) => button.text() === 'Enable playback')!;
  // Permission arrives with the gesture, but the data no longer covers the wait position.
  media.blocked = false;
  media.readyState = 2;
  (enable.element as HTMLButtonElement).focus();
  await enable.trigger('click');
  // Waiting reports buffering, so the wait's reconcile pauses and cancels the user's play.
  await vi.waitFor(() => expect(media.interrupted).toBe(1));
  await flushPromises();
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  expect(
    wrapper.get('[data-testid="media-status"]').attributes('data-state')
  ).toBe('buffering');
  expect(document.activeElement?.id).toBe('player-title');
  expect(reported(socket)).not.toContain('error');
  wrapper.unmount();
});
