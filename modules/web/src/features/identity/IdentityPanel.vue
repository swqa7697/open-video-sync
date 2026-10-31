<script setup lang="ts">
import { t } from '../../i18n';

import { nextTick, ref, watch } from 'vue';
import { useIdentityStore } from '../../stores/identity';
const props = defineProps<{ busy: boolean; invalid: boolean }>();
const emit = defineEmits<{ rename: [name: string]; forget: []; edit: [] }>();
const identity = useIdentityStore();
const name = ref('');
const confirming = ref(false);
const forgetButton = ref<HTMLButtonElement>(),
  cancelButton = ref<HTMLButtonElement>();
watch(
  () => identity.session?.identity.displayName,
  (value) => {
    name.value = value ?? '';
  },
  { immediate: true }
);
// Opening waits for idle; Cancel always works and returns focus to the trigger.
async function confirm(open: boolean): Promise<void> {
  if (open && props.busy) return;
  confirming.value = open;
  await nextTick();
  (open ? cancelButton : forgetButton).value?.focus();
}
// The confirmation stays open until the identity changes, so a failure keeps focus here.
function forget(): void {
  if (!props.busy) emit('forget');
}
watch(
  () => identity.session?.identity.identityId,
  () => {
    confirming.value = false;
  }
);
</script>
<template>
  <section aria-labelledby="identity-title">
    <h2 id="identity-title" tabindex="-1">{{ t('identity.title') }}</h2>
    <p>
      {{ identity.session?.identity.displayName || t('common.guest') }} ·
      {{ t('identity.browser') }}
    </p>
    <form @submit.prevent="!props.busy && emit('rename', name)">
      <label for="display-name">{{ t('identity.name') }}</label>
      <div class="form-row">
        <input
          id="display-name"
          v-model="name"
          :readonly="props.busy"
          maxlength="96"
          autocomplete="nickname"
          :aria-invalid="props.invalid || undefined"
          :aria-describedby="props.invalid ? 'app-alert' : 'display-name-hint'"
          @input="emit('edit')"
        /><button :aria-disabled="props.busy || undefined">
          {{ t('identity.save') }}
        </button>
      </div>
      <p id="display-name-hint" class="hint">{{ t('identity.hint') }}</p>
    </form>
    <button
      v-if="!confirming"
      ref="forgetButton"
      class="quiet"
      :aria-disabled="props.busy || undefined"
      @click="confirm(true)"
    >
      {{ t('identity.forget') }}
    </button>
    <div
      v-else
      class="notice"
      role="group"
      :aria-label="t('identity.confirmLabel')"
    >
      <p>{{ t('identity.warning') }}</p>
      <div class="actions">
        <button
          class="danger"
          :aria-disabled="props.busy || undefined"
          @click="forget"
        >
          {{ t('identity.confirm') }}</button
        ><button ref="cancelButton" class="quiet" @click="confirm(false)">
          {{ t('common.cancel') }}
        </button>
      </div>
    </div>
  </section>
</template>
