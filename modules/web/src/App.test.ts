import { createPinia } from 'pinia';
import { defineComponent } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';
import App from './App.vue';
import { decodeSnapshot } from './transport/api';
import { consumeInvitation } from './transport/invitation';
import { FakeSocket, roomFixture } from './test-support/room';
import { BilibiliAdapter } from './player/bilibili/adapter';
import type { MediaInfo } from './player/bilibili/media';
import { i18n } from './i18n';
const identity = {
  identity: { identityId: 'a'.repeat(32), displayName: '' },
  csrfToken: 'A'.repeat(43),
  expiresAtMs: 1824681600000,
};
const media = {
  kind: 'bilibili',
  bvid: 'BV1hf4y1N75G',
  cid: '1',
  part: 1,
  durationMs: 10000,
};
const snapshot = roomFixture;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
const prepared = defineComponent({
  setup(_, { expose }) {
    expose({ prepare: async () => ({ media }) });
    return () => null;
  },
});
function app(props: { initialInvitation?: string } = {}) {
  return mount(App, {
    props,
    attachTo: document.body,
    global: {
      plugins: [createPinia()],
      stubs: {
        RepositoryLink: true,
        HelperNotice: true,
        MediaPicker: prepared,
        Modal: { template: '<div role="dialog"><slot /></div>' },
      },
    },
  });
}
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
  localStorage.removeItem('ovs.language');
  i18n.global.locale.value = 'en';
});
test.each([
  [
    'ready',
    () => Promise.resolve(new Response(null, { status: 204 })),
    'Server: ready',
  ],
  [
    'storage failed',
    () => Promise.resolve(new Response(null, { status: 503 })),
    'Server: online, but cannot save changes',
  ],
  [
    'stopped',
    () => Promise.reject(new TypeError('network failure')),
    'Server: unreachable',
  ],
] as const)(
  'shows %s readiness and restores identity without a directory',
  async (_, health, text) => {
    let healthy = false;
    const fetch = vi.fn((url: string) =>
      url.startsWith('/health')
        ? healthy
          ? Promise.resolve(new Response(null, { status: 204 }))
          : health()
        : Promise.resolve(json(identity))
    );
    vi.stubGlobal('fetch', fetch);
    const wrapper = app();
    await flushPromises();
    expect(wrapper.get('header [role="status"]').text()).toBe(text);
    expect(document.title).toBe('Watch together · Open Video Sync');
    expect(wrapper.find('#display-name').exists()).toBe(false);
    expect(fetch.mock.calls.some(([url]) => url === '/api/v2/rooms')).toBe(
      false
    );
    healthy = true;
    window.dispatchEvent(new Event('online'));
    await flushPromises();
    expect(wrapper.get('header [role="status"]').text()).toBe('Server: ready');
    wrapper.unmount();
  }
);
test('aborts pending requests and releases readiness listeners when disposed', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, options: RequestInit) => {
      if (options.signal) signals.push(options.signal);
      return new Promise<Response>(() => {});
    })
  );
  const wrapper = app();
  wrapper.unmount();
  expect(signals).toHaveLength(2);
  expect(signals.every((s) => s.aborted)).toBe(true);
  window.dispatchEvent(new Event('online'));
  expect(signals).toHaveLength(2);
});
test('loaded episode metadata reaches the room sidebar through the player slot', async () => {
  const room = decodeSnapshot({
    ...snapshot,
    media,
    mediaGeneration: 1,
    playback: { ...snapshot.playback, phase: 'paused' },
  });
  const playlist = {
    title: 'Collection',
    episodes: [
      { bvid: media.bvid, part: 1, title: 'Opening' },
      { bvid: media.bvid, part: 2, title: 'Finale' },
    ],
  };
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', async (url: string) =>
    url.startsWith('/health')
      ? new Response(null, { status: 204 })
      : json(url.endsWith('/session') ? identity : room)
  );
  vi.spyOn(BilibiliAdapter.prototype, 'load').mockResolvedValue(room.media!);
  vi.spyOn(BilibiliAdapter.prototype, 'mediaInfo', 'get').mockReturnValue({
    ...media,
    duration: 10,
    title: 'Opening',
    parts: 2,
    playlist,
    quality: 80,
    qualities: [80],
    handle: 'h1-1234',
    tracks: [],
  } satisfies MediaInfo);
  vi.spyOn(BilibiliAdapter.prototype, 'getState').mockReturnValue({
    positionMs: 0,
    durationMs: 10000,
    paused: true,
    seeking: false,
    status: 'ready',
  });
  history.replaceState(null, '', `/rooms/${room.roomId}`);
  const wrapper = app();
  try {
    await flushPromises();
    const socket = FakeSocket.instances.at(-1)!;
    socket.readyState = 1;
    socket.frame('session.welcome', {
      connectionId: 'e'.repeat(32),
      snapshot: room,
    });
    await flushPromises();
    await wrapper.get('#episodes-tab').trigger('click');
    expect(wrapper.get('#episodes-pane').isVisible()).toBe(true);
    expect(wrapper.get('[aria-current="true"]').text()).toContain('Opening');
    expect(wrapper.findAll('.episode-button')).toHaveLength(2);
  } finally {
    wrapper.unmount();
  }
});
test.each([true, false])(
  'recovers uncertain initial-media creation without a duplicate (retained=%s)',
  async (retained) => {
    const attempts: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, options: RequestInit) => {
        if (url.startsWith('/health'))
          return Promise.resolve(new Response(null, { status: 204 }));
        if (url.endsWith('/session')) return Promise.resolve(json(identity));
        if (options.method === 'GET')
          return Promise.resolve(
            new Response(JSON.stringify({ code: 'not_found' }), { status: 404 })
          );
        attempts.push(options);
        return attempts.length === 1
          ? Promise.reject(new TypeError('network failure'))
          : Promise.resolve(
              retained
                ? json({ snapshot, invitation: null, replayed: true })
                : new Response(
                    JSON.stringify({ code: 'request_outcome_unknown' }),
                    {
                      status: 409,
                    }
                  )
            );
      })
    );
    const wrapper = app();
    await flushPromises();
    await wrapper.get('#room-name').setValue('Private room');
    await wrapper.get('form').trigger('submit');
    await flushPromises();
    expect(wrapper.get('#room-name').attributes('readonly')).toBeDefined();
    expect(wrapper.get('[role="alert"]').text()).toContain(
      'Cannot reach the server'
    );
    expect(document.activeElement?.id).toBe('retry-attempt');
    await wrapper.get('#retry-attempt').trigger('click');
    await flushPromises();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.body).toBe(attempts[1]?.body);
    expect(JSON.parse(attempts[0]!.body as string)).toMatchObject({
      title: 'Private room',
      media,
    });
    expect(new Headers(attempts[1]!.headers).get('Idempotency-Key')).toBe(
      new Headers(attempts[0]!.headers).get('Idempotency-Key')
    );
    expect(
      new Headers(attempts[1]!.headers).get('Idempotency-Replay-Only')
    ).toBe('true');
    if (retained) {
      expect(wrapper.get('#room-title').text()).toBe('Private room');
      expect(document.activeElement?.id).toBe('room-title');
    } else {
      expect(wrapper.find('#room-title').exists()).toBe(false);
      expect(wrapper.text()).toContain('No second room was created');
      expect(wrapper.find('.room-list').exists()).toBe(false);
    }
    wrapper.unmount();
  }
);
test.each(['session', 'redeem'])(
  'recovers invitation after a failed %s request and helper reload',
  async (failed) => {
    const requests: RequestInit[] = [];
    let interrupted = true;
    const secret = 'AAECAwQFBgcICQoLDA0ODw';
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, options: RequestInit) => {
        if (url.startsWith('/health'))
          return Promise.resolve(new Response(null, { status: 204 }));
        if (url.endsWith('/session'))
          return interrupted && failed === 'session'
            ? Promise.reject(new TypeError('network failure'))
            : Promise.resolve(json(identity));
        if (url.endsWith('/invitations'))
          return Promise.resolve(
            json({
              invitation: { linkSecret: secret, code: '0123456789ABCDEF' },
            })
          );
        requests.push(options);
        if (interrupted)
          return Promise.reject(new TypeError('network failure'));
        return Promise.resolve(
          json({ snapshot, invitation: null, replayed: false })
        );
      })
    );
    history.replaceState(null, '', `/join#invite=${secret}`);
    let wrapper = app({ initialInvitation: consumeInvitation()! });
    try {
      await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toContain(
        'Cannot reach the server'
      );
      expect(location.hash).toBe('');
      wrapper.unmount();
      interrupted = false;
      wrapper = app({ initialInvitation: consumeInvitation()! });
      await flushPromises();
      expect(requests).toHaveLength(failed === 'session' ? 1 : 2);
      expect(JSON.parse(requests.at(-1)!.body as string)).toEqual({
        linkSecret: secret,
      });
      expect(wrapper.get('#room-title').text()).toBe('Private room');
      expect(wrapper.find('#join-submit').exists()).toBe(false);
      await wrapper.get('.invite-button').trigger('click');
      expect(
        wrapper.get<HTMLInputElement>('#invite-link').element.value
      ).toContain(secret);
      expect(history.state).toBeNull();
      expect(consumeInvitation()).toBeUndefined();
    } finally {
      wrapper.unmount();
    }
  }
);
test('rejects malformed room responses before rendering authority', () => {
  expect(() =>
    decodeSnapshot({ ...snapshot, selfMemberId: 'f'.repeat(32) })
  ).toThrow();
  expect(() =>
    decodeSnapshot({ ...snapshot, signedURL: 'synthetic-credential' })
  ).toThrow();
  expect(() => decodeSnapshot({ ...snapshot, revision: 1.5 })).toThrow();
  expect(decodeSnapshot(snapshot).selfMemberId).toBe(snapshot.selfMemberId);
});

