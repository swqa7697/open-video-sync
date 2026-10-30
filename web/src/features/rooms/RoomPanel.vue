<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { Invitation, Snapshot } from '../../transport/api';
import type { RoomSettings } from '../../transport/contracts';
import { memberState, settingsSummary } from '../status-text';
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
const closeButton = ref<HTMLButtonElement>(),
  cancelButton = ref<HTMLButtonElement>(),
  participants = ref<HTMLElement>();
let removing: { memberId: string; index: number } | undefined;
watch(
  () => JSON.stringify(props.room.settings),
  () => {
    settings.value = { ...props.room.settings };
    closeConfirmation.value = false;
  },
);
// After a removal, keep keyboard focus on the next Remove button or the roster heading.
watch(
  () => props.room.members.map((member) => member.memberId).join(),
  async () => {
    const pending = removing;
    if (!pending || props.room.members.some((m) => m.memberId === pending.memberId)) return;
    removing = undefined;
    await nextTick();
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.roster button')];
    (buttons[pending.index] ?? buttons.at(-1) ?? participants.value)?.focus();
  },
);
// A failed removal leaves the member listed; forget the pending focus target.
watch(
  () => props.busy,
  (busy) => {
    if (!busy && props.room.members.some((m) => m.memberId === removing?.memberId))
      removing = undefined;
  },
);
function remove(memberId: string): void {
  if (props.busy) return;
  const removable = props.room.members.filter((m) => m.role !== 'host');
  removing = { memberId, index: removable.findIndex((m) => m.memberId === memberId) };
  emit('remove', memberId);
}
// Opening waits for idle; Cancel always works and returns focus to the trigger.
async function confirmClose(open: boolean): Promise<void> {
  if (open && props.busy) return;
  closeConfirmation.value = open;
  await nextTick();
  (open ? cancelButton : closeButton).value?.focus();
}
function selectLink(event: FocusEvent): void {
  if (event.target instanceof HTMLInputElement) event.target.select();
}
const shareURL = (secret: string) => `${location.origin}/join#invite=${secret}`;
</script>
<template>
  <section class="room" aria-labelledby="room-title">
    <div class="actions">
      <button class="quiet" :aria-disabled="busy || undefined" @click="!busy && emit('back')">
        All rooms</button
      ><button class="quiet" :aria-disabled="busy || undefined" @click="!busy && emit('refresh')">
        Refresh room
      </button>
    </div>
    <p class="eyebrow">{{ host ? 'Your room' : 'Private room' }}</p>
    <h2 id="room-title" tabindex="-1">{{ room.title }}</h2>
    <p class="hint">
      {{ settingsSummary(room.settings) }}. Room updates arrive automatically. Each participant
      selects the same local file or loads the room’s Bilibili video.
    </p>
    <slot />
    <h3 id="participants-title" ref="participants" tabindex="-1">Participants</h3>
    <ul class="roster" aria-labelledby="participants-title">
      <li v-for="member in room.members" :key="member.memberId">
        <span
          >{{ member.displayName }}{{ member.memberId === room.selfMemberId ? ' (you)' : '' }}
          <small
            >{{ member.role === 'host' ? 'Host' : 'Participant' }} ·
            {{ memberState(member, room.mediaGeneration) }}</small
          ></span
        ><button
          v-if="host && member.role !== 'host'"
          class="quiet"
          :aria-disabled="busy || undefined"
          :aria-label="`Remove ${member.displayName}`"
          @click="remove(member.memberId)"
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
      <div class="actions">
        <button :aria-disabled="busy || undefined" @click="!busy && emit('share')">
          Share invitation</button
        ><button :aria-disabled="busy || undefined" @click="!busy && emit('rotate')">
          Replace invitation
        </button>
      </div>
      <p class="hint">Replacement invalidates previous links and codes.</p>
      <form @submit.prevent="!busy && emit('settings', settings)">
        <SettingsForm v-model="settings" :disabled="busy" /><button
          :aria-disabled="busy || undefined"
        >
          Save preferences
        </button>
      </form>
      <button
        v-if="!closeConfirmation"
        ref="closeButton"
        class="danger"
        :aria-disabled="busy || undefined"
        @click="confirmClose(true)"
      >
        Close room
      </button>
      <div v-else class="notice" role="group" aria-label="Confirm room closure">
        <p>Close this room for all participants? This action cannot be undone.</p>
        <div class="actions">
          <button class="danger" :aria-disabled="busy || undefined" @click="!busy && emit('close')">
            Confirm close room</button
          ><button ref="cancelButton" class="quiet" @click="confirmClose(false)">Cancel</button>
        </div>
      </div>
    </template>
    <button v-else class="quiet" :aria-disabled="busy || undefined" @click="!busy && emit('leave')">
      Leave room
    </button>
  </section>
</template>
