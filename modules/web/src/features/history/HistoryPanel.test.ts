import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, expect, test, vi } from 'vite-plus/test';

import { useHistoryStore } from '../../stores/history';
import { useIdentityStore } from '../../stores/identity';
import type { HistoryEntry } from '../../transport/history';
import HistoryPanel from './HistoryPanel.vue';

const session = {
  identity: { identityId: 'a'.repeat(32), displayName: '' },
  csrfToken: 'A'.repeat(43),
  expiresAtMs: 1824681600000,
};
const part: HistoryEntry = {
  entryId: 'b'.repeat(32),
  video: {
    kind: 'bilibili',
    bvid: 'BV1TESTaaaaa',
    cid: '12',
    part: 2,
    title: 'Synthetic multipart video',
    episodeTitle: 'The second part',
  },
  lastPlayedAtMs: 1000,
};
const episode: HistoryEntry = {
  entryId: 'c'.repeat(32),
  video: {
    ...part.video,
    bvid: 'BV1TESTaaaab',
    cid: '42',
    part: 1,
    episodeId: '42',
    title: 'Synthetic series',
    episodeTitle: 'A particular episode',
  },
  lastPlayedAtMs: 2000,
};
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
afterEach(() => vi.unstubAllGlobals());

test('history browsing preserves exact selections and offers personal management to viewers', async () => {
  const pinia = createPinia();
  useIdentityStore(pinia).session = session;
  let entries = [part, episode];
  let recordingEnabled = true;
  const fetch = vi.fn((url: string, options: RequestInit) => {
    if (options.method === 'DELETE') {
      expect(options.body).toBe('{}');
      entries = url.endsWith('/history')
        ? []
        : entries.filter((entry) => !url.endsWith(entry.entryId));
    }
    if (options.method === 'PATCH') {
      expect(options.headers).toMatchObject({
        'X-OVS-CSRF': session.csrfToken,
      });
      recordingEnabled = false;
    }
    return Promise.resolve(json({ entries, recordingEnabled }));
  });
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('navigator', { clipboard: undefined });
  let wrapper = mount(HistoryPanel, {
    props: { canSelect: true, current: part.video },
    attachTo: document.body,
    global: { plugins: [pinia] },
  });
  try {
    await flushPromises();
    expect(wrapper.findAll('.history-video')).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
    await wrapper.findAll('.history-video')[1]!.trigger('click');
    expect(wrapper.emitted('select')).toEqual([[episode.video]]);
    expect(fetch).toHaveBeenCalledTimes(1);
    wrapper.unmount();
    wrapper = mount(HistoryPanel, {
      props: { canSelect: false, current: episode.video },
      attachTo: document.body,
      global: { plugins: [pinia] },
    });
    await flushPromises();
    expect(
      wrapper.findAll('.history-video')[0]!.attributes('disabled'),
    ).toBeDefined();
    await wrapper.findAll('.history-video')[1]!.trigger('click');
    expect(wrapper.emitted('current')).toHaveLength(1);
    await wrapper.get('input[type="search"]').setValue('ep42');
    expect(wrapper.findAll('.history-video')).toHaveLength(1);
    expect(wrapper.get('.history-original').attributes('href')).toBe(
      'https://www.bilibili.com/bangumi/play/ep42',
    );
    await wrapper.get('.history-copy').trigger('click');
    await flushPromises();
    const manual = wrapper.get<HTMLInputElement>('input[readonly]');
    expect(manual.element.value).toBe(
      'https://www.bilibili.com/bangumi/play/ep42',
    );
    expect(manual.element.selectionStart).toBe(0);
    expect(manual.element.selectionEnd).toBe(manual.element.value.length);
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    manual.element.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    await wrapper.get('.history-delete').trigger('click');
    await flushPromises();
    expect(useHistoryStore(pinia).entries).toEqual([part]);
    await wrapper.get('input[type="search"]').setValue('');
    await wrapper.get('.history-recording input').setValue(false);
    await flushPromises();
    expect(useHistoryStore(pinia).recordingEnabled).toBe(false);
    await wrapper.get('.history-clear').trigger('click');
    expect(useHistoryStore(pinia).entries).toHaveLength(1);
    await wrapper.get('.history-confirm button:last-child').trigger('click');
    await flushPromises();
    expect(useHistoryStore(pinia).entries).toEqual([]);
  } finally {
    wrapper.unmount();
  }
});

test('history operations stay ordered and late responses cannot cross an identity change', async () => {
  const pinia = setActivePinia(createPinia());
  const identity = useIdentityStore(pinia);
  identity.session = session;
  const history = useHistoryStore(pinia);
  let resolveRead: (response: Response) => void = () => {};
  const fetch = vi
    .fn()
    .mockImplementationOnce(
      () => new Promise<Response>((resolve) => (resolveRead = resolve)),
    )
    .mockResolvedValueOnce(json({ entries: [], recordingEnabled: true }));
  vi.stubGlobal('fetch', fetch);
  const reading = history.load();
  await flushPromises();
  const removing = history.remove(part.entryId);
  await flushPromises();
  expect(fetch).toHaveBeenCalledTimes(1);
  resolveRead(json({ entries: [part], recordingEnabled: true }));
  await reading;
  await removing;
  expect(history.entries).toEqual([]);
  fetch.mockImplementationOnce(
    () => new Promise<Response>((resolve) => (resolveRead = resolve)),
  );
  const oldReading = history.load();
  await flushPromises();
  const oldSignal = (fetch.mock.calls[2]![1] as RequestInit).signal;
  identity.session = {
    ...session,
    identity: { ...session.identity, identityId: 'd'.repeat(32) },
  };
  expect(oldSignal?.aborted).toBe(true);
  expect(history.entries).toEqual([]);
  fetch.mockResolvedValueOnce(
    json({ entries: [episode], recordingEnabled: false }),
  );
  await history.load();
  resolveRead(json({ entries: [part], recordingEnabled: true }));
  await oldReading;
  expect(history.entries).toEqual([episode]);
  expect(history.recordingEnabled).toBe(false);
});

test('the bounded history response accepts a full list of Unicode titles', async () => {
  const pinia = setActivePinia(createPinia());
  useIdentityStore(pinia).session = session;
  const entries = Array.from({ length: 100 }, (_, index) => ({
    ...part,
    entryId: index.toString(16).padStart(32, '0'),
    video: {
      ...part.video,
      part: index + 1,
      title: '汉'.repeat(160),
      episodeTitle: '集'.repeat(160),
    },
  }));
  vi.stubGlobal('fetch', () =>
    Promise.resolve(json({ entries, recordingEnabled: true })),
  );
  const history = useHistoryStore(pinia);
  await history.load();
  expect(history.error).toBe('');
  expect(history.entries).toEqual(entries);
});
