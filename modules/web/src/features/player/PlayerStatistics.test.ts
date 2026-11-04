import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, test, vi } from 'vite-plus/test';

import type { PlayerStatistics as StatisticsSnapshot } from '../../player/statistics';
import PlayerStatistics from './PlayerStatistics.vue';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// This panel owns browser-local export and asynchronous observation lifetime. Adapter
// regressions separately own the numerical statistics and media download accounting.
test('statistics export stays bounded and private while polling follows visibility and disposal', async () => {
  vi.useFakeTimers();
  let visible = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
    () => visible as DocumentVisibilityState,
  );
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ sync: '1.2.3', web: '2.3.4', helper: '3.4.5' }),
        ),
      ),
  );
  vi.stubGlobal('navigator', { clipboard: undefined });
  const nativeURL = URL;
  let downloaded: Blob | undefined;
  vi.stubGlobal(
    'URL',
    class extends nativeURL {
      static createObjectURL(blob: Blob): string {
        downloaded = blob;
        return 'blob:statistics-fixture';
      }
      static revokeObjectURL(): void {}
    },
  );
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => {});
  let resolve: (value: StatisticsSnapshot) => void = () => {};
  const read = vi.fn(
    () =>
      new Promise<StatisticsSnapshot>((done) => {
        resolve = done;
      }),
  );
  const wrapper = mount(PlayerStatistics, {
    props: { read },
    attachTo: document.body,
  });
  try {
    await vi.advanceTimersByTimeAsync(2500);
    expect(read).toHaveBeenCalledOnce();
    const value = {
      width: 640,
      height: 360,
      bufferAheadSeconds: 3.2,
      videoSegment: {
        current: 2,
        total: 10,
        url: 'https://cdn.invalid/private?token=synthetic-secret',
      },
      filename: 'private-file.webm',
      provider: { cookie: 'synthetic-secret' },
    };
    resolve(value);
    await flushPromises();
    expect(wrapper.text()).toContain('640 × 360');
    expect(wrapper.text()).not.toContain('Network activity');
    expect(wrapper.text()).not.toContain('Frame rate');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Copy statistics')!
      .trigger('click');
    await flushPromises();
    const copied = wrapper.get<HTMLTextAreaElement>('textarea').element;
    expect(copied.readOnly).toBe(true);
    const exported = JSON.parse(copied.value) as {
      versions: Record<string, string>;
      statistics: StatisticsSnapshot;
    };
    expect(exported.versions.web).toBe('2.3.4');
    expect(exported.statistics).toEqual({
      width: 640,
      height: 360,
      bufferAheadSeconds: 3.2,
      videoSegment: { current: 2, total: 10 },
    });
    expect(copied.value).not.toContain('private');
    expect(copied.value).not.toContain('synthetic-secret');
    await wrapper
      .findAll('button')
      .find((button) => button.text() === 'Download statistics')!
      .trigger('click');
    expect(downloaded?.type).toBe('application/json');
    expect(click).toHaveBeenCalledOnce();
    visible = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledOnce();
    visible = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(2);
    wrapper.unmount();
    resolve({ width: 1920, height: 1080, bufferAheadSeconds: 0 });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(2);
  } finally {
    wrapper.unmount();
  }
});
