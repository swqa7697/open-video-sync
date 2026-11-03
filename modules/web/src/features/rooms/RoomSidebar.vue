<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';

import Icon from '../../components/Icon.vue';
import { t } from '../../i18n';
import {
  sameEpisode,
  type Episode,
  type Playlist,
} from '../../player/bilibili/media';
import type { Snapshot } from '../../transport/api';
import { settingsSummary } from '../status-text';
import MembersPanel from './MembersPanel.vue';

const props = defineProps<{
  room: Snapshot;
  host: boolean;
  busy: boolean;
  playlist?: Playlist | undefined;
  canSelectEpisode: boolean;
}>();
const emit = defineEmits<{
  remove: [id: string];
  selectEpisode: [episode: Episode];
}>();
const tab = ref<'members' | 'episodes'>('members');
const root = ref<HTMLElement>();
const membersTab = ref<HTMLButtonElement>();
const episodesTab = ref<HTMLButtonElement>();
watch(
  () => props.playlist,
  async (playlist) => {
    if (playlist || tab.value !== 'episodes') return;
    const focused = root.value?.contains(document.activeElement);
    tab.value = 'members';
    await nextTick();
    if (focused)
      root.value?.querySelector<HTMLElement>('#participants-title')?.focus();
  },
);
function keydown(event: KeyboardEvent): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  tab.value =
    event.key === 'Home'
      ? 'members'
      : event.key === 'End'
        ? 'episodes'
        : tab.value === 'members'
          ? 'episodes'
          : 'members';
  (tab.value === 'members' ? membersTab : episodesTab).value?.focus();
}
function current(episode: Episode): boolean {
  return (
    props.room.media?.kind === 'bilibili' &&
    sameEpisode(props.room.media, episode)
  );
}
function showMembers(): void {
  tab.value = 'members';
  void nextTick(() =>
    (
      membersTab.value ??
      root.value?.querySelector<HTMLElement>('#participants-title')
    )?.focus(),
  );
}
defineExpose({ showMembers });
</script>
<template>
  <div ref="root" class="room-sidebar">
    <div
      v-if="playlist"
      class="sidebar-tabs"
      role="tablist"
      :aria-label="t('room.sidebar')"
      @keydown="keydown"
    >
      <button
        id="members-tab"
        ref="membersTab"
        role="tab"
        :aria-selected="tab === 'members'"
        :tabindex="tab === 'members' ? 0 : -1"
        aria-controls="members-pane"
        @click="tab = 'members'"
      >
        <Icon name="users" :size="16" />{{ t('room.members')
        }}<span class="count">{{ room.members.length }}</span>
      </button>
      <button
        id="episodes-tab"
        ref="episodesTab"
        role="tab"
        :aria-selected="tab === 'episodes'"
        :tabindex="tab === 'episodes' ? 0 : -1"
        aria-controls="episodes-pane"
        @click="tab = 'episodes'"
      >
        <Icon name="screen" :size="16" />{{ t('episodes.title')
        }}<span class="count">{{ playlist.episodes.length }}</span>
      </button>
    </div>
    <div
      id="members-pane"
      v-show="tab === 'members'"
      class="sidebar-pane"
      :role="playlist ? 'tabpanel' : undefined"
      :aria-labelledby="playlist ? 'members-tab' : undefined"
      :tabindex="playlist ? 0 : undefined"
    >
      <MembersPanel
        :room="room"
        :host="host"
        :busy="busy"
        @remove="(id) => emit('remove', id)"
      />
      <div class="panel-policy">
        <Icon name="shield" :size="16" /><span>{{
          settingsSummary(room.settings)
        }}</span>
      </div>
    </div>
    <div
      v-if="playlist"
      id="episodes-pane"
      v-show="tab === 'episodes'"
      class="sidebar-pane episodes-content"
      role="tabpanel"
      aria-labelledby="episodes-tab"
      tabindex="0"
    >
      <div class="episodes-heading">
        <h3>{{ playlist.title || t('episodes.title') }}</h3>
        <p>{{ host ? t('episodes.hostHint') : t('episodes.viewerHint') }}</p>
      </div>
      <ol class="episode-list">
        <li
          v-for="(episode, index) in playlist.episodes"
          :key="`${episode.bvid}:${episode.part}`"
        >
          <button
            class="quiet episode-button"
            :aria-current="current(episode) ? 'true' : undefined"
            :aria-disabled="!canSelectEpisode || current(episode)"
            @click="
              canSelectEpisode &&
              !current(episode) &&
              emit('selectEpisode', episode)
            "
          >
            <span class="episode-number">{{ index + 1 }}</span
            ><span class="episode-name">{{ episode.title }}</span
            ><Icon v-if="current(episode)" name="play" :size="14" />
          </button>
        </li>
      </ol>
    </div>
  </div>
</template>
