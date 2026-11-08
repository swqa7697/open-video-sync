import { mount } from '@vue/test-utils';
import { expect, test } from 'vite-plus/test';
import { h, nextTick, reactive } from 'vue';

import type { Playlist } from '../../player/bilibili/media';
import { roomFixture } from '../../test-support/room';
import { decodeSnapshot } from '../../transport/api';
import RoomSidebar from './RoomSidebar.vue';

// This new surface owns tab navigation, current-episode marking, and read-only viewing.
test('episode tabs preserve keyboard access and allow only permitted selections', async () => {
  const first = { bvid: 'BV1TESTaaaaa', part: 1, title: 'Opening' },
    second = {
      bvid: 'BV1TESTaaaab',
      part: 2,
      title: '<script>Finale</script>',
    };
  const state = reactive({
    room: decodeSnapshot({
      ...roomFixture,
      mediaGeneration: 1,
      playback: { ...roomFixture.playback, phase: 'paused' },
      media: {
        kind: 'bilibili',
        bvid: first.bvid,
        cid: '1',
        part: 1,
        durationMs: 10000,
      },
    }),
    host: true,
    busy: false,
    canSelectEpisode: true,
    playlist: { title: 'Collection', episodes: [first, second] } as
      Playlist | undefined,
  });
  const wrapper = mount(
    { render: () => h(RoomSidebar, state) },
    {
      attachTo: document.body,
    },
  );
  const sidebar = wrapper.findComponent(RoomSidebar);
  try {
    await wrapper.get('#members-tab').trigger('keydown', { key: 'ArrowRight' });
    expect(document.activeElement).toBe(wrapper.get('#episodes-tab').element);
    expect(wrapper.get('#episodes-tab').attributes('aria-selected')).toBe(
      'true',
    );
    expect(wrapper.get('[aria-current="true"]').text()).toContain('Opening');
    expect(wrapper.find('script').exists()).toBe(false);
    const buttons = wrapper.findAll('.episode-button');
    await buttons[0]!.trigger('click');
    expect(sidebar.emitted('selectEpisode')).toBeUndefined();
    await buttons[1]!.trigger('click');
    expect(sidebar.emitted('selectEpisode')).toEqual([[second]]);
    state.host = false;
    state.canSelectEpisode = false;
    await nextTick();
    expect(wrapper.text()).toContain('The host chooses');
    await buttons[1]!.trigger('click');
    expect(sidebar.emitted('selectEpisode')).toHaveLength(1);
    expect(buttons[1]!.attributes('disabled')).toBeDefined();
    state.room.settings.everyoneCanSelectMedia = true;
    state.canSelectEpisode = true;
    await nextTick();
    expect(wrapper.text()).toContain('Choose an episode for everyone.');
    await buttons[1]!.trigger('click');
    expect(sidebar.emitted('selectEpisode')).toHaveLength(2);
    await wrapper.get('#episodes-tab').trigger('keydown', { key: 'Home' });
    expect(document.activeElement).toBe(wrapper.get('#members-tab').element);
    await wrapper.get('#members-tab').trigger('keydown', { key: 'End' });
    state.playlist = undefined;
    await nextTick();
    await nextTick();
    expect(wrapper.find('[role="tablist"]').exists()).toBe(false);
    expect(wrapper.get('.roster').isVisible()).toBe(true);
    expect(document.activeElement).toBe(
      wrapper.get('#participants-title').element,
    );
  } finally {
    wrapper.unmount();
  }
});
