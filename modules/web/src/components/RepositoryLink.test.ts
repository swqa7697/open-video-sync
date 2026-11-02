import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, test, vi } from 'vite-plus/test';

import { i18n } from '../i18n';
import RepositoryLink from './RepositoryLink.vue';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  i18n.global.locale.value = 'en';
});

test.each([0, 1234])(
  'shows %i public stars without sending credentials',
  async (stars) => {
    const fetch = vi.fn(async () => Response.json({ stargazers_count: stars }));
    vi.stubGlobal('fetch', fetch);
    const wrapper = mount(RepositoryLink);
    try {
      expect(wrapper.get('.repo-star-count').text()).toBe('—');
      await flushPromises();
      const count = stars.toLocaleString('en');
      expect(wrapper.get('.repo-star-count').text()).toBe(count);
      expect(wrapper.get('a').attributes('aria-label')).toContain(
        `${count} stars`,
      );
      expect(fetch).toHaveBeenCalledWith(
        'https://api.github.com/repos/swqa7697/open-video-sync',
        expect.objectContaining({
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          redirect: 'error',
        }),
      );
      i18n.global.locale.value = 'zh-CN';
      await flushPromises();
      expect(wrapper.get('a').attributes('aria-label')).toContain(
        `${count} 个 Star`,
      );
    } finally {
      wrapper.unmount();
    }
  },
);

test.each([
  () => Promise.resolve(Response.json({ stargazers_count: -1 })),
  () => Promise.resolve(Response.json({ stargazers_count: '12' })),
  () => Promise.resolve(Response.json(null)),
  () => Promise.resolve(new Response(null, { status: 403 })),
  () => Promise.reject(new TypeError('Network unavailable')),
])(
  'keeps the repository link usable when the count is unavailable (%#)',
  async (fetch) => {
    vi.stubGlobal('fetch', fetch);
    const wrapper = mount(RepositoryLink);
    try {
      await flushPromises();
      expect(wrapper.get('.repo-star-count').text()).toBe('—');
      expect(wrapper.get('a').attributes('href')).toBe(
        'https://github.com/swqa7697/open-video-sync',
      );
      expect(wrapper.get('a').attributes('aria-label')).toBe(
        'Star Open Video Sync on GitHub',
      );
    } finally {
      wrapper.unmount();
    }
  },
);

test('cancels pending requests on timeout and disposal', async () => {
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  vi.stubGlobal('fetch', (_url: string, options: RequestInit) => {
    signals.push(options.signal!);
    return new Promise<Response>(() => {});
  });
  const timedOut = mount(RepositoryLink);
  await vi.advanceTimersByTimeAsync(5000);
  expect(signals[0]!.aborted).toBe(true);
  expect(timedOut.get('.repo-star-count').text()).toBe('—');
  timedOut.unmount();
  const disposed = mount(RepositoryLink);
  disposed.unmount();
  expect(signals[1]!.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
