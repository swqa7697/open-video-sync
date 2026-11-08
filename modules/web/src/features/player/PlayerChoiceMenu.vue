<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';

import Icon from '../../components/Icon.vue';
import { vKeyboardBoundary } from '../../components/overlay-keyboard';
import { positionPlayerPopover } from './player-popover';

const props = defineProps<{
  open: boolean;
  label: string;
  text: string;
  value: number;
  options: { value: number; label: string; disabled?: boolean }[];
  triggerClass: string;
  menuClass?: string;
  menuWidth?: number;
  note?: string;
  stage: HTMLElement | undefined;
  disabled?: boolean;
  unavailable?: boolean;
  title?: string;
  describedby?: string | undefined;
}>();
const emit = defineEmits<{
  'update:open': [value: boolean];
  select: [value: number];
}>();
const root = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const panel = ref<HTMLElement>();
const panelId = useId();

function close(restoreFocus = false): void {
  emit('update:open', false);
  if (restoreFocus) trigger.value?.focus({ preventScroll: true });
}
function toggle(): void {
  if (!props.unavailable) emit('update:open', !props.open);
}
function select(value: number): void {
  if (
    props.unavailable ||
    props.options.find((option) => option.value === value)?.disabled
  )
    return;
  close(true);
  emit('select', value);
}
function keyboard(event: KeyboardEvent): void {
  const items = Array.from(
    panel.value?.querySelectorAll<HTMLButtonElement>(
      '[role="menuitemradio"]',
    ) ?? [],
  );
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
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
      close(true);
      return;
    default:
      return;
  }
  event.preventDefault();
  items[next]?.focus({ preventScroll: true });
  items[next]?.scrollIntoView?.({ block: 'nearest' });
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
  close();
}
watch(
  () => props.open,
  async (open) => {
    if (!open) {
      if (panel.value?.contains(document.activeElement))
        trigger.value?.focus({ preventScroll: true });
      return;
    }
    await nextTick();
    if (!panel.value || !trigger.value || !props.stage) return;
    positionPlayerPopover(
      panel.value,
      trigger.value,
      props.stage,
      props.menuWidth ?? 176,
    );
    const selected =
      panel.value.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
      panel.value.querySelector<HTMLButtonElement>('button');
    selected?.focus({ preventScroll: true });
    selected?.scrollIntoView?.({ block: 'nearest' });
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
  <div ref="root" class="player-choice">
    <button
      ref="trigger"
      type="button"
      class="player-choice-trigger quiet"
      :class="triggerClass"
      :aria-label="label"
      :title="title"
      :disabled="disabled"
      :aria-disabled="unavailable"
      :aria-describedby="describedby"
      aria-haspopup="menu"
      :aria-controls="panelId"
      :aria-expanded="open"
      @click="toggle"
      @keydown.down.prevent="!open && toggle()"
      @keydown.up.prevent="!open && toggle()"
    >
      <span>{{ text }}</span
      ><Icon name="chevron" :size="12" />
    </button>
    <div
      v-if="open"
      :id="panelId"
      ref="panel"
      v-keyboard-boundary="() => close(true)"
      class="player-menu player-choice-menu"
      :class="
        menuClass ??
        (triggerClass === 'playback-rate' ? 'rate-menu' : 'quality-menu')
      "
      role="menu"
      :aria-label="label"
      @keydown="keyboard"
    >
      <div class="menu-title" aria-hidden="true">{{ label }}</div>
      <p v-if="note" class="menu-note">{{ note }}</p>
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        role="menuitemradio"
        class="quiet"
        tabindex="-1"
        :aria-checked="value === option.value"
        :aria-disabled="unavailable || option.disabled"
        @click="select(option.value)"
      >
        <span class="player-option-label">{{ option.label }}</span>
        <Icon v-if="value === option.value" name="check" :size="16" />
      </button>
    </div>
  </div>
</template>
