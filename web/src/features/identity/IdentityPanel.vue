<script setup lang="ts">
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
  { immediate: true },
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
  },
);
</script>
<template>
  <section aria-labelledby="identity-title">
    <h2 id="identity-title" tabindex="-1">Your identity</h2>
    <p>{{ identity.session?.identity.displayName || 'Guest' }} · Saved in this browser</p>
    <form @submit.prevent="!props.busy && emit('rename', name)">
      <label for="display-name">Display name (optional)</label>
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
        /><button :aria-disabled="props.busy || undefined">Save name</button>
      </div>
      <p id="display-name-hint" class="hint">
        Up to 48 characters. Names do not grant room permissions.
      </p>
    </form>
    <button
      v-if="!confirming"
      ref="forgetButton"
      class="quiet"
      :aria-disabled="props.busy || undefined"
      @click="confirm(true)"
    >
      Forget this identity
    </button>
    <div v-else class="notice" role="group" aria-label="Confirm identity removal">
      <p>
        Forgetting this identity ends your session. Your owned rooms may become inaccessible.
        Ownership does not transfer.
      </p>
      <div class="actions">
        <button class="danger" :aria-disabled="props.busy || undefined" @click="forget">
          Confirm forget</button
        ><button ref="cancelButton" class="quiet" @click="confirm(false)">Cancel</button>
      </div>
    </div>
  </section>
</template>
