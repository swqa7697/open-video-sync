<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';

import Icon from '../../components/Icon.vue';
import { vKeyboardBoundary } from '../../components/overlay-keyboard';
import { t } from '../../i18n';

const props = defineProps<{
  open: boolean;
  visible: boolean;
  density: number;
  fontSize: number;
  speed: number;
  area: number;
  status: string;
  stage: HTMLElement | undefined;
}>();
const emit = defineEmits<{
  'update:open': [value: boolean];
  'update:density': [value: number];
  'update:fontSize': [value: number];
  'update:speed': [value: number];
  'update:area': [value: number];
  toggle: [];
  reload: [];
}>();
const root = ref<HTMLElement>(),
  trigger = ref<HTMLButtonElement>(),
  panel = ref<HTMLElement>();
const panelId = useId(),
  titleId = useId();
let hovered = false,
  ignoreClick = false;
let closing: ReturnType<typeof setTimeout> | undefined;
let holding: ReturnType<typeof setTimeout> | undefined;
let touchStart: { x: number; y: number } | undefined;

function close(restoreFocus = false): void {
  clearTimeout(closing);
  emit('update:open', false);
  if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}
function scheduleClose(): void {
  clearTimeout(closing);
  closing = setTimeout(() => {
    if (!hovered && !panel.value?.contains(document.activeElement)) close();
  }, 150);
}
function enter(event: PointerEvent): void {
  if (
    event.pointerType !== 'mouse' ||
    !matchMedia('(hover: hover) and (pointer: fine)').matches
  )
    return;
  hovered = true;
  clearTimeout(closing);
  emit('update:open', true);
}
function leave(event: PointerEvent): void {
  if (event.pointerType !== 'mouse') return;
  hovered = false;
  scheduleClose();
}
function focusOut(event: FocusEvent): void {
  if (
    !(event.relatedTarget instanceof Node) ||
    !root.value?.contains(event.relatedTarget)
  )
    scheduleClose();
}
async function openAndFocus(): Promise<void> {
  clearTimeout(closing);
  emit('update:open', true);
  await nextTick();
  panel.value
    ?.querySelector<HTMLInputElement>('input')
    ?.focus({ preventScroll: true });
}
function touchDown(event: PointerEvent): void {
  if (event.pointerType === 'touch' && touchStart) return;
  ignoreClick = false;
  if (event.pointerType !== 'touch') return;
  touchStart = { x: event.clientX, y: event.clientY };
  holding = setTimeout(() => {
    ignoreClick = true;
    void openAndFocus();
  }, 500);
}
function cancelHold(): void {
  clearTimeout(holding);
  touchStart = undefined;
}
function touchMove(event: PointerEvent): void {
  if (
    touchStart &&
    Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y) > 10
  )
    cancelHold();
}
function toggle(event: MouseEvent): void {
  if (ignoreClick && event.detail > 0) {
    ignoreClick = false;
    return;
  }
  ignoreClick = false;
  emit('toggle');
}
function outside(event: PointerEvent): void {
  if (
    event.target === props.stage ||
    event.target === props.stage?.querySelector('video')
  )
    return;
  if (event.target instanceof Node && !root.value?.contains(event.target))
    close();
}
function resized(): void {
  cancelHold();
  close();
}
function contextMenu(event: MouseEvent): void {
  if (touchStart || ignoreClick) event.preventDefault();
}
function changeDensity(event: Event): void {
  emit('update:density', Number((event.target as HTMLInputElement).value));
}
function changeSize(event: Event): void {
  emit('update:fontSize', Number((event.target as HTMLInputElement).value));
}
function changeSpeed(event: Event): void {
  emit('update:speed', Number((event.target as HTMLInputElement).value));
}
function changeArea(event: Event): void {
  const value = Number((event.target as HTMLSelectElement).value);
  if (value === 1 || value === 0.5 || value === 0.25)
    emit('update:area', value);
}
watch(
  () => props.open,
  async (value) => {
    if (!value) return;
    await nextTick();
    const bounds = props.stage?.getBoundingClientRect(),
      anchor = trigger.value?.getBoundingClientRect();
    if (!bounds || !anchor || !panel.value) return;
    const width = Math.min(285, bounds.width - 24);
    Object.assign(panel.value.style, {
      width: `${width}px`,
      left: `${Math.max(12, Math.min(bounds.width - width - 12, anchor.right - bounds.left - width))}px`,
      bottom: `${bounds.bottom - anchor.top + 8}px`,
      maxHeight: `${Math.max(0, anchor.top - bounds.top - 20)}px`,
    });
  },
);
onMounted(() => {
  document.addEventListener('pointerdown', outside);
  window.addEventListener('resize', resized);
});
onUnmounted(() => {
  clearTimeout(closing);
  cancelHold();
  document.removeEventListener('pointerdown', outside);
  window.removeEventListener('resize', resized);
});
</script>

