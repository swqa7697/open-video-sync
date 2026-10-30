<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Invitation, Snapshot } from '../../transport/api';
import type { RoomSettings } from '../../transport/contracts';
import { settingsSummary } from '../status-text';
import SettingsForm from './SettingsForm.vue';
import MembersPanel from './MembersPanel.vue';
import Modal from '../../components/Modal.vue';
import Icon from '../../components/Icon.vue';
const props = defineProps<{
  room: Snapshot;
  invitation?: Invitation | undefined;
  host: boolean;
  busy: boolean;
  error?: string | undefined;
}>();
const emit = defineEmits<{
  refresh: [];
  settings: [settings: RoomSettings];
  rotate: [];
  share: [];
  remove: [memberId: string];
  close: [];
  leave: [];
}>();
const settings = ref<RoomSettings>({ ...props.room.settings });
const inviteOpen = ref(false),
  settingsOpen = ref(false),
  closeConfirmation = ref(false),
  membersOpen = ref(true),
  narrow = ref(false),
  copied = ref('');
const shareURL = computed(() =>
  props.invitation ? `${location.origin}/join#invite=${props.invitation.linkSecret}` : '',
);
let breakpoint: MediaQueryList | undefined;
function resize(): void {
  narrow.value = breakpoint?.matches ?? false;
  membersOpen.value = !narrow.value;
}
onMounted(() => {
  breakpoint = matchMedia('(max-width: 760px)');
  resize();
  breakpoint.addEventListener('change', resize);
});
onUnmounted(() => breakpoint?.removeEventListener('change', resize));
watch(
  () => props.room.settings,
  () => {
    if (!settingsOpen.value) settings.value = { ...props.room.settings };
  },
);
function openSettings(): void {
  settings.value = { ...props.room.settings };
  settingsOpen.value = true;
}
let saving = false;
watch(
  () => props.busy,
  (value) => {
    if (!value && saving) {
      saving = false;
      if (!props.error) settingsOpen.value = false;
    }
  },
);
function selectLink(event: FocusEvent): void {
  if (event.target instanceof HTMLInputElement) event.target.select();
}
async function copy(value: string, field: string): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error('unavailable');
    await navigator.clipboard.writeText(value);
    copied.value = 'Copied.';
  } catch {
    const input = document.getElementById(field) as HTMLInputElement | null;
    input?.focus();
    input?.select();
    copied.value = 'Text selected. Use your browser’s Copy action.';
  }
}
</script>
<template>
  <section class="room" aria-labelledby="room-title">
    <div class="room-toolbar">
      <div class="room-heading">
        <span class="eyebrow">PRIVATE ROOM</span>
        <h2 id="room-title" tabindex="-1" :title="room.title">{{ room.title }}</h2>
      </div>
      <div class="room-actions">
        <button
          v-if="host"
          class="invite-button"
          :disabled="busy"
          @click="
            inviteOpen = true;
            emit('share');
          "
        >
          <Icon name="link" /><span>Invite</span>
        </button>
        <button
          class="quiet"
          :aria-expanded="membersOpen"
          :aria-label="`Members (${room.members.length})`"
          @click="membersOpen = !membersOpen"
        >
          <Icon name="users" /><span class="toolbar-label">Members</span
          ><span>{{ room.members.length }}</span>
        </button>
        <button
          v-if="host"
          class="quiet icon-button"
          aria-label="Room settings"
          :disabled="busy"
          @click="openSettings"
        >
          <Icon name="settings" />
        </button>
        <button class="quiet leave-button" :disabled="busy" @click="emit('leave')">
          <Icon name="leave" /><span class="toolbar-label">Leave</span>
        </button>
      </div>
    </div>
    <div class="room-layout" :class="{ 'with-members': membersOpen && !narrow }">
      <div class="viewing-column"><slot /></div>
      <aside v-if="membersOpen && !narrow" class="member-panel">
        <MembersPanel :room="room" :host="host" :busy="busy" @remove="(id) => emit('remove', id)" />
        <div class="panel-policy">
          <Icon name="shield" :size="16" /><span>{{ settingsSummary(room.settings) }}</span>
        </div>
      </aside>
    </div>
    <Modal v-if="membersOpen && narrow" title="Room members" @close="membersOpen = false"
      ><MembersPanel :room="room" :host="host" :busy="busy" @remove="(id) => emit('remove', id)"
    /></Modal>
    <Modal v-if="inviteOpen" title="A little better together" @close="inviteOpen = false"
      ><p>
        Invite your people to <strong>{{ room.title }}</strong
        >.
      </p>
      <template v-if="invitation"
        ><label for="invite-link">Invitation link</label>
        <div class="input-action">
          <input id="invite-link" :value="shareURL" readonly @focus="selectLink" /><button
            class="quiet icon-button"
            aria-label="Copy invitation link"
            @click="copy(shareURL, 'invite-link')"
          >
            <Icon name="copy" />
          </button>
        </div>
        <label for="invite-code">Invitation code</label>
        <div class="input-action">
          <input
            id="invite-code"
            class="invite-code"
            :value="invitation.code.match(/.{4}/g)?.join(' ')"
            readonly
            @focus="selectLink"
          /><button
            class="quiet icon-button"
            aria-label="Copy invitation code"
            @click="copy(invitation.code, 'invite-code')"
          >
            <Icon name="copy" />
          </button>
        </div>
        <p role="status" class="hint">{{ copied }}</p></template
      >
      <p v-else class="hint">Retrieving your invitation…</p>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <p class="hint">
        Only invited people can enter. This invitation works until replaced or the room closes.
      </p>
      <button class="quiet" :disabled="busy" @click="emit('rotate')">
        Replace invitation
      </button></Modal
    >
    <Modal v-if="settingsOpen" title="Room settings" @close="settingsOpen = false"
      ><form
        @submit.prevent="
          saving = true;
          emit('settings', settings);
        "
      >
        <SettingsForm v-model="settings" :disabled="busy" />
        <p v-if="error" class="notice error" role="alert">{{ error }}</p>
        <button :disabled="busy">Save preferences</button>
      </form>
      <div class="settings-danger">
        <p class="hint">Close this room and end the session for everyone.</p>
        <button
          type="button"
          class="danger quiet"
          :disabled="busy"
          @click="
            settingsOpen = false;
            closeConfirmation = true;
          "
        >
          Close room for everyone
        </button>
      </div></Modal
    >
    <Modal
      v-if="closeConfirmation"
      title="Close room for everyone?"
      @close="closeConfirmation = false"
      ><p>Everyone will leave and this invitation will stop working. This cannot be undone.</p>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
      <div class="actions">
        <button class="quiet" autofocus @click="closeConfirmation = false">Cancel</button
        ><button class="danger" :disabled="busy" @click="emit('close')">Confirm close room</button>
      </div></Modal
    >
  </section>
</template>
