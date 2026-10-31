<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { t } from '../i18n';
import Icon from './Icon.vue';
const props = withDefaults(defineProps<{ duration?: number }>(), {
  duration: 0,
});
const emit = defineEmits<{ dismiss: [] }>();
let timer: ReturnType<typeof setTimeout> | undefined;
let hovered = false,
  focused = false;
function pause(): void {
  clearTimeout(timer);
}
function resume(): void {
  pause();
  if (props.duration && !hovered && !focused)
    timer = setTimeout(() => emit('dismiss'), props.duration);
}
function hover(value: boolean): void {
  hovered = value;
  resume();
}
function focus(event: FocusEvent): void {
  focused =
    event.type === 'focusin' ||
    (event.relatedTarget instanceof Node &&
      (event.currentTarget as HTMLElement).contains(event.relatedTarget));
  resume();
}
onMounted(resume);
onUnmounted(pause);
</script>

<template>
  <Teleport to="#toast-region" defer>
    <div
      class="toast"
      @pointerenter="hover(true)"
      @pointerleave="hover(false)"
      @focusin="focus"
      @focusout="focus"
    >
      <div class="toast-content"><slot /></div>
      <button
        class="quiet icon-button toast-dismiss"
        :aria-label="t('common.dismissNotification')"
        @click="emit('dismiss')"
      >
        <Icon name="close" :size="16" />
      </button>
    </div>
  </Teleport>
</template>
