<script setup lang="ts">
import { t } from '../i18n';

import { nextTick, onMounted, onBeforeUnmount, ref, useId } from 'vue';
import Icon from './Icon.vue';
defineProps<{ title: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const titleId = useId();
let trigger: HTMLElement | null = null;
let animation: Animation | undefined;
let disposed = false;
let closing = false;

function animate(opening: boolean): Animation | undefined {
  const element = dialog.value;
  if (!element || document.documentElement.dataset.input === 'keyboard') {
    animation?.cancel();
    return;
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const style = getComputedStyle(element);
  // The production CSS optimizer can convert milliseconds to seconds.
  const duration = style.getPropertyValue('--motion-dialog').trim();
  const durationMs =
    parseFloat(duration) * (duration.endsWith('ms') ? 1 : 1000);
  const current = { opacity: style.opacity, transform: style.transform };
  animation?.cancel();
  animation = element.animate(
    opening
      ? [
          { opacity: 0, transform: reduced ? 'none' : 'scale(0.96)' },
          { opacity: 1, transform: 'none' },
        ]
      : [current, { opacity: 0, transform: reduced ? 'none' : 'scale(0.96)' }],
    {
      duration: reduced ? 80 : durationMs,
      easing: style.getPropertyValue('--ease-out').trim(),
      fill: 'both',
    }
  );
  return animation;
}

async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await animate(false)?.finished;
  } catch {
    // Unmount cancels animation and owns dialog/focus cleanup.
  }
  if (!disposed) emit('close');
}
onMounted(async () => {
  trigger =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  await nextTick();
  if (disposed) return;
  dialog.value?.showModal();
  animate(true);
});
onBeforeUnmount(() => {
  disposed = true;
  animation?.cancel();
  dialog.value?.close();
  if (trigger?.isConnected) trigger.focus();
});
</script>
<template>
  <dialog
    ref="dialog"
    class="modal"
    :aria-labelledby="titleId"
    @cancel.prevent="close"
    @click="(event) => event.target === dialog && close()"
  >
    <div class="modal-heading">
      <h2 :id="titleId">{{ title }}</h2>
      <button
        type="button"
        class="icon-button quiet"
        :aria-label="t('common.closeDialog')"
        @click="close"
      >
        <Icon name="close" />
      </button>
    </div>
    <div class="modal-content"><slot /></div>
  </dialog>
</template>
