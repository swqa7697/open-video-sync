<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

import Icon from '../../components/Icon.vue';
import { vKeyboardBoundary } from '../../components/overlay-keyboard';
import { t } from '../../i18n';
import type { PlayerMenuItem } from './player-menu';

const props = defineProps<{
  items: PlayerMenuItem[];
  position: { x: number; y: number };
  stage: HTMLElement | undefined;
}>();
const emit = defineEmits<{
  select: [id: string];
  close: [restoreFocus: boolean];
}>();
const menu = ref<HTMLElement>();
const left = ref(8),
  top = ref(8),
  maxHeight = ref(0),
  maxWidth = ref(256);
function options(): HTMLElement[] {
  return Array.from(
    menu.value?.querySelectorAll<HTMLElement>(
      '[role="menuitem"]:not(:disabled)',
    ) ?? [],
  );
}
async function place(): Promise<void> {
  await nextTick();
  const bounds = props.stage?.getBoundingClientRect();
  if (!bounds || !menu.value) return;
  const insetLeft = Math.max(8, 8 - bounds.left);
  const insetTop = Math.max(8, 8 - bounds.top);
  const right = Math.min(bounds.width - 8, window.innerWidth - bounds.left - 8);
  const bottom = Math.min(
    bounds.height - 8,
    window.innerHeight - bounds.top - 8,
  );
  maxHeight.value = Math.max(0, bottom - insetTop);
  maxWidth.value = Math.max(0, right - insetLeft);
  await nextTick();
  const element = menu.value;
  if (!element) return;
  const width = element.offsetWidth || Math.min(240, maxWidth.value);
  const height = Math.min(
    element.scrollHeight || props.items.length * 40 + 24,
    maxHeight.value,
  );
  left.value = Math.max(insetLeft, Math.min(props.position.x, right - width));
  top.value = Math.max(insetTop, Math.min(props.position.y, bottom - height));
}
function focusOption(item: HTMLElement | undefined): void {
  if (!item || !menu.value) return;
  item.focus({ preventScroll: true });
  const top = item.offsetTop,
    bottom = top + item.offsetHeight;
  if (top < menu.value.scrollTop) menu.value.scrollTop = top;
  else if (bottom > menu.value.scrollTop + menu.value.clientHeight)
    menu.value.scrollTop = bottom - menu.value.clientHeight;
}
function keyboard(event: KeyboardEvent): void {
  const items = options();
  const index = items.indexOf(document.activeElement as HTMLElement);
  let next: number;
  switch (event.key) {
    case 'ArrowDown':
      next = (index + 1) % items.length;
      break;
    case 'ArrowUp':
      next = (index + items.length - 1) % items.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = items.length - 1;
      break;
    case 'Tab':
      emit('close', false);
      return;
    default:
      return;
  }
  event.preventDefault();
  focusOption(items[next]);
}
function resized(): void {
  emit('close', true);
}
watch(
  () => props.position,
  async () => {
    await place();
    focusOption(options()[0]);
  },
);
onMounted(async () => {
  await place();
  focusOption(options()[0]);
  window.addEventListener('resize', resized);
});
onUnmounted(() => window.removeEventListener('resize', resized));
</script>

<template>
  <div
    ref="menu"
    v-keyboard-boundary="() => emit('close', true)"
    class="player-context-menu"
    role="menu"
    :aria-label="t('player.contextMenu')"
    :style="{
      left: `${left}px`,
      top: `${top}px`,
      maxHeight: `${maxHeight}px`,
      maxWidth: `${maxWidth}px`,
    }"
    @click.stop
    @pointerdown.stop
    @pointermove.stop
    @focusin.stop
    @contextmenu.prevent.stop
    @keydown="keyboard"
  >
    <template v-for="item in items" :key="item.id">
      <div v-if="item.separator" class="context-separator" role="separator" />
      <a
        v-if="item.href"
        :href="item.href"
        target="_blank"
        rel="noopener noreferrer"
        role="menuitem"
        tabindex="-1"
        @click="emit('select', item.id)"
      >
        <Icon :name="item.icon" :size="17" /><span>{{ item.label }}</span
        ><Icon name="arrow" :size="14" />
      </a>
      <button
        v-else
        type="button"
        role="menuitem"
        tabindex="-1"
        :disabled="item.disabled"
        @click="emit('select', item.id)"
      >
        <Icon :name="item.icon" :size="17" /><span>{{ item.label }}</span
        ><kbd v-if="item.shortcut">{{ item.shortcut }}</kbd>
      </button>
    </template>
  </div>
</template>

<style scoped>
.player-context-menu {
  position: absolute;
  z-index: 9;
  width: min(256px, calc(100% - 16px));
  overflow: auto;
  overscroll-behavior: contain;
  padding: 6px;
  border: 1px solid #ffffff26;
  border-radius: 10px;
  background: #15191ff5;
  color: #f0f2f5;
  box-shadow: 0 8px 28px #0006;
  font-size: 0.8rem;
}
.player-context-menu button,
.player-context-menu a {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 38px;
  padding: 8px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-decoration: none;
  text-align: left;
  cursor: pointer;
}
.player-context-menu button:hover,
.player-context-menu a:hover,
.player-context-menu button:focus,
.player-context-menu a:focus {
  background: #ffffff14;
  outline: none;
}
.player-context-menu button:disabled {
  opacity: 0.45;
  cursor: default;
}
.player-context-menu span {
  flex: 1;
}
.player-context-menu kbd {
  color: #b5becb;
  font: inherit;
  font-size: 0.72rem;
}
.context-separator {
  height: 1px;
  margin: 5px 6px;
  background: #ffffff1a;
}
</style>
