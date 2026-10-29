<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Invitation, Snapshot } from '../../transport/api';
import type { RoomSettings } from '../../transport/contracts';
import SettingsForm from './SettingsForm.vue';
const props = defineProps<{
  room: Snapshot;
  invitation?: Invitation | undefined;
  host: boolean;
  busy: boolean;
}>();
const emit = defineEmits<{
  refresh: [];
  settings: [settings: RoomSettings];
  rotate: [];
  share: [];

  remove: [memberId: string];
  close: [];
  leave: [];
  back: [];
}>();
const settings = ref<RoomSettings>({ ...props.room.settings });
const closeConfirmation = ref(false);
watch(
  () => JSON.stringify(props.room.settings),
  () => {
    settings.value = { ...props.room.settings };
    closeConfirmation.value = false;
  },
);
function selectLink(event: FocusEvent): void {
  if (event.target instanceof HTMLInputElement) event.target.select();
}
const shareURL = (secret: string) => `${location.origin}/join#invite=${secret}`;
</script>
<template>
  <section aria-labelledby="room-title">
    <div class="form-row">
      <button class="quiet" :disabled="busy" @click="emit('back')">All rooms</button
      ><button class="quiet" :disabled="busy" @click="emit('refresh')">Refresh room</button>
    </div>
    <p class="eyebrow">{{ host ? 'Your room' : 'Private room' }}</p>
    <h2 id="room-title">{{ room.title }}</h2>
    <p class="notice">
      Room updates arrive automatically. Each participant must select the same local video.
    </p>
    <h3>Participants</h3>
    <ul class="roster">
      <li v-for="member in room.members" :key="member.memberId">
        <span
          >{{ member.displayName }}
          <small
            >({{ member.role }} · {{ member.presence }} ·
            {{ member.readiness?.status ?? 'no media' }})</small
          ></span
        ><button
          v-if="host && member.role !== 'host'"
          class="quiet"
          :disabled="busy"
          :aria-label="`Remove ${member.displayName}`"
          @click="emit('remove', member.memberId)"
        >
          Remove
        </button>
      </li>
    </ul>
    <template v-if="host">
      <h3>Share this room</h3>
      <template v-if="invitation">
        <label for="invite-link">Invitation link</label
        ><input
          id="invite-link"
          :value="shareURL(invitation.linkSecret)"
          readonly
          @focus="selectLink"
        />
        <p>
          Code: <strong class="invite-code">{{ invitation.code.match(/.{4}/g)?.join(' ') }}</strong>
        </p>
        <p class="hint">
          Share only with intended participants. This invitation stays valid until you replace it.
        </p>
      </template>
      <p v-else class="hint">Retrieve the current invitation to share this room again.</p>
      <button :disabled="busy" @click="emit('share')">Share invitation</button>
      <button :disabled="busy" @click="emit('rotate')">Replace invitation</button>
      <p class="hint">Replacement invalidates previous links and codes.</p>
      <form @submit.prevent="emit('settings', settings)">
        <SettingsForm v-model="settings" :disabled="busy" /><button :disabled="busy">
          Save preferences
        </button>
      </form>
      <button
        v-if="!closeConfirmation"
        class="danger"
        :disabled="busy"
        @click="closeConfirmation = true"
      >
        Close room
      </button>
      <div v-else class="notice">
        <p>Close this room for all participants? This action cannot be undone.</p>
        <button class="danger" :disabled="busy" @click="emit('close')">Confirm close room</button
        ><button class="quiet" :disabled="busy" @click="closeConfirmation = false">Cancel</button>
      </div>
    </template>
    <button v-else class="quiet" :disabled="busy" @click="emit('leave')">Leave room</button>
  </section>
</template>
