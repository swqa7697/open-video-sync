<script setup lang="ts">
import { nextTick, onMounted, onBeforeUnmount, ref, useId } from 'vue';
import Icon from './Icon.vue';
defineProps<{ title: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const titleId = useId();
let trigger: HTMLElement | null = null;
onMounted(async () => {
  trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  dialog.value?.showModal();
});
onBeforeUnmount(() => {
  dialog.value?.close();
  if (trigger?.isConnected) trigger.focus();
});
</script>
<template>
  <dialog
    ref="dialog"
    class="modal"
    :aria-labelledby="titleId"
    @cancel.prevent="emit('close')"
    @click="(event) => event.target === dialog && emit('close')"
  >
    <div class="modal-heading">
      <h2 :id="titleId">{{ title }}</h2>
      <button
        type="button"
        class="icon-button quiet"
        aria-label="Close dialog"
        @click="emit('close')"
      >
        <Icon name="close" />
      </button>
    </div>
    <div class="modal-content"><slot /></div>
  </dialog>
</template>
