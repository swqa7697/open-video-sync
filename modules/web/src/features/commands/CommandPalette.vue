<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  useId,
  watch,
} from 'vue';

import Icon from '../../components/Icon.vue';
import { vKeyboardBoundary } from '../../components/overlay-keyboard';
import { errorMessage, t, translate } from '../../i18n';
import { sameEpisode, selectionInput } from '../../player/bilibili/media';
import {
  searchCommands,
  searchEpisodes,
  type CommandMatch,
  type EpisodeActions,
  type EpisodeMatch,
  type QuickCommand,
} from './search';

const props = defineProps<{
  commands: QuickCommand[];
  episodes?: EpisodeActions | undefined;
  context?: string;
}>();
const emit = defineEmits<{ close: [] }>();
const id = useId();
const dialog = ref<HTMLDialogElement>();
const input = ref<HTMLInputElement>();
const results = ref<HTMLElement>();
const query = ref('');
const selected = ref(0);
let trigger: HTMLElement | null = null;
let choosing = false;
let submitted = false;
const episodeMode = computed(() => query.value.trim().startsWith('@'));
const switching = computed(() =>
  ['loading', 'pending'].includes(props.episodes?.selection?.phase ?? ''),
);
const currentNumber = computed(
  () =>
    props.episodes?.playlist?.episodes.findIndex((episode) =>
      sameEpisode(props.episodes?.current, episode),
    ) ?? -1,
);
const commands = computed<QuickCommand[]>(() =>
  props.episodes?.playlist
    ? [
        {
          id: 'episodes',
          label: t('episodes.switch'),
          group: 'watch',
          icon: 'screen',
          shortcut: '@',
          aliases: 'episode episodes playlist 选集 换集 分集',
          detail: t('episodes.searchHint'),
          run: () => {
            query.value = '@';
            input.value?.focus();
          },
        },
        ...props.commands,
      ]
    : props.commands,
);
const search = computed(() => {
  try {
    return {
      matches: episodeMode.value
        ? []
        : searchCommands(commands.value, query.value),
      error: '',
    };
  } catch (reason) {
    return {
      matches: [],
      error: translate(errorMessage(reason, 'media.validSelection')),
    };
  }
});
interface Option {
  id: string;
  label: string;
  detail: string | undefined;
  icon: string;
  shortcut: string;
  disabled: boolean;
  group: QuickCommand['group'];
  current?: boolean;
  pending?: boolean;
  command?: CommandMatch;
  episode?: EpisodeMatch;
}
const matches = computed<Option[]>(() => {
  if (episodeMode.value)
    return props.episodes?.playlist
      ? searchEpisodes(props.episodes.playlist, query.value).map((entry) => {
          const current = sameEpisode(props.episodes?.current, entry.episode);
          const pending =
            switching.value &&
            sameEpisode(props.episodes?.selection?.episode, entry.episode);
          return {
            id: `episode-${entry.number}`,
            label: entry.episode.title,
            detail: undefined,
            icon: 'screen',
            shortcut: String(entry.number),
            disabled: !props.episodes?.canSelect || switching.value || current,
            group: 'watch',
            current,
            pending,
            episode: entry,
          };
        })
      : [];
  return search.value.matches.map((match) => ({
    id: match.command.id,
    label: match.command.label,
    detail: match.selection
      ? `${selectionInput(match.selection)} · ${t('player.part', { part: match.selection.part })}`
      : match.command.detail,
    icon: match.command.icon,
    shortcut: match.command.shortcut,
    disabled: !!match.command.disabled,
    group: match.command.group,
    command: match,
  }));
});
const index = computed(() =>
  Math.min(selected.value, Math.max(0, matches.value.length - 1)),
);
const activeId = computed(() =>
  matches.value.length ? `${id}-option-${index.value}` : undefined,
);
const hint = computed(() =>
  episodeMode.value
    ? t('episodes.searchHint')
    : query.value.trim().startsWith('$')
      ? t('commands.videoHint')
      : t('commands.hint'),
);
const empty = computed(() => {
  if (!episodeMode.value) return search.value.error || t('commands.noResults');
  if (!props.episodes) return t('episodes.noRoom');
  if (!props.episodes.playlist) return props.episodes.unavailable;
  const value = query.value.trim().slice(1).trim();
  return /^[0-9]+$/.test(value)
    ? t('episodes.noNumber', {
        number: value.slice(0, 20),
        count: props.episodes.playlist.episodes.length,
      })
    : t('episodes.noResults');
});
const playlistKey = computed(
  () =>
    props.episodes?.playlist?.episodes
      .map(
        (episode) =>
          `${episode.bvid}:${episode.part}:${episode.episodeId ?? ''}`,
      )
      .join('|') ?? '',
);
watch([() => props.context, playlistKey], ([context], [previous]) => {
  if (
    context === previous &&
    submitted &&
    props.episodes?.selection &&
    props.episodes.selection.phase !== 'failed'
  )
    return;
  submitted = false;
  if (episodeMode.value) query.value = '';
});
watch(
  () => props.episodes?.selection?.phase,
  (phase) => {
    if (phase === 'failed') submitted = false;
  },
);