<template>
  <div
    ref="root"
    class="danmaku-control"
    @pointerenter="enter"
    @pointerleave="leave"
    @focusout="focusOut"
  >
    <button
      ref="trigger"
      type="button"
      class="icon-button danmaku-toggle"
      :aria-label="t(visible ? 'commands.hideDanmaku' : 'player.showDanmaku')"
      :aria-pressed="visible"
      :aria-expanded="open"
      :aria-controls="panelId"
      aria-haspopup="dialog"
      :title="t('player.danmakuSettingsHint')"
      aria-keyshortcuts="D ArrowDown"
      @click="toggle"
      @keydown.down.stop.prevent="openAndFocus"
      @pointerdown="touchDown"
      @pointermove="touchMove"
      @pointerup="cancelHold"
      @pointercancel="cancelHold"
      @contextmenu="contextMenu"
    >
      <Icon :name="visible ? 'chat' : 'chat-off'" />
    </button>
    <div
      v-if="open"
      :id="panelId"
      ref="panel"
      v-keyboard-boundary="() => close(true)"
      class="player-menu danmaku-menu"
      role="dialog"
      :aria-labelledby="titleId"
    >
      <div class="menu-heading">
        <strong :id="titleId">{{ t('player.danmakuSettings') }}</strong>
        <button
          type="button"
          class="icon-button quiet"
          :aria-label="t('player.closeDanmakuSettings')"
          @click="close(true)"
        >
          <Icon name="close" :size="16" />
        </button>
      </div>
      <label :for="`${panelId}-density`">
        {{ t('player.danmakuDensity') }}
        <output :for="`${panelId}-density`" aria-hidden="true">{{
          density
        }}</output>
      </label>
      <input
        :id="`${panelId}-density`"
        :value="density"
        type="range"
        min="1"
        max="40"
        :aria-valuetext="t('player.commentCount', { count: density })"
        @input="changeDensity"
      />
      <label :for="`${panelId}-size`">
        {{ t('player.danmakuSize') }}
        <output :for="`${panelId}-size`" aria-hidden="true"
          >{{ fontSize }} px</output
        >
      </label>
      <input
        :id="`${panelId}-size`"
        :value="fontSize"
        type="range"
        min="16"
        max="32"
        :aria-valuetext="t('player.pixelCount', { count: fontSize })"
        @input="changeSize"
      />
      <label :for="`${panelId}-speed`">
        {{ t('player.danmakuSpeed') }}
        <output :for="`${panelId}-speed`" aria-hidden="true"
          >{{ speed.toFixed(1) }}×</output
        >
      </label>
      <input
        :id="`${panelId}-speed`"
        :value="speed"
        type="range"
        min="0.5"
        max="1.5"
        step="0.1"
        :aria-valuetext="
          t('player.danmakuSpeedValue', { speed: speed.toFixed(1) })
        "
        @input="changeSpeed"
      />
      <label :for="`${panelId}-area`">{{ t('player.danmakuArea') }}</label>
      <select :id="`${panelId}-area`" :value="area" @change="changeArea">
        <option :value="1">{{ t('player.danmakuAreaFull') }}</option>
        <option :value="0.5">{{ t('player.danmakuAreaHalf') }}</option>
        <option :value="0.25">{{ t('player.danmakuAreaQuarter') }}</option>
      </select>
      <p class="hint" role="status">
        {{ visible ? status : t('player.hiddenDanmaku', { status }) }}
      </p>
      <button type="button" class="quiet" @click="emit('reload')">
        {{ t('player.reloadDanmaku') }}
      </button>
    </div>
  </div>
</template>
