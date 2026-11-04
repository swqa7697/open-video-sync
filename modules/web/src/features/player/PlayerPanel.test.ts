import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { BilibiliAdapter } from '../../player/bilibili/adapter';
import type { Episode, MediaInfo, Playlist } from '../../player/bilibili/media';
import { FakeSocket, roomFixture } from '../../test-support/room';
import { decodeSnapshot } from '../../transport/api';
import { decodeReadiness } from '../../transport/protocol-values';
import type { EpisodeActions } from '../commands/search';
import type { ImportRequest, ImportResult } from '../import-handoff/handoff';
import PlayerPanel from './PlayerPanel.vue';

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
    holdSeek: false,
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
          video.dispatchEvent(new Event('seeking'));
          if (media.holdSeek) return;
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
  video: HTMLVideoElement,
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
        JSON.parse(text) as { type: string; payload: { status?: string } },
    )
    .filter((frame) => frame.type === 'member.readiness')
    .map((frame) => frame.payload.status);
beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
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

// A component scenario owns player menus and the browser preference lifecycle. The
// helper regressions separately verify highest/fallback selection from synthetic metadata.
test('quality and all danmaku choices survive player recreation', async () => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('hover: hover'),
  }));
  localStorage.setItem(
    'ovs.player',
    JSON.stringify({
      volume: 0.4,
      muted: false,
      danmakuVisible: 'false',
      danmakuDensity: 99,
      danmakuSize: 12,
      danmakuSpeed: -1,
      danmakuArea: 0.75,
    }),
  );
  const media = {
    kind: 'bilibili' as const,
    bvid: 'BV1TESTaaaaa',
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
    },
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
      tracks: [
        {
          id: selectedQuality,
          codec: selectedQuality === 120 ? 'av01.0.08M.08' : 'hev1.1.6.L120.90',
          mime: 'video/mp4',
          init: [0, 31],
          index: [32, 63],
        },
      ],
    }),
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
  const reloadComments = vi
    .spyOn(BilibiliAdapter.prototype, 'reloadDanmaku')
    .mockImplementation(() => {});
  let wrapper = await open();
  try {
    const sent = FakeSocket.instances.at(-1)!.sent.length;
    const nativeMenu = new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    wrapper.get('.quality-trigger').element.dispatchEvent(nativeMenu);
    expect(nativeMenu.defaultPrevented).toBe(false);
    await wrapper
      .get('video')
      .trigger('contextmenu', { clientX: 600, clientY: 300 });
    await flushPromises();
    const playerMenu = wrapper.get('.player-context-menu');
    expect(playerMenu.get('a').attributes('href')).toBe(
      'https://www.bilibili.com/video/BV1TESTaaaaa?p=1',
    );
    expect(playerMenu.get('a').attributes('rel')).toBe('noopener noreferrer');
    await playerMenu
      .findAll('button')
      .find((item) => item.text() === 'Reload danmaku')!
      .trigger('click');
    expect(reloadComments).toHaveBeenCalledOnce();
    expect(wrapper.find('.player-context-menu').exists()).toBe(false);
    await wrapper
      .get('.video-stage')
      .trigger('keydown', { key: 'F10', shiftKey: true });
    await flushPromises();
    await wrapper
      .get('.player-context-menu')
      .trigger('keydown', { key: 'End' });
    expect(document.activeElement?.textContent).toContain('Video statistics');
    await wrapper
      .get('.player-context-menu')
      .trigger('keydown', { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toContain('Keyboard shortcuts');
    await wrapper
      .findAll('.player-context-menu button')
      .find((item) => item.text() === 'Keyboard shortcuts')!
      .trigger('click');
    expect(wrapper.get('.player-shortcuts').text()).toContain(
      'Seek 5 seconds together',
    );
    await wrapper
      .get('.player-shortcuts button')
      .trigger('keydown', { key: 'k' });
    expect(FakeSocket.instances.at(-1)!.sent.length).toBe(sent);
    await wrapper
      .get('.player-shortcuts')
      .trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('.player-shortcuts').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('.video-stage').element);
    expect(wrapper.get('.quality-trigger').text()).toBe('4K');
    expect(wrapper.get('.codec-label [aria-hidden="true"]').text()).toBe('AV1');
    await wrapper.get('.quality-trigger').trigger('click');
    await wrapper
      .get('.video-stage')
      .trigger('pointerleave', { pointerType: 'mouse' });
    expect(wrapper.get('.video-stage').classes()).not.toContain(
      'controls-idle',
    );
    expect(wrapper.find('.player-menu:not(.quality-menu)').exists()).toBe(
      false,
    );
    const option = wrapper
      .findAll('[role="menuitemradio"]')
      .find((node) => node.text() === '1080p')!;
    await option.trigger('click');
    await flushPromises();
    expect(wrapper.get('.quality-trigger').text()).toBe('1080p');
    expect(wrapper.get('.codec-label [aria-hidden="true"]').text()).toBe(
      'HEVC',
    );
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(wrapper.get('.video-stage').classes()).toContain('controls-idle');
    for (const pressed of ['false', 'true']) {
      await wrapper.get('.video-stage').trigger('keydown', { key: 'd' });
      expect(wrapper.get('.danmaku-toggle').attributes('aria-pressed')).toBe(
        pressed,
      );
      expect(wrapper.get('.video-stage').classes()).toContain('controls-idle');
    }
    await wrapper
      .get('.video-stage')
      .trigger('pointerenter', { pointerType: 'mouse' });
    wrapper.unmount();
    wrapper = await open();
    expect(wrapper.get('.quality-trigger').text()).toBe('1080p');
    expect(wrapper.get('.codec-label [aria-hidden="true"]').text()).toBe(
      'HEVC',
    );
    await wrapper.get('.quality-trigger').trigger('click');
    expect(wrapper.get('[aria-checked="true"]').text()).toBe('1080p');
    await wrapper.get('[role="menu"]').trigger('keydown', { key: 'Escape' });
    expect(document.activeElement).toBe(
      wrapper.get('.quality-trigger').element,
    );
    expect(wrapper.find('[role="menu"]').exists()).toBe(false);
    expect(wrapper.find('[aria-label="Player settings"]').exists()).toBe(false);
    const trigger = wrapper.get('.danmaku-toggle');
    await wrapper
      .get('.danmaku-control')
      .trigger('pointerenter', { pointerType: 'mouse' });
    await flushPromises();
    expect(wrapper.get('.danmaku-menu').text()).toContain('Danmaku settings');
    expect(wrapper.get('.danmaku-menu').text()).not.toContain('Reload danmaku');
    expect(wrapper.find('.danmaku-menu [role="status"]').exists()).toBe(false);
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-density"]').element.value,
    ).toBe('20');
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-size"]').element.value,
    ).toBe('20');
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-speed"]').element.value,
    ).toBe('1');
    await wrapper
      .get('.video-stage')
      .trigger('pointerleave', { pointerType: 'mouse' });
    expect(wrapper.get('.video-stage').classes()).not.toContain(
      'controls-idle',
    );
    await wrapper.get('input[id$="-density"]').setValue(12);
    await wrapper.get('input[id$="-size"]').setValue(24);
    await wrapper.get('input[id$="-speed"]').setValue(0.7);
    const area = wrapper.get<HTMLSelectElement>('select[id$="-area"]');
    expect(area.element.value).toBe('0.5');
    await area.setValue('0.25');
    expect(wrapper.get('output[for$="-speed"]').text()).toBe('0.7×');
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-density"]').element.value,
    ).toBe('12');
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-size"]').element.value,
    ).toBe('24');
    await trigger.trigger('click');
    expect(trigger.attributes('aria-pressed')).toBe('false');
    expect(area.element.value).toBe('0.25');
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-speed"]').element.value,
    ).toBe('0.7');
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-density"]').element.value,
    ).toBe('12');
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-size"]').element.value,
    ).toBe('24');
    await wrapper
      .get('.danmaku-control')
      .trigger('pointerleave', { pointerType: 'mouse' });
    await vi.waitFor(() =>
      expect(wrapper.find('.danmaku-menu').exists()).toBe(false),
    );
    await trigger.trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    expect(
      wrapper.get<HTMLSelectElement>('select[id$="-area"]').element.value,
    ).toBe('0.25');
    expect(document.activeElement).toBe(
      wrapper.get('input[id$="-density"]').element,
    );
    await wrapper.get('.danmaku-menu').trigger('keydown', { key: 'Escape' });
    expect(wrapper.find('.danmaku-menu').exists()).toBe(false);
    expect(document.activeElement).toBe(trigger.element);
    wrapper.unmount();
    wrapper = await open();
    expect(wrapper.get('.quality-trigger').text()).toBe('1080p');
    expect(wrapper.get('.danmaku-toggle').attributes('aria-pressed')).toBe(
      'false',
    );
    expect(wrapper.get<HTMLInputElement>('.volume-slider').element.value).toBe(
      '0.4',
    );
    await wrapper
      .get('.danmaku-toggle')
      .trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    const restored = wrapper.get<HTMLSelectElement>('select[id$="-area"]');
    expect(restored.element.value).toBe('0.25');
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-density"]').element.value,
    ).toBe('12');
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-size"]').element.value,
    ).toBe('24');
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-speed"]').element.value,
    ).toBe('0.7');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError');
    });
    await restored.setValue('1');
    expect(restored.element.value).toBe('1');
    await wrapper.get('input[id$="-density"]').setValue(8);
    expect(
      wrapper.get<HTMLInputElement>('input[id$="-density"]').element.value,
    ).toBe('8');
  } finally {
    wrapper.unmount();
  }
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Visibility owns its idle timer independently of playback commands and native focus.
test('player controls distinguish playing idle, paused hover, leaving, and seek holds', async () => {
  vi.useFakeTimers();
  const { wrapper, socket } = await join('playing');
  const snapshot = {
    ...room('playing', 2),
    settings: { controllers: 'everyone', waitForAll: false },
  };
  socket.frame('room.snapshot', snapshot);
  const stage = wrapper.get<HTMLElement>('.video-stage');
  const toolbar = wrapper.get('.player-controls');
  const seek = wrapper.get('#seek-seconds');
  const pointer = { pointerType: 'mouse' };
  const hidden = () => stage.classes().includes('controls-idle');
  const advance = async (ms: number) => {
    await vi.advanceTimersByTimeAsync(ms);
    socket.onmessage?.({
      data: JSON.stringify({
        v: 2,
        type: 'heartbeat',
        requestId: '1'.repeat(32),
        payload: { reply: true },
      }),
    });
  };
  try {
    stage.element.focus();
    await stage.trigger('pointerenter', pointer);
    await advance(2999);
    expect(hidden()).toBe(false);
    await advance(1);
    expect(hidden()).toBe(true);
    expect(document.activeElement).toBe(stage.element);
    // Window activation restores the same DOM focus without pointer activity.
    for (const outside of [false, true]) {
      if (outside) await stage.trigger('pointerleave', pointer);
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
      await stage.trigger('focusin', { relatedTarget: null });
      expect(hidden()).toBe(true);
      expect(document.activeElement).toBe(stage.element);
    }
    // Switching applications must not count as native Tab navigation.
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) {
      await stage.trigger('keydown', { key: 'Tab', [modifier]: true });
      expect(hidden()).toBe(true);
    }
    (seek.element as HTMLInputElement).focus();
    await flushPromises();
    expect(hidden()).toBe(false);
    stage.element.focus();
    await stage.trigger('pointerenter', pointer);
    await advance(3000);
    expect(hidden()).toBe(true);
    for (const key of ['ArrowUp', 'ArrowDown', 'm', 'm', 's', 's', 'z']) {
      await stage.trigger('keydown', { key });
      expect(hidden()).toBe(true);
    }
    for (const modifier of ['altKey', 'ctrlKey', 'metaKey', 'isComposing']) {
      await stage.trigger('keydown', { key: 's', [modifier]: true });
      expect(stage.classes()).not.toContain('window-fullscreen');
    }
    await stage.trigger('keydown', { key: 's' });
    expect(stage.classes()).toContain('window-fullscreen');
    await stage.trigger('keydown', { key: 's', repeat: true });
    expect(stage.classes()).toContain('window-fullscreen');
    await stage.trigger('keydown', { key: 'Escape' });
    expect(stage.classes()).not.toContain('window-fullscreen');
    expect(hidden()).toBe(true);
    // A playback acknowledgement must not reveal controls hidden before the command.
    socket.frame('room.snapshot', {
      ...snapshot,
      revision: 3,
      playback: room('paused', 3).playback,
    });
    await flushPromises();
    expect(hidden()).toBe(true);
    socket.frame('room.snapshot', { ...snapshot, revision: 4 });
    await flushPromises();
    expect(hidden()).toBe(true);
    await stage.trigger('pointermove', pointer);
    await advance(2999);
    await stage.trigger('pointermove', pointer);
    await advance(1);
    expect(hidden()).toBe(false);
    await stage.trigger('pointerleave', pointer);
    expect(hidden()).toBe(true);

    await stage.trigger('pointerenter', pointer);
    socket.frame('room.snapshot', {
      ...snapshot,
      revision: 5,
      playback: room('paused', 5).playback,
    });
    await advance(4000);
    expect(hidden()).toBe(false);
    await stage.trigger('pointerleave', pointer);
    expect(hidden()).toBe(true);
    await stage.trigger('pointerenter', pointer);
    await advance(4000);
    expect(hidden()).toBe(false);

    socket.frame('room.snapshot', { ...snapshot, revision: 6 });
    await toolbar.trigger('pointerenter', pointer);
    await advance(4000);
    expect(hidden()).toBe(false);
    await toolbar.trigger('pointerleave', pointer);
    await advance(3000);
    expect(hidden()).toBe(true);

    for (const end of ['pointerup', 'pointercancel']) {
      await stage.trigger('pointerenter', pointer);
      await seek.trigger('pointerdown', pointer);
      await stage.trigger('pointerleave', pointer);
      await advance(4000);
      expect(hidden()).toBe(false);
      document.dispatchEvent(new Event(end));
      await vi.advanceTimersByTimeAsync(0);
      await flushPromises();
      expect(hidden()).toBe(true);
    }
    // Touch contact must not become a permanent hover or a synthetic mouse exit.
    await stage.trigger('pointerdown', { pointerType: 'touch' });
    await toolbar.trigger('pointerenter', { pointerType: 'touch' });
    await stage.trigger('pointerleave', { pointerType: 'touch' });
    expect(hidden()).toBe(false);
    await advance(3000);
    expect(hidden()).toBe(true);
    stage.element.focus();
    await stage.trigger('keydown', { key: 'Tab' });
    expect(hidden()).toBe(false);
    // Shortcut feedback replaces its expiry on each press and clamps to 0–100%.
    await stage.trigger('keydown', { key: 'ArrowUp' });
    expect(wrapper.get('.volume-feedback').text()).toBe('60');
    await advance(1000);
    await stage.trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.get('.volume-feedback').text()).toBe('50');
    await advance(1199);
    expect(wrapper.find('.volume-feedback').exists()).toBe(true);
    await advance(1);
    expect(wrapper.find('.volume-feedback').exists()).toBe(false);
    for (let press = 0; press < 7; press++)
      await stage.trigger('keydown', { key: 'ArrowDown' });
    expect(wrapper.get('.volume-feedback').text()).toBe('0');
    for (let press = 0; press < 12; press++)
      await stage.trigger('keydown', { key: 'ArrowUp' });
    expect(wrapper.get('.volume-feedback').text()).toBe('100');
  } finally {
    wrapper.unmount();
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

// Media replacement is owned by the player, independently of the sidebar's presentation.
test('host episode selection publishes resolved metadata and retains the list during loading', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const first = { bvid: 'BV1TESTaaaaa', part: 1, title: 'First' },
    second = { bvid: 'BV1TESTaaaab', part: 2, title: 'Second' },
    playlist: Playlist = { title: 'Collection', episodes: [first, second] };
  let media = {
    kind: 'bilibili' as const,
    bvid: first.bvid,
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
  let finish: (() => void) | undefined;
  vi.spyOn(BilibiliAdapter.prototype, 'load').mockImplementation(
    async (bvid, part) => {
      if (bvid === second.bvid)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      media = { ...media, bvid, part, cid: bvid === first.bvid ? '1' : '2' };
      return media;
    },
  );
  vi.spyOn(BilibiliAdapter.prototype, 'mediaInfo', 'get').mockImplementation(
    (): MediaInfo => ({
      ...media,
      duration: 10,
      title: 'Synthetic collection',
      parts: 2,
      playlist,
      quality: 80,
      qualities: [80],
      handle: 'h1-1234',
      tracks: [
        {
          id: 80,
          codec: 'avc1.64001E',
          mime: 'video/mp4',
          init: [0, 31],
          index: [32, 63],
        },
      ],
    }),
  );
  vi.spyOn(BilibiliAdapter.prototype, 'getState').mockReturnValue({
    positionMs: 0,
    durationMs: 10000,
    paused: true,
    seeking: false,
    status: 'ready',
  });
  const wrapper = mount(PlayerPanel, {
    props: { room: snapshot },
    attachTo: document.body,
  });
  const panel = wrapper.vm as unknown as {
    playlist: Playlist | undefined;
    canReplace: boolean;
    selectEpisode: (episode: Episode) => Promise<void>;
    episodeActions: EpisodeActions;
  };
  try {
    fakeMedia(wrapper.get('video').element);
    const socket = FakeSocket.instances.at(-1)!;
    socket.readyState = 1;
    socket.frame('session.welcome', { connectionId: 'c'.repeat(32), snapshot });
    await flushPromises();
    expect(wrapper.get('.codec-label [aria-hidden="true"]').text()).toBe('AVC');
    await panel.selectEpisode(first);
    await panel.selectEpisode({ ...second, part: 3 });
    expect(
      socket.sent
        .map((raw) => JSON.parse(raw))
        .filter((q) => q.type === 'media.select'),
    ).toHaveLength(0);
    const selecting = panel.selectEpisode(second);
    await flushPromises();
    expect(wrapper.find('.codec-label').exists()).toBe(false);
    expect(panel.canReplace).toBe(false);
    expect(panel.episodeActions.selection?.phase).toBe('loading');
    expect(panel.playlist).toEqual(playlist);
    finish?.();
    await selecting;
    const commands = socket.sent
      .map((raw) => JSON.parse(raw))
      .filter((q) => q.type === 'media.select');
    expect(commands).toHaveLength(1);
    expect(commands[0].payload.autoPlay).toBe(true);
    expect(commands[0].payload.media).toEqual({
      kind: 'bilibili',
      bvid: second.bvid,
      cid: '2',
      part: 2,
      durationMs: 10000,
    });
    expect(JSON.stringify(commands)).not.toContain('playlist');
    expect(panel.episodeActions.selection?.phase).toBe('pending');
    socket.frame('command.result', {
      commandId: 'f'.repeat(32),
      accepted: true,
      revision: 2,
      error: null,
    });
    expect(panel.episodeActions.selection?.phase).toBe('pending');
    socket.frame('command.result', {
      commandId: commands[0].commandId,
      accepted: false,
      revision: null,
      error: {
        code: 'storage_unavailable',
        message: 'Synthetic storage failure',
        requestId: 'f'.repeat(32),
        retryable: true,
      },
    });
    expect(panel.episodeActions.selection?.phase).toBe('failed');
    expect(panel.episodeActions.selection?.error).toContain('save');
    const retry = panel.selectEpisode(second);
    await flushPromises();
    finish?.();
    await retry;
    const retried = socket.sent
      .map((raw) => JSON.parse(raw))
      .filter((frame) => frame.type === 'media.select')
      .at(-1);
    socket.frame('command.result', {
      commandId: retried.commandId,
      accepted: true,
      revision: 2,
      error: null,
    });
    expect(panel.episodeActions.selection?.phase).toBe('accepted');
    socket.frame('room.snapshot', {
      ...snapshot,
      revision: 2,
      mediaGeneration: 2,
      media,
    });
    await flushPromises();
    expect(panel.playlist).toEqual(playlist);
    expect(wrapper.get('.codec-label [aria-hidden="true"]').text()).toBe('AVC');
    socket.frame('room.snapshot', {
      ...snapshot,
      revision: 3,
      mediaGeneration: 3,
      media: room('paused', 3).media,
    });
    await flushPromises();
    expect(panel.playlist).toBeUndefined();
    expect(panel.episodeActions.selection).toBeUndefined();
    expect(wrapper.find('.codec-label').exists()).toBe(false);
  } finally {
    wrapper.unmount();
  }
});

test('a failed Bilibili player keeps readiness valid and video replacement available', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const snapshot = decodeSnapshot({
    ...roomFixture,
    mediaGeneration: 1,
    media: {
      kind: 'bilibili',
      bvid: 'BV1TESTaaaaa',
      cid: '1',
      part: 1,
      durationMs: 10000,
    },
    playback: { ...roomFixture.playback, phase: 'paused' },
  });
  let fail: (() => void) | undefined;
  vi.spyOn(BilibiliAdapter.prototype, 'load').mockImplementation(function (
    this: BilibiliAdapter,
  ) {
    fail = () => {
      this.dispose();
      vi.spyOn(this, 'getState').mockReturnValue({
        status: 'error',
        positionMs: 0,
        durationMs: 0,
        paused: true,
        seeking: false,
      });
    };
    return Promise.resolve(snapshot.media!);
  });
  vi.spyOn(BilibiliAdapter.prototype, 'getState').mockReturnValue({
    status: 'ready',
    positionMs: 0,
    durationMs: 10000,
    paused: true,
    seeking: false,
  });
  const wrapper = mount(PlayerPanel, {
    props: { room: snapshot },
    attachTo: document.body,
  });
  try {
    fakeMedia(wrapper.get('video').element);
    const socket = FakeSocket.instances.at(-1)!;
    socket.readyState = 1;
    socket.frame('session.welcome', { connectionId: 'c'.repeat(32), snapshot });
    await flushPromises();
    for (const raw of socket.sent) {
      const ping = JSON.parse(raw);
      if (ping.type !== 'clock.ping') continue;
      socket.onmessage?.({
        data: JSON.stringify({
          v: 2,
          type: 'clock.pong',
          requestId: ping.requestId,
          payload: {
            ...ping.payload,
            serverReceiveMs: ping.payload.clientSendMs,
            serverSendMs: ping.payload.clientSendMs,
          },
        }),
      });
    }
    await vi.advanceTimersByTimeAsync(250);
    fail?.();
    socket.frame('room.snapshot', snapshot);
    await flushPromises();
    const reports = socket.sent
      .map((raw) => JSON.parse(raw))
      .filter((frame) => frame.type === 'member.readiness');
    const report = reports.at(-1).payload;
    expect(() => decodeReadiness(report)).not.toThrow();
    expect(report).toMatchObject({ positionMs: null, durationMs: null });
    expect(wrapper.get('.change-media').attributes('disabled')).toBeUndefined();
  } finally {
    wrapper.unmount();
  }
});

