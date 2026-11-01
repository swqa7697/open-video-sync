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
import { searchCommands, type CommandMatch, type QuickCommand } from './search';

const props = defineProps<{ commands: QuickCommand[] }>();
const emit = defineEmits<{ close: [] }>();
const id = useId();
const dialog = ref<HTMLDialogElement>();
const input = ref<HTMLInputElement>();
const results = ref<HTMLElement>();
const query = ref('');
const selected = ref(0);
let trigger: HTMLElement | null = null;
let choosing = false;
const search = computed(() => {
  try {
    return { matches: searchCommands(props.commands, query.value), error: '' };
  } catch (reason) {
    return {
      matches: [],
      error: translate(errorMessage(reason, 'media.validSelection')),
    };
  }
});
const matches = computed(() => search.value.matches);
const index = computed(() =>
  Math.min(selected.value, Math.max(0, matches.value.length - 1))
);
const activeId = computed(() =>
  matches.value.length ? `${id}-option-${index.value}` : undefined
);
const hint = computed(() =>
  query.value.trim().startsWith('$')
    ? t('commands.videoHint')
    : t('commands.hint')
);

watch(
  query,
  () => {
    selected.value = 0;
  },
  { flush: 'sync' }
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
async function choose(match: CommandMatch): Promise<void> {
  if (match.command.disabled || choosing) return;
  choosing = true;
  emit('close');
  // Restore the original trigger before a destination dialog or field takes focus.
  await nextTick();
  match.command.run(match.selection);
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
      :id="`${id}-results`"
      ref="results"
      class="command-results"
      role="listbox"
      :aria-label="t('commands.title')"
    >
      <template v-for="(match, i) in matches" :key="match.command.id">
        <p
          v-if="
            i === 0 || matches[i - 1]?.command.group !== match.command.group
          "
          class="command-group"
          role="presentation"
        >
          {{ t(`commands.${match.command.group}`) }}
        </p>
        <div
          :id="`${id}-option-${i}`"
          role="option"
          :aria-selected="i === index"
          :aria-disabled="match.command.disabled || undefined"
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
          <span class="command-icon"
            ><Icon :name="match.command.icon" :size="18"
          /></span>
          <span class="command-label"
            ><strong>{{ match.command.label }}</strong
            ><span v-if="match.selection || match.command.detail">{{
              match.selection
                ? `${match.selection.bvid} · ${t('player.part', { part: match.selection.part })}`
                : match.command.detail
            }}</span></span
          >
          <code>{{ match.command.shortcut }}</code>
          <span class="command-enter" aria-hidden="true">↵</span>
        </div>
      </template>
    </div>
    <p v-if="!matches.length" class="command-empty" role="status">
      {{ search.error || t('commands.noResults') }}
    </p>
    <div class="command-footer">
      <span>{{ t('commands.keyboard') }}</span
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
.command-option[aria-selected='true'] .command-enter {
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
