<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

import FormFeedback from '../../components/FormFeedback.vue';
import Icon from '../../components/Icon.vue';
import Modal from '../../components/Modal.vue';
import { message, t, translate, type Message } from '../../i18n';
import type { Episode, Playlist } from '../../player/bilibili/media';
import type { Invitation, Snapshot } from '../../transport/api';
import type { RoomSettings } from '../../transport/contracts';
import type { QuickCommand } from '../commands/search';
import RoomSidebar from './RoomSidebar.vue';
import SettingsForm from './SettingsForm.vue';

const props = defineProps<{
  room: Snapshot;
  invitation?: Invitation | undefined;
  host: boolean;
  busy: boolean;
  error?: string | undefined;
  playlist?: Playlist | undefined;
  canSelectEpisode?: boolean;
}>();
const emit = defineEmits<{
  refresh: [];
  settings: [settings: RoomSettings];
  rotate: [];
  share: [];
  remove: [memberId: string];
  close: [];
  leave: [];
  selectEpisode: [episode: Episode];
}>();
const sidebar = ref<InstanceType<typeof RoomSidebar>>();
const settings = ref<RoomSettings>({ ...props.room.settings });
const inviteOpen = ref(false),
  settingsOpen = ref(false),
  closeConfirmation = ref(false),
  membersOpen = ref(true),
  narrow = ref(false),
  copied = ref<Message | ''>('');