// The panel owns the acknowledgement delay; loading and buffering must never start it.
test('command recovery waits three seconds for a receipt and ignores media loading', async () => {
  vi.useFakeTimers();
  const snapshot = {
    ...room('paused', 1),
    selfMemberId: roomFixture.hostMemberId,
    playback: { ...room('paused', 1).playback, positionMs: 0 },
  };
  const wrapper = mount(PlayerPanel, {
    props: { room: decodeSnapshot(snapshot) },
    attachTo: document.body,
  });
  const socket = FakeSocket.instances[0]!;
  socket.readyState = 1;
  socket.frame('session.welcome', {
    connectionId: 'c'.repeat(32),
    snapshot,
  });
  const video = wrapper.get('video').element;
  fakeMedia(video);
  const commands = () =>
    socket.sent
      .map((text) => JSON.parse(text) as { type: string; commandId: string })
      .filter((frame) => frame.type === 'playback.command');
  const receipt = () =>
    socket.frame('command.result', {
      commandId: commands().at(-1)!.commandId,
      accepted: true,
      revision: 1,
      error: null,
    });
  try {
    await flushPromises();
    const input = wrapper.get('#local-video');
    Object.defineProperty(input.element, 'files', {
      value: [new File(['synthetic'], 'private.webm')],
    });
    await input.trigger('change');
    await vi.advanceTimersByTimeAsync(3100);
    expect(
      wrapper.get('[data-testid="media-status"]').attributes('data-state'),
    ).toBe('loading');
    expect(wrapper.get('.playback-indicator').attributes('aria-label')).toBe(
      'Loading video…',
    );
    expect(commands()).toHaveLength(0);
    expect(wrapper.find('.command-recovery').exists()).toBe(false);
    video.dispatchEvent(new Event('loadeddata'));
    await flushPromises();
    expect(wrapper.get('.playback-indicator').attributes('aria-label')).toBe(
      'Paused',
    );
    socket.frame('room.snapshot', snapshot);
    const play = wrapper.get('.control-start > button');
    expect(play.attributes('aria-disabled'), wrapper.text()).toBe('false');
    await play.trigger('click');
    expect(commands()).toHaveLength(1);
    expect(play.attributes('aria-disabled')).toBe('true');
    expect(wrapper.get('#control-note').classes()).toContain('visually-hidden');
    await vi.advanceTimersByTimeAsync(2999);
    expect(wrapper.find('.command-recovery').exists()).toBe(false);
    receipt();
    video.dispatchEvent(new Event('waiting'));
    await vi.advanceTimersByTimeAsync(101);
    expect(wrapper.find('.command-recovery').exists()).toBe(false);
    // Buffering and the room's readiness barrier have their own state after acknowledgement.
    socket.frame('room.snapshot', {
      ...snapshot,
      playback: room('waiting', 1).playback,
      barrier: room('waiting', 1).barrier,
    });
    await vi.advanceTimersByTimeAsync(3100);
    expect(wrapper.find('.command-recovery').exists()).toBe(false);
    expect(
      wrapper.get('[data-testid="playback-phase"]').attributes('data-state'),
    ).toBe('waiting');
    expect(play.attributes('aria-disabled')).toBe('false');
    socket.frame('room.snapshot', snapshot);
    await play.trigger('click');
    await vi.advanceTimersByTimeAsync(2999);
    expect(wrapper.find('.command-recovery').exists()).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(wrapper.get('.command-recovery').text()).toContain(
      'No server acknowledgement',
    );
    const recovery = wrapper.get('.command-recovery button');
    (recovery.element as HTMLButtonElement).focus();
    await recovery.trigger('click');
    expect(commands().at(-1)).toEqual(commands().at(-2));
    receipt();
    await flushPromises();
    expect(wrapper.find('.command-recovery').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.get('.video-stage').element);
    // The next command starts a fresh timer, and a new server epoch cancels it.
    socket.frame('room.snapshot', snapshot);
    await play.trigger('click');
    await vi.advanceTimersByTimeAsync(2999);
    expect(wrapper.find('.command-recovery').exists()).toBe(false);
    socket.frame(
      'room.snapshot',
      { ...snapshot, epoch: '9'.repeat(32) },
      '9'.repeat(32),
    );
    await vi.advanceTimersByTimeAsync(2);
    expect(wrapper.find('.command-recovery').exists()).toBe(false);
    expect(play.attributes('aria-disabled')).toBe('false');
    await play.trigger('click');
  } finally {
    wrapper.unmount();
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

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
    wrapper.get('[data-testid="media-status"]').attributes('data-state'),
  ).toBe('buffering');
  expect(wrapper.get('.playback-indicator').attributes('aria-label')).toBe(
    'Buffering…',
  );
  expect(reported(socket)).not.toContain('error');
  wrapper.unmount();
});
test('a playing seek waits for data at the paused target and stays paused when data arrives', async () => {
  vi.useFakeTimers();
  const { wrapper, socket, video, media } = await join('playing');
  try {
    await select(wrapper, video);
    for (const raw of [...socket.sent]) {
      const ping = JSON.parse(raw);
      if (ping.type !== 'clock.ping') continue;
      const sent = ping.payload.clientSendMs;
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
    const playing = {
      ...room('playing', 2),
      settings: { ...roomFixture.settings, controllers: 'everyone' },
      playback: {
        phase: 'playing',
        positionMs: 0,
        anchorServerMs: 0,
        desiredPlaying: true,
      },
    };
    socket.frame('room.snapshot', playing);
    await flushPromises();
    expect(video.paused).toBe(false);
    expect(wrapper.find('.playback-indicator').exists()).toBe(false);
    media.holdSeek = true;
    await wrapper.get('#seek-seconds').setValue(5);
    const command = socket.sent
      .map((raw) => JSON.parse(raw))
      .findLast((frame) => frame.type === 'playback.command');
    socket.frame('command.result', {
      commandId: command.commandId,
      accepted: true,
      revision: 3,
      error: null,
    });
    socket.frame('room.snapshot', {
      ...playing,
      revision: 3,
      playback: {
        ...playing.playback,
        phase: 'paused',
        desiredPlaying: false,
        positionMs: 5000,
      },
    });
    await vi.advanceTimersByTimeAsync(750);
    expect(video.seeking).toBe(true);
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBe(5);
    expect(reported(socket).at(-1)).toBe('buffering');
    expect(wrapper.get('.playback-indicator').attributes('aria-label')).toBe(
      'Buffering…',
    );
    media.seeking = false;
    media.readyState = 4;
    video.dispatchEvent(new Event('seeked'));
    video.dispatchEvent(new Event('canplay'));
    await flushPromises();
    expect(reported(socket).at(-1)).toBe('ready');
    await vi.advanceTimersByTimeAsync(2000);
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBe(5);
    expect(wrapper.get('.playback-indicator').attributes('aria-label')).toBe(
      'Paused',
    );
    expect(wrapper.find('[role="alert"]').exists()).toBe(false);
    const commands = socket.sent
      .map((raw) => JSON.parse(raw))
      .filter((frame) => frame.type === 'playback.command');
    expect(commands.map((frame) => frame.payload)).toEqual([
      { action: 'seek', positionMs: 5000 },
    ]);
  } finally {
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(0);
  }
});
test('an interrupted Enable playback shows no failure and keeps focus in the player', async () => {
  const { wrapper, socket, video, media } = await join('waiting');
  media.blocked = true;
  await select(wrapper, video);
  await vi.waitFor(() =>
    expect(
      wrapper.get('[data-testid="media-status"]').attributes('data-state'),
    ).toBe('gesture_required'),
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
    wrapper.get('[data-testid="media-status"]').attributes('data-state'),
  ).toBe('buffering');
  expect(document.activeElement?.id).toBe('player-title');
  expect(reported(socket)).not.toContain('error');
  wrapper.unmount();
});

test('imported media retains its guarded command until the matching server acknowledgement', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.spyOn(BilibiliAdapter.prototype, 'load').mockRejectedValue(
    new Error('Synthetic playback unavailable'),
  );
  const snapshot = decodeSnapshot(roomFixture);
  const wrapper = mount(PlayerPanel, {
    props: { room: snapshot },
    attachTo: document.body,
  });
  const panel = wrapper.vm as unknown as {
    importMedia(request: ImportRequest): Promise<ImportResult>;
  };
  const request: ImportRequest = {
    requestId: 'a'.repeat(32),
    target: {
      tabId: 'f'.repeat(32),
      roomId: snapshot.roomId,
      epoch: snapshot.epoch,
      mediaGeneration: snapshot.mediaGeneration,
      expectedRevision: snapshot.revision,
    },
    media: {
      kind: 'bilibili',
      bvid: 'BV1TESTaaaaa',
      cid: '1',
      part: 1,
      durationMs: 10000,
    },
  };
  try {
    fakeMedia(wrapper.get('video').element);
    const socket = FakeSocket.instances.at(-1)!;
    socket.welcome();
    await flushPromises();
    expect(
      await panel.importMedia({
        ...request,
        target: { ...request.target, mediaGeneration: 1 },
      }),
    ).toEqual({ status: 'stale' });
    const commands = () =>
      socket.sent
        .map((raw) => JSON.parse(raw))
        .filter((frame) => frame.type === 'media.select');
    expect(commands()).toHaveLength(0);
    let finished = false;
    const importing = panel.importMedia(request).then((result) => {
      finished = true;
      return result;
    });
    const command = commands()[0];
    expect(command).toMatchObject({
      commandId: request.requestId,
      epoch: request.target.epoch,
      mediaGeneration: request.target.mediaGeneration,
      expectedRevision: request.target.expectedRevision,
      payload: { media: request.media },
    });
    expect(command.payload.autoPlay).toBeUndefined();
    socket.frame('room.snapshot', {
      ...snapshot,
      media: request.media,
      revision: 2,
      mediaGeneration: 1,
      playback: { ...snapshot.playback, phase: 'paused' },
    });
    await flushPromises();
    expect(finished).toBe(false);
    socket.frame('command.result', {
      commandId: 'e'.repeat(32),
      accepted: true,
      revision: 2,
      error: null,
    });
    await flushPromises();
    expect(finished).toBe(false);
    socket.frame('command.result', {
      commandId: request.requestId,
      accepted: true,
      revision: 2,
      error: null,
    });
    expect(await importing).toEqual({ status: 'accepted' });
    expect(await panel.importMedia(request)).toEqual({ status: 'accepted' });
    expect(commands()).toHaveLength(1);
  } finally {
    wrapper.unmount();
    await vi.advanceTimersByTimeAsync(0);
  }
});