watch(
  query,
  () => {
    selected.value =
      episodeMode.value && query.value.trim() === '@'
        ? Math.max(0, currentNumber.value)
        : 0;
  },
  { flush: 'sync' },
);
watch([index, matches], async () => {
  await nextTick();
  const list = results.value;
  const option = activeId.value && document.getElementById(activeId.value);
  if (!list || !option) return;
  // Scroll only the result list; keep the input fixed while navigating.
  const bounds = list.getBoundingClientRect(),
    row = option.getBoundingClientRect();
  if (row.top < bounds.top) list.scrollTop += row.top - bounds.top;
  else if (row.bottom > bounds.bottom)
    list.scrollTop += row.bottom - bounds.bottom;
});
async function choose(match: Option): Promise<void> {
  if (match.disabled || choosing) return;
  if (match.episode) {
    submitted = true;
    props.episodes?.select(match.episode.episode);
    return;
  }
  if (match.command?.command.id === 'episodes') {
    match.command.command.run();
    return;
  }
  choosing = true;
  emit('close');
  // Restore the original trigger before a destination dialog or field takes focus.
  await nextTick();
  match.command?.command.run(match.command.selection);
}
function keyboard(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const count = matches.value.length;
    if (count)
      selected.value =
        (index.value + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
  } else if (event.key === 'Enter') {
    event.preventDefault();
    const match = matches.value[index.value];
    if (match) void choose(match);
  }
}
function shortcut(event: KeyboardEvent): void {
  if (
    !event.defaultPrevented &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    !event.altKey &&
    !event.shiftKey &&
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === 'k'
  ) {
    event.preventDefault();
    if (!event.repeat) emit('close');
  }
}
onMounted(() => {
  trigger =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  dialog.value?.showModal();
  input.value?.focus();
});
onBeforeUnmount(() => {
  dialog.value?.close();
  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
});
</script>

<template>
  <dialog
    ref="dialog"
    v-keyboard-boundary="() => emit('close')"
    class="command-palette"
    :aria-labelledby="`${id}-title`"
    @cancel.prevent="emit('close')"
    @keydown="shortcut"
    @click="(event) => event.target === dialog && emit('close')"
  >
    <div class="command-heading">
      <h2 :id="`${id}-title`">{{ t('commands.title') }}</h2>
      <button
        type="button"
        class="quiet icon-button"
        :aria-label="t('common.closeDialog')"
        @click="emit('close')"
      >
        <Icon name="close" />
      </button>
    </div>
    <div class="command-search">
      <Icon name="search" />
      <input
        ref="input"
        v-model="query"
        role="combobox"
        :aria-label="t('commands.search')"
        :aria-controls="`${id}-results`"
        :aria-activedescendant="activeId"
        :aria-describedby="`${id}-hint`"
        :aria-expanded="matches.length > 0"
        aria-autocomplete="list"
        :placeholder="t('commands.placeholder')"
        maxlength="2050"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        enterkeyhint="go"
        @keydown="keyboard"
      />
    </div>
    <p :id="`${id}-hint`" class="command-hint">{{ hint }}</p>
    <div
      v-if="episodeMode && episodes?.playlist"
      class="command-episodes-heading"
    >
      <strong>{{ episodes.playlist.title || t('episodes.title') }}</strong>
      <span>{{
        currentNumber >= 0
          ? t('episodes.summaryCurrent', {
              count: episodes.playlist.episodes.length,
              current: currentNumber + 1,
            })
          : t('episodes.summary', { count: episodes.playlist.episodes.length })
      }}</span>
      <p>{{ episodes.note }}</p>
    </div>
    <p
      v-if="episodeMode && episodes?.selection?.phase === 'failed'"
      class="command-error"
      role="alert"
    >
      {{ episodes.selection.error }}
    </p>
    <div
      :id="`${id}-results`"
      ref="results"
      class="command-results"
      role="listbox"
      :aria-label="t('commands.title')"
    >
      <template v-for="(match, i) in matches" :key="match.id">
        <p
          v-if="
            !episodeMode && (i === 0 || matches[i - 1]?.group !== match.group)
          "
          class="command-group"
          role="presentation"
        >
          {{ t(`commands.${match.group}`) }}
        </p>
        <div
          :id="`${id}-option-${i}`"
          role="option"
          :aria-selected="i === index"
          :aria-disabled="match.disabled || undefined"
          :aria-current="match.current ? 'true' : undefined"
          :aria-busy="match.pending || undefined"
          class="command-option"
          @pointermove="
            (event) => {
              if (event.pointerType === 'mouse') selected = i;
            }
          "
          @pointerdown="
            (event) => {
              if (event.pointerType === 'mouse') event.preventDefault();
            }
          "
          @click="choose(match)"
        >
          <span v-if="match.episode" class="command-episode-number">{{
            match.episode.number
          }}</span>
          <span v-else class="command-icon"
            ><Icon :name="match.icon" :size="18"
          /></span>
          <span class="command-label"
            ><strong>{{ match.label }}</strong
            ><span v-if="match.detail">{{ match.detail }}</span></span
          >
          <span
            v-if="match.pending || match.current"
            class="command-episode-state"
            >{{
              match.pending ? t('episodes.switching') : t('episodes.current')
            }}</span
          >
          <code v-if="!match.episode">{{ match.shortcut }}</code>
          <span class="command-enter" aria-hidden="true">↵</span>
        </div>
      </template>
    </div>
    <p v-if="!matches.length" class="command-empty" role="status">
      {{ empty }}
    </p>
    <div class="command-footer">
      <span>{{
        episodeMode
          ? episodes?.canSelect || switching
            ? t('episodes.keyboard')
            : t('episodes.browseKeyboard')
          : t('commands.keyboard')
      }}</span
      ><span><kbd>Esc</kbd> {{ t('common.cancel') }}</span>
    </div>
  </dialog>
