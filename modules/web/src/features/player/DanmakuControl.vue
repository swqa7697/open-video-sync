<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';

import Icon from '../../components/Icon.vue';
import { vKeyboardBoundary } from '../../components/overlay-keyboard';
import { t } from '../../i18n';
import { positionPlayerPopover } from './player-popover';

const props = defineProps<{
  open: boolean;
  visible: boolean;
  density: number;
  fontSize: number;
  speed: number;
  area: number;
  stage: HTMLElement | undefined;
}>();
const emit = defineEmits<{
  'update:open': [value: boolean];
  'update:density': [value: number];
  'update:fontSize': [value: number];
  'update:speed': [value: number];
  'update:area': [value: number];
  toggle: [];
}>();
const root = ref<HTMLElement>(),
  trigger = ref<HTMLButtonElement>(),
  panel = ref<HTMLElement>();
const panelId = useId(),
  titleId = useId();

function close(restoreFocus = false): void {
  emit('update:open', false);
  if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}
function focusOut(event: FocusEvent): void {
  // The surface click closes menus before it can toggle playback.
  if (
    event.relatedTarget === props.stage ||
    event.relatedTarget === props.stage?.querySelector('video')
  )
    return;
  if (
    !(event.relatedTarget instanceof Node) ||
    !root.value?.contains(event.relatedTarget)
  )
    close();
}
function openSettings(): void {
  emit('update:open', true);
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
  close(!!panel.value?.contains(document.activeElement));
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
    if (!props.open || !panel.value) return;
    if (trigger.value && props.stage)
      positionPlayerPopover(panel.value, trigger.value, props.stage, 272);
    panel.value
      .querySelector<HTMLInputElement>('input')
      ?.focus({ preventScroll: true });
  },
);
onMounted(() => {
  document.addEventListener('pointerdown', outside);
  window.addEventListener('resize', resized);
});
onUnmounted(() => {
  document.removeEventListener('pointerdown', outside);
  window.removeEventListener('resize', resized);
});
</script>

<template>
  <div ref="root" class="danmaku-control" @focusout="focusOut">
    <button
      type="button"
      class="icon-button danmaku-toggle"
      :aria-label="t(visible ? 'commands.hideDanmaku' : 'player.showDanmaku')"
      :aria-pressed="visible"
      :title="`${t(visible ? 'commands.hideDanmaku' : 'player.showDanmaku')} (D)`"
      aria-keyshortcuts="D"
      @click="emit('toggle')"
    >
      <Icon :name="visible ? 'chat' : 'chat-off'" />
    </button>
    <button
      ref="trigger"
      type="button"
      class="icon-button danmaku-settings-trigger"
      :aria-label="t('player.danmakuSettings')"
      :aria-expanded="open"
      :aria-controls="panelId"
      aria-haspopup="dialog"
      :title="t('player.danmakuSettings')"
      @click="emit('update:open', !open)"
      @keydown.down.stop.prevent="openSettings"
    >
      <Icon name="chat-settings" />
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
    </div>
  </div>
</template>