const shareURL = computed(() =>
  props.invitation
    ? `${location.origin}/join#invite=${props.invitation.linkSecret}`
    : '',
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
    copied.value = message('room.copied');
  } catch {
    const input = document.getElementById(field) as HTMLInputElement | null;
    input?.focus();
    input?.select();
    copied.value = message('room.selected');
  }
}
function invite(): void {
  if (!props.host || props.busy) return;
  inviteOpen.value = true;
  emit('share');
}
const commands = computed<QuickCommand[]>(() => [
  ...(props.host
    ? [
        {
          id: 'invite',
          label: t('room.invite'),
          group: 'room' as const,
          icon: 'link',
          shortcut: '/invite',
          aliases: 'share invitation code 邀请 分享 邀请码',
          disabled: props.busy,
          run: invite,
        },
        {
          id: 'room-settings',
          label: t('commands.roomSettings'),
          group: 'room' as const,
          icon: 'sliders',
          shortcut: '/room',
          aliases: 'room settings preferences 房间 设置 等待 控制权限',
          disabled: props.busy,
          run: () => {
            if (props.host && !props.busy) openSettings();
          },
        },
      ]
    : []),
  {
    id: 'members',
    label: t('room.membersTitle'),
    group: 'room',
    icon: 'users',
    shortcut: '/members',
    aliases: 'participants people 成员 参与者',
    run: () => {
      membersOpen.value = true;
      void nextTick(() => sidebar.value?.showMembers());
    },
  },
]);
defineExpose({ commands });
</script>
<template>
  <section
    class="room"
    :class="{ 'with-members': membersOpen && !narrow }"
    aria-labelledby="room-title"
  >
    <div class="room-toolbar">
      <div class="room-heading">
        <span class="eyebrow">{{ t('room.private') }}</span>
        <h2 id="room-title" tabindex="-1" :title="room.title">
          {{ room.title }}
        </h2>
      </div>
      <div class="room-actions">
        <button
          v-if="host"
          class="invite-button"
          :disabled="busy"
          @click="invite"
        >
          <Icon name="link" /><span>{{ t('room.invite') }}</span>
        </button>
        <button
          class="quiet"
          :aria-expanded="membersOpen"
          :aria-label="
            playlist
              ? t('room.sidebar')
              : t('room.membersCount', { count: room.members.length })
          "
          @click="membersOpen = !membersOpen"
        >
          <Icon name="users" /><span class="toolbar-label">{{
            playlist ? t('room.sidebar') : t('room.members')
          }}</span
          ><span>{{ room.members.length }}</span>
        </button>
        <button
          v-if="host"
          class="quiet icon-button"
          :aria-label="t('common.settings')"
          :disabled="busy"
          @click="openSettings"
        >
          <Icon name="sliders" />
        </button>
        <button
          class="quiet leave-button"
          :disabled="busy"
          @click="emit('leave')"
        >
          <Icon name="leave" /><span class="toolbar-label">{{
            t('room.leave')
          }}</span>
        </button>
      </div>
    </div>
    <div class="room-layout">
      <div class="viewing-column"><slot /></div>
      <aside v-if="membersOpen && !narrow" class="member-panel">
        <RoomSidebar
          ref="sidebar"
          :room="room"
          :host="host"
          :busy="busy"
          :playlist="playlist"
          :can-select-episode="canSelectEpisode ?? false"
          @remove="(id) => emit('remove', id)"
          @select-episode="(episode) => emit('selectEpisode', episode)"
        />
      </aside>
    </div>
    <Modal
      v-if="membersOpen && narrow"
      :title="playlist ? t('room.sidebar') : t('room.membersTitle')"
      @close="membersOpen = false"
      ><RoomSidebar
        ref="sidebar"
        :room="room"
        :host="host"
        :busy="busy"
        :playlist="playlist"
        :can-select-episode="canSelectEpisode ?? false"
        @remove="(id) => emit('remove', id)"
        @select-episode="(episode) => emit('selectEpisode', episode)"
    /></Modal>
    <Modal
      v-if="inviteOpen"
      :title="t('room.inviteTitle')"
      @close="inviteOpen = false"
      ><FormFeedback
        :text="t('room.inviteHint', { title: room.title })"
        :announce="false"
      />
      <div class="invitation-fields">
        <label for="invite-link">{{ t('room.invitationLink') }}</label>
        <div class="input-action">
          <input
            id="invite-link"
            :value="shareURL"
            autocomplete="off"
            readonly
            :disabled="!invitation"
            @focus="selectLink"
          /><button
            class="quiet icon-button"
            :aria-label="t('room.copyLink')"
            :disabled="!invitation"
            @click="copy(shareURL, 'invite-link')"
          >
            <Icon name="copy" />
          </button>
        </div>
        <label for="invite-code">{{ t('room.invitationCode') }}</label>
        <div class="input-action">
          <input
            id="invite-code"
            class="invite-code"
            :value="invitation?.code.match(/.{4}/g)?.join(' ') ?? ''"
            autocomplete="off"
            readonly
            :disabled="!invitation"
            @focus="selectLink"
          /><button
            class="quiet icon-button"
            :aria-label="t('room.copyCode')"
            :disabled="!invitation"
            @click="invitation && copy(invitation.code, 'invite-code')"
          >
            <Icon name="copy" />
          </button>
        </div>
      </div>
      <FormFeedback
        reserve
        :text="
          error || (!invitation ? t('room.retrieving') : translate(copied))
        "
        :tone="error ? 'error' : 'hint'"
      />
      <p class="hint">{{ t('room.invitationHint') }}</p>
      <button class="quiet" :disabled="busy" @click="emit('rotate')">
        {{ t('room.replaceInvitation') }}
      </button></Modal
    >
    <Modal
      v-if="settingsOpen"
      :title="t('common.settings')"
      @close="settingsOpen = false"
      ><form
        @submit.prevent="
          saving = true;
          emit('settings', settings);
        "
      >
        <SettingsForm v-model="settings" :disabled="busy" />
        <FormFeedback reserve :text="error || ''" tone="error" />
        <button :disabled="busy">{{ t('room.savePreferences') }}</button>
      </form>
      <div class="settings-danger">
        <p class="hint">{{ t('room.closeHint') }}</p>
        <button
          type="button"
          class="danger quiet"
          :disabled="busy"
          @click="
            settingsOpen = false;
            closeConfirmation = true;
          "
        >
          {{ t('room.close') }}
        </button>
      </div></Modal
    >
    <Modal
      v-if="closeConfirmation"
      :title="t('room.closeTitle')"
      @close="closeConfirmation = false"
      ><p>{{ t('room.closeWarning') }}</p>
      <FormFeedback reserve :text="error || ''" tone="error" />
      <div class="actions">
        <button class="quiet" autofocus @click="closeConfirmation = false">
          {{ t('common.cancel') }}</button
        ><button class="danger" :disabled="busy" @click="emit('close')">
          {{ t('room.confirmClose') }}
        </button>
      </div></Modal
    >
  </section>
</template>
