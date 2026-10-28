import { createPinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import App from './App.vue';
import { defaultSettings, decodeSnapshot } from './transport/api';

const identity = {
  identity: { identityId: 'a'.repeat(32), displayName: '' },
  csrfToken: 'A'.repeat(43),
  expiresAtMs: 1824681600000,
};
const snapshot = {
  roomId: 'b'.repeat(32),
  title: 'Private room',
  epoch: 'c'.repeat(32),
  revision: 1,
  hostMemberId: 'd'.repeat(32),
  selfMemberId: 'd'.repeat(32),
  settings: defaultSettings(),
  mediaGeneration: 0,
  media: null,
  barrier: null,
  serverNowMs: 100,
  playback: {
    phase: 'empty',
    positionMs: 0,
    anchorServerMs: 0,
    baseRate: 1,
    desiredPlaying: false,
  },
  members: [
    {
      memberId: 'd'.repeat(32),
      displayName: 'Guest',
      role: 'host',
      presence: 'offline',
      playbackActive: false,
      playbackEligible: false,
      excludedFromWaiting: false,
      readiness: null,
    },
  ],
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

test.each([true, false])('shows readiness and restores identity (ready=%s)', async (ready) => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        url.startsWith('/health')
          ? new Response(null, { status: ready ? 204 : 503 })
          : json(url.endsWith('/session') ? identity : { rooms: [], nextCursor: null }),
      ),
    ),
  );
  const wrapper = mount(App, { global: { plugins: [createPinia()] } });
  await flushPromises();
  expect(wrapper.get('header [role="status"]').text()).toBe(
    `Server: ${ready ? 'ready' : 'unavailable'}`,
  );
  expect(wrapper.find('#display-name').exists()).toBe(true);
  wrapper.unmount();
});

test('aborts all pending requests when disposed', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, options: RequestInit) => {
      if (options.signal) signals.push(options.signal);
      return new Promise<Response>(() => {});
    }),
  );
  const wrapper = mount(App, { global: { plugins: [createPinia()] } });
  wrapper.unmount();
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

test('retries uncertain creation with the original intent and idempotency key', async () => {
  const attempts: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, options: RequestInit) => {
      if (url.startsWith('/health')) return Promise.resolve(new Response(null, { status: 204 }));
      if (url.endsWith('/session')) return Promise.resolve(json(identity));
      if (options.method === 'GET') return Promise.resolve(json({ rooms: [], nextCursor: null }));
      attempts.push(options);
      return attempts.length === 1
        ? Promise.reject(new TypeError('network failure'))
        : Promise.resolve(json({ snapshot, invitation: null, replayed: true }));
    }),
  );
  const wrapper = mount(App, { global: { plugins: [createPinia()] } });
  await flushPromises();
  await wrapper.get('#room-name').setValue('Private room');
  await wrapper
    .get('#create-title')
    .element.parentElement?.querySelector('form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flushPromises();
  expect(wrapper.get('#room-name').attributes('disabled')).toBeDefined();
  const retry = wrapper
    .findAll('button')
    .find((button) => button.text() === 'Retry original request');
  await retry?.trigger('click');
  await flushPromises();
  expect(attempts).toHaveLength(2);
  expect(attempts[0]?.body).toBe(attempts[1]?.body);
  expect(attempts[0]?.headers).toEqual(attempts[1]?.headers);
  expect(wrapper.get('#room-title').text()).toBe('Private room');
  expect(wrapper.text()).toContain('previous request succeeded');
  wrapper.unmount();
});

test('rejects malformed room responses before rendering authority', () => {
  expect(() => decodeSnapshot({ ...snapshot, selfMemberId: 'f'.repeat(32) })).toThrow();
  expect(() => decodeSnapshot({ ...snapshot, signedURL: 'synthetic-credential' })).toThrow();
  expect(() => decodeSnapshot({ ...snapshot, revision: 1.5 })).toThrow();
  expect(decodeSnapshot(snapshot).selfMemberId).toBe(snapshot.selfMemberId);
});
