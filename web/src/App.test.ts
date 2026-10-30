import { createPinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import App from './App.vue';
import { decodeSnapshot } from './transport/api';
import { roomFixture } from './test-support/room';

const identity = {
  identity: { identityId: 'a'.repeat(32), displayName: '' },
  csrfToken: 'A'.repeat(43),
  expiresAtMs: 1824681600000,
};
const snapshot = roomFixture;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

test.each([
  ['ready', () => Promise.resolve(new Response(null, { status: 204 })), 'Server: ready'],
  [
    'storage failed',
    () => Promise.resolve(new Response(null, { status: 503 })),
    'Server: online, but cannot save changes',
  ],
  ['stopped', () => Promise.reject(new TypeError('network failure')), 'Server: unreachable'],
] as const)(
  'shows %s server readiness, restores identity, and re-checks when online',
  async (_, health, text) => {
    let healthy = false;
    const fetch = vi.fn((url: string) =>
      url.startsWith('/health')
        ? healthy
          ? Promise.resolve(new Response(null, { status: 204 }))
          : health()
        : Promise.resolve(
            json(url.endsWith('/session') ? identity : { rooms: [], nextCursor: null }),
          ),
    );
    vi.stubGlobal('fetch', fetch);
    const wrapper = mount(App, { global: { plugins: [createPinia()] } });
    await flushPromises();
    expect(wrapper.get('header [role="status"]').text()).toBe(text);
    expect(wrapper.find('main header').exists()).toBe(false);
    expect(document.title).toBe('Your rooms · Open Video Sync');
    expect(wrapper.find('#display-name').exists()).toBe(true);
    // Re-checks are event-driven: no timer polls readiness.
    healthy = true;
    const checks = fetch.mock.calls.filter(([url]) => url.startsWith('/health')).length;
    await vi.waitFor(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(fetch.mock.calls.filter(([url]) => url.startsWith('/health'))).toHaveLength(checks);
    window.dispatchEvent(new Event('online'));
    await flushPromises();
    expect(wrapper.get('header [role="status"]').text()).toBe('Server: ready');
    wrapper.unmount();
  },
);

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
  // Unmounting also releases the readiness re-check listeners.
  window.dispatchEvent(new Event('online'));
  expect(signals).toHaveLength(2);
});

test.each([true, false])(
  'recovers uncertain creation without duplicating expired results (retained=%s)',
  async (retained) => {
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
          : Promise.resolve(
              retained
                ? json({ snapshot, invitation: null, replayed: true })
                : new Response(JSON.stringify({ code: 'request_outcome_unknown' }), {
                    status: 409,
                  }),
            );
      }),
    );
    const wrapper = mount(App, { global: { plugins: [createPinia()] }, attachTo: document.body });
    await flushPromises();
    await wrapper.get('#room-name').setValue('Private room');
    await wrapper
      .get('#create-title')
      .element.parentElement?.querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();
    expect(wrapper.get('#room-name').attributes('readonly')).toBeDefined();
    expect(wrapper.get('[role="alert"]').text()).toContain('Cannot reach the server');
    expect(document.activeElement?.id).toBe('retry-attempt');
    const retry = wrapper
      .findAll('button')
      .find((button) => button.text() === 'Retry original request');
    await retry?.trigger('click');
    await flushPromises();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.body).toBe(attempts[1]?.body);
    expect(new Headers(attempts[0]!.headers).get('Idempotency-Key')).toEqual(
      new Headers(attempts[1]!.headers).get('Idempotency-Key'),
    );
    expect(new Headers(attempts[1]!.headers).get('Idempotency-Replay-Only')).toBe('true');
    if (retained) {
      expect(wrapper.get('#room-title').text()).toBe('Private room');
      expect(wrapper.text()).toContain('Room ready.');
      expect(document.activeElement?.id).toBe('room-title');
      expect(document.title).toBe('Room · Open Video Sync');
    } else {
      expect(wrapper.find('#room-title').exists()).toBe(false);
      expect(wrapper.text()).toContain('Check Your rooms');
      expect(wrapper.get('#room-name').attributes('readonly')).toBeUndefined();
    }
    wrapper.unmount();
  },
);

test('distinguishes input, response, proxy, and unavailable-room failures', async () => {
  const empty = () => json({ rooms: [], nextCursor: null });
  const lists: Response[] = [empty(), empty(), json({})];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, options: RequestInit) => {
      if (url.startsWith('/health')) return Promise.resolve(new Response(null, { status: 204 }));
      if (url.endsWith('/session')) return Promise.resolve(json(identity));
      if (url.startsWith(`/api/v2/rooms/${snapshot.roomId}`))
        return Promise.resolve(
          new Response(JSON.stringify({ code: 'not_found' }), { status: 404 }),
        );
      if (url.endsWith('/invitations/redeem'))
        return Promise.resolve(
          new Response(JSON.stringify({ code: 'invalid_invitation' }), { status: 404 }),
        );
      if (options.method === 'POST') return Promise.resolve(new Response('', { status: 502 }));
      return Promise.resolve(lists.shift() ?? empty());
    }),
  );
  history.replaceState(null, '', `/rooms/${snapshot.roomId}`);
  const wrapper = mount(App, { global: { plugins: [createPinia()] }, attachTo: document.body });
  await flushPromises();
  // A route to a room the server no longer shows returns to the landing view.
  expect(location.pathname).toBe('/');
  expect(wrapper.find('#room-title').exists()).toBe(false);
  expect(wrapper.text()).toContain('is no longer available to you');
  await wrapper.get('#display-name').setValue('bell\u0007');
  await wrapper.get<HTMLInputElement>('#display-name').element.form?.requestSubmit();
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('Use up to 48 characters');
  expect(document.activeElement?.id).toBe('display-name');
  expect(wrapper.get('#display-name').attributes('aria-invalid')).toBe('true');
  const refresh = wrapper.findAll('button').find((b) => b.text() === 'Refresh list');
  await refresh?.trigger('click');
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('unexpected response');
  expect(wrapper.findAll('button').some((b) => b.text() === 'Reload page')).toBe(true);
  await wrapper.get('#join-code').setValue('ABCD-EFGH-JKMN-PQRS');
  await wrapper.get<HTMLInputElement>('#join-code').element.form?.requestSubmit();
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('Check the code');
  expect(document.activeElement?.id).toBe('join-code');
  expect(wrapper.get('#join-code').attributes('aria-invalid')).toBe('true');
  await wrapper.get('#room-name').setValue('Proxy room');
  await wrapper.get<HTMLInputElement>('#room-name').element.form?.requestSubmit();
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('through its proxy (HTTP 502)');
  wrapper.unmount();
});

test('rejects malformed room responses before rendering authority', () => {
  expect(() => decodeSnapshot({ ...snapshot, selfMemberId: 'f'.repeat(32) })).toThrow();
  expect(() => decodeSnapshot({ ...snapshot, signedURL: 'synthetic-credential' })).toThrow();
  expect(() => decodeSnapshot({ ...snapshot, revision: 1.5 })).toThrow();
  expect(decodeSnapshot(snapshot).selfMemberId).toBe(snapshot.selfMemberId);
});
