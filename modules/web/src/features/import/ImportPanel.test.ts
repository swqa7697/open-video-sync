import {
  enableAutoUnmount,
  flushPromises,
  mount,
  type DOMWrapper,
  type VueWrapper,
} from '@vue/test-utils';
import { createPinia } from 'pinia';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { defineComponent, h } from 'vue';

import { i18n } from '../../i18n';
import { roomFixture } from '../../test-support/room';
import { decodeSnapshot, type Snapshot } from '../../transport/api';
import type { MediaDescriptor } from '../../transport/contracts';
import ImportPanel from './ImportPanel.vue';
import type { ImportOutcome } from './types';

const media: MediaDescriptor = {
  kind: 'bilibili',
  bvid: 'BV1TESTaaaaa',
  cid: '1',
  part: 2,
  durationMs: 10000,
};
const initialImport = { selection: { bvid: 'BV1TESTaaaaa', part: 2 } };
const snapshot = { ...roomFixture, title: 'Family room' };
const participantRoom = (everyoneCanSelectMedia: boolean): Snapshot =>
  decodeSnapshot({
    ...snapshot,
    roomId: 'f'.repeat(32),
    title: 'Other host room',
    selfMemberId: 'e'.repeat(32),
    settings: { ...snapshot.settings, everyoneCanSelectMedia },
    members: [
      ...snapshot.members,
      {
        memberId: 'e'.repeat(32),
        displayName: 'Participant',
        role: 'participant',
        presence: 'offline',
        readiness: null,
      },
    ],
  });
const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    headers: { 'Content-Type': 'application/json' },
  });
const selectBilibili = vi.fn(async () => {});
const picker = defineComponent({
  setup(_, { expose }) {
    expose({
      prepare: async () => ({ media, title: 'Selected video title' }),
      selectBilibili,
    });
    return () => null;
  },
});
enableAutoUnmount(afterEach);
afterEach(() => {
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
  i18n.global.locale.value = 'en';
});
const findButton = (
  wrapper: VueWrapper | DOMWrapper<Element>,
  text: string,
) => {
  const button = wrapper
    .findAll('button')
    .find(
      (button) => (button.attributes('aria-label') ?? button.text()) === text,
    );
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
};
function panel(
  replace: (
    snapshot: Snapshot,
    media: MediaDescriptor,
  ) => Promise<ImportOutcome>,
  openRoom: (
    snapshot: Snapshot,
    media: MediaDescriptor,
  ) => Promise<ImportOutcome> = async () => ({ status: 'accepted' }),
  disabled = false,
  everyoneCanSelectMedia = false,
) {
  const participant = participantRoom(everyoneCanSelectMedia);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      json(
        url.includes('/rooms?')
          ? {
              rooms: [
                {
                  roomId: snapshot.roomId,
                  title: snapshot.title,
                  role: 'host',
                },
                {
                  roomId: participant.roomId,
                  title: participant.title,
                  role: 'participant',
                },
              ],
              nextCursor: null,
            }
          : url.endsWith(participant.roomId)
            ? participant
            : snapshot,
      ),
    ),
  );
  const host = defineComponent({
    props: { disabled: Boolean },
    setup: (props) => () =>
      h(ImportPanel, {
        initialImport,
        replace,
        openRoom,
        disabled: props.disabled,
      }),
  });
  return mount(host, {
    attachTo: document.body,
    props: { disabled },
    global: {
      plugins: [createPinia()],
      stubs: {
        MediaPicker: picker,
        Modal: { template: '<div role="dialog"><slot /></div>' },
      },
    },
  });
}
async function chooseRoom(
  wrapper: VueWrapper,
  roomId = snapshot.roomId,
): Promise<void> {
  await flushPromises();
  await findButton(wrapper, 'Preview and continue').trigger('click');
  await flushPromises();
  await wrapper.get('#import-room').setValue(roomId);
  await flushPromises();
}
async function submitReplacement(wrapper: VueWrapper): Promise<void> {
  await chooseRoom(wrapper);
  await findButton(wrapper, 'Replace video').trigger('click');
  expect(wrapper.get('[role="dialog"]').text()).toContain(
    'Selected video title',
  );
  const confirm = wrapper
    .get('[role="dialog"]')
    .findAll('button')
    .find((button) => button.attributes('aria-label') === 'Replace video')!;
  await confirm.trigger('click');
  await flushPromises();
}

test('prefills after identity bootstrap enables the picker without overwriting later edits', async () => {
  const wrapper = panel(async () => ({ status: 'failed' }), undefined, true);
  await flushPromises();
  expect(selectBilibili).not.toHaveBeenCalled();
  await wrapper.setProps({ disabled: false });
  await flushPromises();
  expect(selectBilibili).toHaveBeenCalledWith(initialImport.selection);
  await wrapper.setProps({ disabled: true });
  await wrapper.setProps({ disabled: false });
  await flushPromises();
  expect(selectBilibili).toHaveBeenCalledTimes(1);
});