test('distinguishes input, response, proxy, and unavailable-room failures in the new entry flow', async () => {
  let redemptions = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.startsWith('/health'))
        return Promise.resolve(new Response(null, { status: 204 }));
      if (url.endsWith('/session')) return Promise.resolve(json(identity));
      if (url.startsWith(`/api/v2/rooms/${snapshot.roomId}`))
        return Promise.resolve(
          new Response(JSON.stringify({ code: 'not_found' }), { status: 404 })
        );
      if (url.endsWith('/invitations/redeem'))
        return Promise.resolve(
          ++redemptions === 1
            ? json({})
            : new Response(JSON.stringify({ code: 'invalid_invitation' }), {
                status: 404,
              })
        );
      return Promise.resolve(new Response('', { status: 502 }));
    })
  );
  history.replaceState(null, '', `/rooms/${snapshot.roomId}`);
  const wrapper = app();
  await flushPromises();
  expect(location.pathname).toBe('/');
  expect(wrapper.text()).toContain('is no longer available to you');
  await wrapper.get('.profile-button').trigger('click');
  await wrapper.get('#display-name').setValue('bell\u0007');
  wrapper.get<HTMLInputElement>('#display-name').element.form?.requestSubmit();
  await flushPromises();
  expect(wrapper.get('#app-alert').text()).toContain('Use up to 48 characters');
  expect(document.activeElement?.id).toBe('display-name');
  await wrapper.get('#join-code').setValue('ABCD-EFGH-JKMN-PQRS');
  wrapper.get<HTMLInputElement>('#join-code').element.form?.requestSubmit();
  await flushPromises();
  expect(wrapper.get('#app-alert').text()).toContain('unexpected response');
  expect(wrapper.find('#app-reload').exists()).toBe(true);
  // A malformed success leaves an uncertain request; resolve that original intent first.
  await wrapper.get('#retry-attempt').trigger('click');
  await flushPromises();
  expect(wrapper.find('#retry-attempt').exists()).toBe(false);
  wrapper.get<HTMLInputElement>('#join-code').element.form?.requestSubmit();
  await flushPromises();
  expect(wrapper.get('#app-alert').text()).toContain(
    'This invitation is unavailable or the room has closed.'
  );
  expect(document.activeElement?.id).toBe('join-code');
  expect(wrapper.get('#join-code').attributes('aria-invalid')).toBe('true');
  await wrapper.get('#room-name').setValue('Proxy room');
  wrapper.get<HTMLInputElement>('#room-name').element.form?.requestSubmit();
  await flushPromises();
  expect(wrapper.get('#app-alert').text()).toContain(
    'through its proxy (HTTP 502)'
  );
  // An error already on screen must follow the selection without retrying the request.
  const requestCount = vi.mocked(fetch).mock.calls.length;
  // Popover dismissal belongs to the browser; this test owns live translation.
  const settings = wrapper.getComponent({ name: 'AppSettings' });
  const menu = settings.get<HTMLElement>('[popover]');
  menu.element.hidePopover = vi.fn();
  await settings
    .findAll('[role="menuitem"]')
    .find((item) => item.text() === 'Language')!
    .trigger('click');
  await wrapper.get('input[name="language"][value="zh-CN"]').setValue(true);
  await flushPromises();
  expect(wrapper.get('#app-alert').text()).toContain(
    '无法通过代理连接服务器（HTTP 502）'
  );
  expect(wrapper.find('button[aria-label="设置"]').exists()).toBe(true);
  expect(document.title).toBe('一起观看 · Open Video Sync');
  expect(vi.mocked(fetch).mock.calls).toHaveLength(requestCount);
  wrapper.unmount();
});
