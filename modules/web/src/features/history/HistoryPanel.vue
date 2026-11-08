<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId } from 'vue';

import FormFeedback from '../../components/FormFeedback.vue';
import Icon from '../../components/Icon.vue';
import { i18n, t, translate } from '../../i18n';
import { sameEpisode, type Episode } from '../../player/bilibili/media';
import { useHistoryStore } from '../../stores/history';
import { historyVideoURL, type HistoryVideo } from '../../transport/history';

const props = withDefaults(
  defineProps<{
    current?: Pick<Episode, 'bvid' | 'part' | 'episodeId'> | undefined;
    canSelect?: boolean;
  }>(),
  { canSelect: true },
);
const emit = defineEmits<{ select: [video: HistoryVideo]; current: [] }>();
const history = useHistoryStore();
const query = ref('');
const confirmingClear = ref(false);
const copyNotice = ref<'history.copied' | 'history.selectLink' | ''>('');
const copyURL = ref('');
const manualLink = ref<HTMLInputElement>();
const id = useId();
const filtered = computed(() => {
  const words = query.value.trim().toLocaleLowerCase().split(/\s+/);
  return history.entries.filter(({ video }) => {
    const text =
      `${video.title} ${video.episodeTitle} ${video.bvid} ${video.episodeId ? `ep${video.episodeId}` : ''}`.toLocaleLowerCase();
    return words.every((word) => text.includes(word));
  });
});
const formatDate = computed(
  () =>
    new Intl.DateTimeFormat(i18n.global.locale.value, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
);
function choose(video: HistoryVideo): void {
  if (sameEpisode(props.current, video)) emit('current');
  else if (props.canSelect) emit('select', video);
}
async function clear(): Promise<void> {
  await history.clear();
  if (!history.error) confirmingClear.value = false;
}
async function changeRecording(event: Event): Promise<void> {
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  await history.setRecording(input.checked);
  input.checked = history.recordingEnabled;
}
function selectLink(event: FocusEvent): void {
  if (event.target instanceof HTMLInputElement) event.target.select();
}
async function copy(video: HistoryVideo): Promise<void> {
  const url = historyVideoURL(video);
  copyURL.value = '';
  try {
    if (!navigator.clipboard) throw new Error('unavailable');
    await navigator.clipboard.writeText(url);
    copyNotice.value = 'history.copied';
  } catch {
    copyURL.value = url;
    copyNotice.value = 'history.selectLink';
    await nextTick();
    manualLink.value?.focus();
    manualLink.value?.select();
  }
}
function enter(event: KeyboardEvent): void {
  event.stopPropagation();
  // A search or manual-copy field inside the replacement form must never submit it.
  if (event.target instanceof HTMLInputElement) event.preventDefault();
}
onMounted(() => void history.load());
</script>

<template>
  <section
    class="watch-history"
    :aria-label="t('history.title')"
    @keydown.enter="enter"
  >
    <div class="history-toolbar">
      <label class="history-recording">
        <input
          type="checkbox"
          :checked="history.recordingEnabled"
          :disabled="history.saving || history.loading"
          @change="changeRecording"
        />
        {{ t('history.recording') }}
      </label>
      <button
        type="button"
        class="quiet icon-button"
        :aria-label="t('history.refresh')"
        :title="t('history.refresh')"
        :disabled="history.loading || history.saving"
        @click="history.load()"
      >
        <Icon name="replay" :size="17" />
      </button>
      <button
        type="button"
        class="quiet history-clear"
        :disabled="!history.entries.length || history.loading || history.saving"
        @click="confirmingClear = !confirmingClear"
      >
        {{ t('history.clear') }}
      </button>
    </div>
    <div v-if="confirmingClear" class="history-confirm" role="group">
      <p>{{ t('history.clearConfirm') }}</p>
      <div class="actions">
        <button type="button" class="quiet" @click="confirmingClear = false">
          {{ t('common.cancel') }}
        </button>
        <button type="button" :disabled="history.saving" @click="clear">
          {{ t('history.clear') }}
        </button>
      </div>
    </div>
    <label :for="id" class="visually-hidden">{{ t('history.search') }}</label>
    <input
      :id="id"
      v-model="query"
      type="search"
      autocomplete="off"
      :placeholder="t('history.search')"
    />
    <FormFeedback
      reserve
      :text="history.error ? translate(history.error) : ''"
      tone="error"
      :announce="!!history.error"
    />
    <div class="history-results" :aria-busy="history.loading">
      <p v-if="history.loading && !history.entries.length" role="status">
        {{ t('history.loading') }}
      </p>
      <p v-else-if="!filtered.length" class="history-empty" role="status">
        {{ t(history.entries.length ? 'history.noResults' : 'history.empty') }}
      </p>
      <ol v-else class="history-list">
        <li v-for="entry in filtered" :key="entry.entryId">
          <button
            type="button"
            class="quiet history-video"
            :disabled="!canSelect && !sameEpisode(current, entry.video)"
            :aria-current="
              sameEpisode(current, entry.video) ? 'true' : undefined
            "
            @click="choose(entry.video)"
          >
            <span class="history-video-title" :title="entry.video.title">
              {{ entry.video.title || entry.video.bvid }}
            </span>
            <span class="history-episode" :title="entry.video.episodeTitle">
              {{ entry.video.episodeTitle }}
              <span v-if="entry.video.episodeTitle" aria-hidden="true">
                ·
              </span>
              {{
                entry.video.episodeId
                  ? `EP ${entry.video.episodeId}`
                  : t('player.part', { part: entry.video.part })
              }}
            </span>
            <span class="history-time">
              <span v-if="sameEpisode(current, entry.video)">
                {{ t('history.current') }} ·
              </span>
              {{ formatDate.format(entry.lastPlayedAtMs) }}
            </span>
          </button>
          <a
            class="quiet icon-button history-original"
            :href="historyVideoURL(entry.video)"
            target="_blank"
            rel="noreferrer"
            :aria-label="t('history.original')"
            :title="t('history.original')"
          >
            <Icon name="link" :size="17" />
          </a>
          <button
            type="button"
            class="quiet icon-button history-copy"
            :aria-label="t('history.copy')"
            :title="t('history.copy')"
            @click="copy(entry.video)"
          >
            <Icon name="copy" :size="17" />
          </button>
          <button
            type="button"
            class="quiet icon-button history-delete"
            :disabled="history.saving || history.loading"
            :aria-label="
              t('history.remove', {
                title: entry.video.title || entry.video.bvid,
              })
            "
            :title="t('history.removeShort')"
            @click="history.remove(entry.entryId)"
          >
            <Icon name="trash" :size="17" />
          </button>
        </li>
      </ol>
    </div>
    <div v-if="copyNotice" class="history-copy-result">
      <p class="hint" role="status">{{ t(copyNotice) }}</p>
      <input
        v-if="copyURL"
        ref="manualLink"
        :aria-label="t('history.copy')"
        :value="copyURL"
        readonly
        @focus="selectLink"
      />
    </div>
    <p class="hint history-footnote">{{ t('history.hint') }}</p>
    <p v-if="!canSelect" class="hint">{{ t('history.readOnly') }}</p>
  </section>
</template>