test.each([false, true])(
  'previews before mutation, enforces %s media permission, and confirms replacement',
  async (everyoneCanSelectMedia) => {
    const replace = vi.fn(async () => ({ status: 'accepted' as const }));
    const wrapper = panel(replace, undefined, false, everyoneCanSelectMedia);
    const participant = participantRoom(everyoneCanSelectMedia);
    await chooseRoom(wrapper, participant.roomId);
    expect(wrapper.get('#import-room').text()).toContain('Family room');
    expect(wrapper.get('#import-room').text()).toContain('Other host room');
    if (!everyoneCanSelectMedia) {
      expect(wrapper.get('[role="alert"]').text()).toContain(
        'You do not have permission for this action.',
      );
      expect(
        findButton(wrapper, 'Replace video').attributes('disabled'),
      ).toBeDefined();
      await findButton(wrapper, 'Replace video').trigger('click');
      expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
      expect(replace).not.toHaveBeenCalled();
      await wrapper.get('#import-room').setValue(snapshot.roomId);
      await flushPromises();
    }
    expect(wrapper.text()).toContain('Selected video title');
    expect(replace).not.toHaveBeenCalled();
    await findButton(wrapper, 'Replace video').trigger('click');
    expect(wrapper.get('[role="dialog"]').text()).toContain(
      'starts paused at zero',
    );
    await findButton(wrapper.find('[role="dialog"]'), 'Replace video').trigger(
      'click',
    );
    await flushPromises();
    expect(wrapper.text()).toContain('Video replaced.');
    expect(wrapper.find('#import-room').exists()).toBe(false);
    expect(replace).toHaveBeenCalledWith(
      !everyoneCanSelectMedia ? snapshot : participant,
      media,
    );
  },
);

test('missing active tab requires explicit takeover and preserves the confirmed snapshot', async () => {
  const openRoom = vi.fn(async () => ({ status: 'accepted' as const }));
  const wrapper = panel(async () => ({ status: 'unavailable' }), openRoom);
  await submitReplacement(wrapper);
  expect(openRoom).not.toHaveBeenCalled();
  expect(wrapper.text()).toContain('An older room tab will stop playing.');
  await findButton(wrapper, 'Open room here and replace video').trigger(
    'click',
  );
  await flushPromises();
  expect(openRoom).toHaveBeenCalledWith(snapshot, media);
});

test('a changed room during fallback can refresh and confirm a new replacement', async () => {
  const wrapper = panel(
    async () => ({ status: 'unavailable' }),
    async () => ({ status: 'stale' }),
  );
  await submitReplacement(wrapper);
  await findButton(wrapper, 'Open room here and replace video').trigger(
    'click',
  );
  await flushPromises();
  expect(wrapper.text()).toContain('The room changed.');
  expect(
    wrapper
      .findAll('button')
      .some((button) => button.text() === 'Open room here and replace video'),
  ).toBe(false);
  await findButton(wrapper, 'Refresh room details').trigger('click');
  await flushPromises();
  expect(
    findButton(wrapper, 'Replace video').attributes('disabled'),
  ).toBeUndefined();
  await findButton(wrapper, 'Replace video').trigger('click');
  expect(wrapper.get('[role="dialog"]').text()).toContain(
    'Selected video title',
  );
});

test('uncertain outcomes lock new mutations and retry the original confirmed intent', async () => {
  const replace = vi
    .fn()
    .mockResolvedValueOnce({ status: 'uncertain' })
    .mockResolvedValueOnce({ status: 'accepted' });
  const wrapper = panel(replace);
  await submitReplacement(wrapper);
  expect(
    wrapper
      .findAll('button')
      .some((button) => button.text() === 'Open room here and replace video'),
  ).toBe(false);
  expect(wrapper.get('#import-room').attributes('disabled')).toBeDefined();
  expect(
    findButton(wrapper, 'Create room').attributes('disabled'),
  ).toBeDefined();
  await findButton(wrapper, 'Check original request').trigger('click');
  await flushPromises();
  expect(replace.mock.calls).toEqual([
    [snapshot, media],
    [snapshot, media],
  ]);
  expect(wrapper.text()).toContain('Video replaced.');
});

test('new room creation carries the previewed media only after explicit submission', async () => {
  const wrapper = panel(async () => ({ status: 'failed' }));
  await flushPromises();
  await findButton(wrapper, 'Preview and continue').trigger('click');
  await flushPromises();
  expect(wrapper.findComponent(ImportPanel).emitted('create')).toBeUndefined();
  await wrapper.get('#import-room-title').setValue('Friday night');
  await findButton(wrapper, 'Replace a room’s video').trigger('click');
  await wrapper.get('#import-room').setValue(snapshot.roomId);
  await flushPromises();
  await findButton(wrapper, 'Create a new room').trigger('click');
  expect(
    wrapper.get<HTMLInputElement>('#import-room-title').element.value,
  ).toBe('Friday night');
  expect(wrapper.findComponent(ImportPanel).emitted('create')).toBeUndefined();
  await wrapper.get('form').trigger('submit');
  expect(wrapper.findComponent(ImportPanel).emitted('create')).toEqual([
    [{ media, title: 'Friday night' }],
  ]);
});
