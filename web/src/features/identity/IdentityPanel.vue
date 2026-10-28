<script setup lang="ts">
import { ref, watch } from 'vue';
import { useIdentityStore } from '../../stores/identity';
const props = defineProps<{ busy: boolean }>();
const emit = defineEmits<{ rename: [name: string]; forget: [] }>();
const identity = useIdentityStore();
const name = ref('');
const confirming = ref(false);
watch(
  () => identity.session?.identity.displayName,
  (value) => {
    name.value = value ?? '';
  },
  { immediate: true },
);
</script>
<template>
  <section aria-labelledby="identity-title">
    <h2 id="identity-title">Your identity</h2>
    <p>{{ identity.session?.identity.displayName || 'Guest' }} · Saved in this browser</p>
    <form @submit.prevent="emit('rename', name)">
      <label for="display-name">Display name (optional)</label>
      <div class="form-row">
        <input
          id="display-name"
          v-model="name"
          :disabled="props.busy"
          autocomplete="nickname"
        /><button :disabled="props.busy">Save name</button>
      </div>
      <p class="hint">Up to 48 characters. Names do not grant room permissions.</p>
    </form>
    <button v-if="!confirming" class="quiet" :disabled="props.busy" @click="confirming = true">
      Forget this identity
    </button>
    <div v-else class="notice" role="group" aria-label="Confirm identity removal">
      <p>
        Forgetting this identity ends your session. Your owned rooms may become inaccessible.
        Ownership does not transfer.
      </p>
      <button
        class="danger"
        :disabled="props.busy"
        @click="
          emit('forget');
          confirming = false;
        "
      >
        Confirm forget
      </button>
      <button class="quiet" :disabled="props.busy" @click="confirming = false">Cancel</button>
    </div>
  </section>
</template>