</template>

<style scoped>
.command-palette {
  width: min(600px, calc(100% - 32px));
  max-height: calc(100dvh - min(16dvh, 140px) - 24px);
  margin: min(16dvh, 140px) auto 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 24px 100px #0008;
  overflow: hidden;
}
.command-palette[open] {
  display: flex;
  flex-direction: column;
}
.command-palette::backdrop {
  background: var(--scrim);
}
.command-heading,
.command-search,
.command-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  padding: 8px 16px;
}
.command-heading {
  justify-content: space-between;
}
.command-heading h2 {
  font-size: 0.875rem;
  margin: 0;
}
.command-heading button {
  margin-right: -8px;
}
.command-search {
  margin: 0 16px;
  padding: 0 12px;
  border: 1px solid var(--control-border);
  border-radius: 8px;
  background: var(--input);
}
.command-search:focus-within {
  background: var(--surface-raised);
}
.command-search svg {
  color: var(--muted);
  flex-shrink: 0;
}
.command-palette .command-search input[role='combobox'] {
  width: 100%;
  min-width: 0;
  padding: 12px 0;
  border: 0;
  outline: 0;
  background: transparent;
  font-size: max(1rem, 16px);
}
.command-hint {
  flex-shrink: 0;
  margin: 12px 16px 8px;
  color: var(--muted);
  font-size: 0.75rem;
}
.command-episodes-heading {
  flex-shrink: 0;
  padding: 8px 18px;
  overflow-wrap: anywhere;
}
.command-episodes-heading strong,
.command-episodes-heading > span {
  display: block;
}
.command-episodes-heading strong {
  font-size: 0.875rem;
}
.command-episodes-heading > span,
.command-episodes-heading p,
.command-episode-state {
  color: var(--muted);
  font-size: 0.75rem;
}
.command-episodes-heading > span {
  margin-top: 4px;
}
.command-episodes-heading p {
  margin: 8px 0 0;
}
.command-episode-number {
  width: 30px;
  flex-shrink: 0;
  color: var(--muted);
  text-align: center;
  font-variant-numeric: tabular-nums;
}
.command-episode-state {
  flex-shrink: 0;
}
.command-error {
  margin: 8px 16px;
  color: var(--danger-text);
  font-size: 0.875rem;
  overflow-wrap: anywhere;
}
.command-results {
  min-height: 0;
  max-height: 390px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 8px 8px;
}
.command-group {
  margin: 12px 10px 6px;
  color: var(--muted);
  font-size: 0.7rem;
  font-weight: 600;
}
.command-option {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 52px;
  padding: 10px;
  border-radius: 8px;
  cursor: pointer;
  touch-action: manipulation;
  user-select: none;
}
.command-option[aria-selected='true'] {
  background: var(--notice);
  box-shadow: inset 0 0 0 1px var(--accent-border);
}
.command-option[aria-disabled='true'] {
  cursor: not-allowed;
  color: var(--muted);
}
.command-icon {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  flex-shrink: 0;
  border: 1px solid var(--border);
  border-radius: 7px;
  color: var(--primary);
}
.command-label {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.command-label strong {
  display: block;
  font-size: 0.875rem;
  font-weight: 500;
}
.command-label > span {
  display: block;
  font-size: 0.75rem;
  color: var(--muted);
  margin-top: 3px;
}
.command-option code {
  max-width: 40%;
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: 0.7rem;
}
.command-enter {
  width: 14px;
  visibility: hidden;
  color: var(--muted);
}
.command-option[aria-selected='true']:not([aria-disabled='true'])
  .command-enter {
  visibility: visible;
}
.command-empty {
  padding: 24px;
  font-size: 0.875rem;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.command-footer {
  justify-content: space-between;
  flex-wrap: wrap;
  border-top: 1px solid var(--border);
  color: var(--muted);
  font-size: 0.7rem;
  padding-block: 12px;
}
kbd {
  font: inherit;
}
@media (max-width: 760px), (max-height: 600px) {
  .command-palette {
    margin-top: 16px;
    max-height: calc(100dvh - 32px);
  }
}
</style>
