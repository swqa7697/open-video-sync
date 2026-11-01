<script setup lang="ts">
import { t, message as msg, translate, type Message } from './i18n';
import { useLanguageStore } from './stores/language';
import AppSettings from './features/AppSettings.vue';
import HomeIntro from './features/HomeIntro.vue';
import CommandPalette from './features/commands/CommandPalette.vue';
import {
  hasKeyboardOverlay,
  useOverlayKeyboard,
} from './components/overlay-keyboard';
import { usePreferenceCommands } from './features/commands/preferences';
import type { QuickCommand, VideoSelection } from './features/commands/search';

import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  watchEffect,
} from 'vue';
import { useConnectionStore } from './stores/connection';
import { useIdentityStore } from './stores/identity';
import {
  APIError,
  decodeInvitation,
  decodeRoomResult,
  decodeSnapshot,
  defaultSettings,
  object,
  request,
  requestKey,
  type Invitation,
  type Snapshot,
} from './transport/api';
import { decodeRoomSettings, type RoomSettings } from './transport/contracts';
import type { EndReason } from './transport/room-socket';
import {
  InputError,
  describeFailure,
  type Failure,
  type FailureContext,
} from './features/failures';
import IdentityPanel from './features/identity/IdentityPanel.vue';
import RoomPanel from './features/rooms/RoomPanel.vue';
import PlayerPanel from './features/player/PlayerPanel.vue';
import MediaPicker from './features/media/MediaPicker.vue';
import HelperNotice from './features/media/HelperNotice.vue';
import SettingsForm from './features/rooms/SettingsForm.vue';
import Modal from './components/Modal.vue';
import Icon from './components/Icon.vue';
import ToastNotice from './components/ToastNotice.vue';
import { useNotificationStore } from './stores/notifications';

const props = defineProps<{ initialInvitation?: string | undefined }>();
const connection = useConnectionStore(),
  identity = useIdentityStore();
const language = useLanguageStore();
const notifications = useNotificationStore();
const stopLanguage = language.listen();
const controller = new AbortController();
const departing = ref(false),
  leaveConfirmation = ref(false);
let destinationAfterLeave: string | undefined;
const busy = ref(false),
  failure = ref<Failure>(),
  invalidField = ref<string>(),
  message = ref<Message | ''>('');
const title = ref(''),
  code = ref('');
const room = ref<Snapshot>(),
  invitation = ref<Invitation>();
const creationKey = ref(requestKey());
const picker = ref<InstanceType<typeof MediaPicker>>();
const player = ref<InstanceType<typeof PlayerPanel>>();
const roomPanel = ref<InstanceType<typeof RoomPanel>>();
const appSettings = ref<InstanceType<typeof AppSettings>>();
const paletteOpen = ref(false);
const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
const preferenceCommands = usePreferenceCommands((panel) =>
  appSettings.value?.openPanel(panel)
);
const draftSettings = ref(defaultSettings()),
  settingsOpen = ref(false),
  profileOpen = ref(false);
const helperGeneration = ref(0);
let initialFile: File | undefined;
const safeName = computed(
  () => identity.session?.identity.displayName || t('common.guest')
);
const host = computed(
  () => room.value?.selfMemberId === room.value?.hostMemberId
);
// Retain uncertain create/redeem intent and its key in memory until its outcome is known.
const attempt = ref<{
  path: string;
  payload: unknown;
  key: string;
  started: number;
  sent: boolean;
}>();
const pendingLink = ref(props.initialInvitation);
const commands = computed<QuickCommand[]>(() => [
  ...(room.value
    ? [...(player.value?.commands ?? []), ...(roomPanel.value?.commands ?? [])]
    : identity.session
      ? [
          {
            id: 'video',
            label: t('commands.selectVideo'),
            group: 'watch' as const,
            icon: 'screen',
            shortcut: '/video',
            aliases: 'bilibili video link 视频 链接',
            disabled: busy.value || !!attempt.value,
            detail: t('commands.videoHint'),
            run: (selection?: VideoSelection) => {
              void picker.value?.selectBilibili(selection);
            },
          },
          {
            id: 'local',
            label: t('media.chooseFile'),
            group: 'watch' as const,
            icon: 'file',
            shortcut: '/local',
            aliases: 'local file 本地 文件',
            disabled: busy.value || !!attempt.value,
            run: () => {
              void picker.value?.selectLocal();
            },
          },
          {
            id: 'create',
            label: t('app.startParty'),
            group: 'room' as const,
            icon: 'plus',
            shortcut: '/create',
            aliases: 'create room 创建 新建 房间',
            disabled: busy.value || !!attempt.value,
            run: () => {
              void focus('room-name');
            },
          },
          {
            id: 'join',
            label: t('app.titleJoin'),
            group: 'room' as const,
            icon: 'link',
            shortcut: '/join',
            aliases: 'join invitation code 加入 邀请码',
            disabled: busy.value || !!attempt.value,
            run: () => {
              void focus('join-code');
            },
          },
        ]
      : []),
  ...(identity.session
    ? [
        {
          id: 'profile',
          label: t('app.profile'),
          group: 'app' as const,
          icon: 'users',
          shortcut: '/profile',
          aliases: 'identity name rename 身份 昵称 名字',
          run: () => {
            profileOpen.value = true;
          },
        },
      ]
    : []),
  ...preferenceCommands.value,
]);
const serverText = computed(
  () =>
    ({
      checking: t('app.serverChecking'),
      ready: t('app.serverReady'),
      not_ready: t('app.serverNotReady'),
      unreachable: t('app.serverUnreachable'),
    })[connection.status]
);
// Room titles stay out of browser history; the room heading names the room.
watchEffect(() => {
  document.title = `${
    room.value
      ? t('app.titleRoom')
      : !identity.session && !busy.value
        ? t('app.titleConnection')
        : pendingLink.value
          ? t('app.titleJoin')
          : t('common.watchTogether')
  } · Open Video Sync`;
});
const api = (
  path: string,
  method = 'GET',
  payload?: unknown,
  key?: string,
  replayOnly = false
) =>
  request(
    path,
    method,
    identity.session?.csrfToken ?? '',
    payload,
    controller.signal,
    key,
    replayOnly
  );
function recheck(): void {
  void connection.checkReadiness(controller.signal);
}
async function focus(id: string): Promise<void> {
  await nextTick();
  document.getElementById(id)?.focus();
}
function focusMain(): void {
  document.getElementById('main')?.focus();
}
function reload(): void {
  location.reload();
}

async function perform(
  work: () => Promise<void>,
  context: FailureContext = 'other'
): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  failure.value = undefined;
  invalidField.value = undefined;
  message.value = '';
  try {
    await work();
  } catch (reason) {
    if (!controller.signal.aborted) {
      const described = describeFailure(reason, context);
      failure.value = described;
      if (described.recheck) recheck();
      if (described.field) {
        invalidField.value = described.field;
        void focus(described.field);
      } else if (attempt.value) void focus('retry-attempt');
    }
  } finally {
    if (!controller.signal.aborted) busy.value = false;
  }
}
function show(snapshot: Snapshot, share?: Invitation): void {
  room.value = snapshot;
  invitation.value = share;
  history.replaceState(null, '', `/rooms/${snapshot.roomId}`);
}
async function open(id: string, moveFocus = false): Promise<void> {
  let snapshot: Snapshot;
  try {
    snapshot = decodeSnapshot(await api(`/rooms/${id}`));
  } catch (reason) {
    if (reason instanceof APIError && reason.code === 'not_found') {
      await ended('room_unavailable');
      return;
    }
    throw reason;
  }
  show(snapshot);
  if (moveFocus) void focus('room-title');
  if (host.value) {
    try {
      await share();
    } catch (reason) {
      if (
        reason instanceof APIError &&
        reason.code === 'invitation_reset_required'
      )
        message.value = reason.text;
      else throw reason;
    }
  }
}
async function submitAttempt(): Promise<void> {
  const pending = attempt.value;
  if (!pending) return;
  if (performance.now() - pending.started >= 60000) {
    attempt.value = undefined;
    if (pending.path === '/rooms') {
      try {
        await open(pending.key, true);
        if (room.value) return;
      } catch {
        /* Explicit new intent remains available. */
      }
    }
    if (pending.path === '/rooms') creationKey.value = requestKey();
    message.value = msg('app.recoveryExpired');
    return;
  }
  try {
    const replayOnly = pending.sent && pending.path === '/rooms';
    pending.sent = true;
    const value = decodeRoomResult(
      await api(pending.path, 'POST', pending.payload, pending.key, replayOnly)
    );
    attempt.value = undefined;
    pendingLink.value = undefined;
    code.value = '';
    title.value = '';
    show(value.snapshot, value.invitation ?? undefined);
    if (pending.path !== '/rooms' && host.value) await share();
    if (pending.path !== '/rooms') initialFile = undefined;
    message.value = msg('app.roomReady');
    void focus('room-title');
  } catch (reason) {
    if (
      reason instanceof APIError &&
      reason.code === 'request_outcome_unknown'
    ) {
      attempt.value = undefined;
      try {
        await open(pending.key, true);
        if (room.value) return;
      } catch {
        /* No unauthorized state is exposed. */
      }
      message.value = msg('app.recoveryFailed');
      creationKey.value = requestKey();
      return;
    }
    // Uncertain outcomes keep the original request for an explicit retry.
    if (
      reason instanceof APIError &&
      !['busy', 'storage_unavailable'].includes(reason.code)
    )
      attempt.value = undefined;
    throw reason;
  }
}
async function create(): Promise<void> {
  const selection = await picker.value?.prepare();
  if (!selection) return;
  initialFile = selection.file;
  attempt.value = {
    path: '/rooms',
    payload: {
      title: title.value.trim() || t('app.defaultRoomName'),
      settings: { ...draftSettings.value },
      media: selection.media,
    },
    key: creationKey.value,
    started: performance.now(),
    sent: false,
  };
  await submitAttempt();
}
function invitationInput(): { linkSecret: string } | { code: string } {
  const raw = code.value.trim();
  if (!raw && pendingLink.value) return { linkSecret: pendingLink.value };
  if (/^[a-zA-Z0-9 -]{16,32}$/.test(raw)) return { code: raw };
  try {
    const url = new URL(raw);
    const values = new URLSearchParams(url.hash.slice(1));
    const secret = values.get('invite');
    if (
      url.origin === location.origin &&
      url.pathname === '/join' &&
      !url.search &&
      !url.username &&
      !url.password &&
      values.size === 1 &&
      secret &&
      /^[A-Za-z0-9_-]{22}$/.test(secret)
    )
      return { linkSecret: secret };
  } catch {
    /* Present one safe validation message below. */
  }
  throw new InputError();
}
async function join(): Promise<void> {
  attempt.value = {
    path: '/invitations/redeem',
    payload: invitationInput(),
    key: requestKey(),
    started: performance.now(),
    sent: false,
  };
  await submitAttempt();
}
const managed: Record<'settings' | 'rotate' | 'remove', Message> = {
  settings: msg('app.preferencesSaved'),
  rotate: msg('app.invitationReplaced'),
  remove: msg('app.participantRemoved'),
};
async function manage(
  operation: 'settings' | 'rotate' | 'remove' | 'close' | 'leave',
  settings?: RoomSettings,
  memberId?: string
): Promise<void> {
  const current = room.value;
  if (!current) return;
  const self =
    operation === 'close' ||
    operation === 'leave' ||
    (operation === 'remove' && !memberId);
  const suffix =
    operation === 'settings'
      ? '/settings'
      : operation === 'rotate'
        ? '/invitations'
        : operation === 'remove'
          ? `/members/${memberId ?? current.selfMemberId}`
          : operation === 'leave'
            ? '/leave'
            : '';
  const method =
    operation === 'settings'
      ? 'PATCH'
      : operation === 'rotate' || operation === 'leave'
        ? 'POST'
        : 'DELETE';
  const payload = {
    epoch: current.epoch,
    expectedRevision: current.revision,
    ...(settings ? { settings: decodeRoomSettings(settings) } : {}),
  };
  let response: Record<string, unknown>;
  if (self) departing.value = true;
  try {
    response = object(
      await api(`/rooms/${current.roomId}${suffix}`, method, payload)
    );
  } catch (reason) {
    if (reason instanceof APIError && reason.code === 'not_found') {
      // The room may still exist; only a missing room ends this view.
      await open(current.roomId);
      if (room.value && operation === 'remove' && !self) {
        message.value = msg('app.alreadyLeft');
        return;
      }
      if (!room.value) return;
    }
    throw reason;
  } finally {
    departing.value = false;
  }
  if (self) {
    message.value =
      operation === 'close'
        ? msg('app.closedRoom', { title: current.title })
        : msg('app.leftRoom', { title: current.title });
    await back();
    return;
  }
  room.value = decodeSnapshot(
    operation === 'remove'
      ? await api(`/rooms/${current.roomId}`)
      : response.snapshot
  );
  if (operation === 'rotate')
    invitation.value = decodeInvitation(response.invitation);
  if (operation === 'remove') {
    invitation.value = undefined;
    if (host.value) await share();
  }
  message.value = managed[operation];
}
async function share(): Promise<void> {
  if (!room.value || !host.value) return;
  invitation.value = decodeInvitation(
    object(await api(`/rooms/${room.value.roomId}/invitations`)).invitation
  );
}
async function back(): Promise<void> {
  leaveConfirmation.value = false;
  room.value = undefined;
  invitation.value = undefined;
  history.replaceState(null, '', '/');
  initialFile = undefined;
  creationKey.value = requestKey();
  void focus('create-title');
}
// A room connection ended for good. Leave the room view and say why.
async function ended(reason: EndReason): Promise<void> {
  leaveConfirmation.value = false;
  const name = room.value?.title,
    active = document.activeElement,
    focusInside =
      !active || active === document.body || !!active.closest('.room');
  room.value = undefined;
  invitation.value = undefined;
  history.replaceState(null, '', '/');
  if (reason === 'session_ended' || reason === 'revoked') {
    failure.value = {
      text:
        reason === 'session_ended'
          ? msg('app.sessionEnded')
          : msg('app.connectionEnded'),
      reload: true,
    };
    if (reason === 'session_ended') identity.session = undefined;
    if (focusInside) void focus('app-reload');
    return;
  }
  message.value = name
    ? msg(
        reason === 'closed'
          ? 'app.hostClosed'
          : reason === 'removed'
            ? 'app.removed'
            : 'app.unavailable',
        { room: `“${name}”` }
      )
    : msg('api.not_found');
  if (focusInside || !active?.isConnected) void focus('create-title');
}
async function forget(): Promise<void> {
  departing.value = true;
  try {
    await identity.forget(controller.signal);
  } finally {
    departing.value = false;
  }
  room.value = undefined;
  invitation.value = undefined;
  attempt.value = undefined;
  pendingLink.value = undefined;
  history.replaceState(null, '', '/');
  await identity.bootstrap(controller.signal);
  message.value = msg('app.newIdentity');
  void focus('identity-title');
}
function connectionChanged(): void {
  recheck();
}
function visibility(): void {
  if (document.visibilityState === 'visible' && connection.status !== 'ready')
    recheck();
}
function navigate(): void {
  const destination = location.pathname;
  if (room.value) {
    history.replaceState(null, '', `/rooms/${room.value.roomId}`);
    destinationAfterLeave = destination;
    leaveConfirmation.value = true;
    return;
  }
  const route = /^\/rooms\/([a-f0-9]{32})$/.exec(destination);
  if (route) void perform(() => open(route[1]!, true));
}
function requestLeave(): void {
  destinationAfterLeave = undefined;
  leaveConfirmation.value = true;
}
async function confirmLeave(): Promise<void> {
  const destination = destinationAfterLeave;
  await manage('leave');
  if (room.value) return;
  const route = destination && /^\/rooms\/([a-f0-9]{32})$/.exec(destination);
  if (route) await open(route[1]!, true);
}
useOverlayKeyboard();
function pointerInput(): void {
  document.documentElement.dataset.input = 'pointer';
}
function togglePalette(): void {
  if (!paletteOpen.value && hasKeyboardOverlay()) return;
  document.querySelector<HTMLElement>(':popover-open')?.hidePopover();
  paletteOpen.value = !paletteOpen.value;
}
function commandShortcut(event: KeyboardEvent): void {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.altKey ||
    event.shiftKey ||
    !(event.ctrlKey || event.metaKey) ||
    event.key.toLowerCase() !== 'k'
  )
    return;
  if (hasKeyboardOverlay()) return;
  event.preventDefault();
  if (event.repeat) return;
  togglePalette();
}
onMounted(() => {
  document.addEventListener('keydown', commandShortcut);
  document.addEventListener('pointerdown', pointerInput, true);
  recheck();
  window.addEventListener('popstate', navigate);
  window.addEventListener('online', recheck);
  document.addEventListener('visibilitychange', visibility);
  void perform(async () => {
    await identity.bootstrap(controller.signal);
    const route = /^\/rooms\/([a-f0-9]{32})$/.exec(location.pathname);
    if (route) await open(route[1]!);
    if (pendingLink.value) await join();
    else if (location.pathname === '/join')
      message.value = msg('api.invalid_invitation');
  });
});
onUnmounted(() => {
  stopLanguage();
  document.removeEventListener('keydown', commandShortcut);
  document.removeEventListener('pointerdown', pointerInput, true);
  controller.abort();
  initialFile = undefined;
  window.removeEventListener('popstate', navigate);
  window.removeEventListener('online', recheck);
  document.removeEventListener('visibilitychange', visibility);
  identity.session = undefined;
});
</script>

<template>
  <div class="shell" :class="{ viewing: !!room }">
    <a class="skip" href="#main" @click.prevent="focusMain">{{
      t('app.skip')
    }}</a>
    <header class="app-header">
      <div class="header-start">
        <a
          class="brand quiet"
          :aria-label="t('app.home')"
          href="/"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span class="brand-mark"><Icon name="play" :size="18" /></span
          ><span>OVS</span><span class="brand-name">Open Video Sync</span>
        </a>
        <button
          class="quiet command-trigger"
          :aria-label="t('commands.open')"
          :title="`${t('commands.open')} (${shortcut})`"
          aria-keyshortcuts="Control+K Meta+K"
          aria-haspopup="dialog"
          @click="togglePalette"
        >
          <Icon name="search" :size="18" /><span>{{ t('commands.title') }}</span
          ><kbd>{{ shortcut }}</kbd>
        </button>
      </div>
      <div class="header-end">
        <p class="server-status" role="status" :data-state="connection.status">
          <span class="status-dot" />{{ serverText }}
        </p>
        <AppSettings ref="appSettings" />
        <button
          v-if="identity.session"
          :title="safeName"
          class="profile-button quiet"
          @click="profileOpen = true"
        >
          <span class="avatar">{{
            Array.from(safeName)[0]?.toUpperCase()
          }}</span
          ><span class="profile-name">{{ safeName }}</span>
        </button>
      </div>
    </header>
    <div
      id="toast-region"
      class="toast-region"
      :data-position="notifications.position"
    />
    <HelperNotice @ready="helperGeneration++" />
    <main id="main" tabindex="-1">
      <ToastNotice v-if="failure" @dismiss="failure = undefined"
        ><div id="app-alert" role="alert" class="notice error">
          <p>
            <strong>{{ t('common.error') }}</strong>
            {{ translate(failure.text) }}
          </p>
          <button
            v-if="failure.reload"
            id="app-reload"
            class="quiet"
            @click="reload"
          >
            {{ t('common.reload') }}
          </button>
        </div></ToastNotice
      >
      <ToastNotice
        v-if="message"
        :key="translate(message)"
        :duration="6000"
        @dismiss="message = ''"
      >
        <div class="app-message" role="status">
          <p class="notice">{{ translate(message) }}</p>
        </div>
      </ToastNotice>
      <template v-if="!identity.session"
        ><div class="initializing">
          <Icon name="screen" :size="32" />
          <h2>
            {{ busy ? t('app.gettingReady') : t('app.identityUnavailable') }}
          </h2>
          <button
            v-if="!busy"
            @click="perform(() => identity.bootstrap(controller.signal))"
          >
            {{ t('app.retryConnection') }}
          </button>
        </div></template
      >
      <template v-else>
        <div v-if="attempt" class="notice">
          <p>{{ t('app.uncertain') }}</p>
          <button
            id="retry-attempt"
            :disabled="busy"
            @click="perform(submitAttempt)"
          >
            {{ t('app.retryOriginal') }}
          </button>
        </div>
        <RoomPanel
          v-if="room"
          ref="roomPanel"
          :room="room"
          :host="host"
          :playlist="player?.playlist"
          :can-select-episode="player?.canReplace ?? false"
          :invitation="invitation"
          :busy="busy"
          :error="failure ? translate(failure.text) : undefined"
          @refresh="
            perform(async () => {
              if (room) await open(room.roomId);
            })
          "
          @settings="(value) => perform(() => manage('settings', value))"
          @share="perform(share)"
          @rotate="perform(() => manage('rotate'))"
          @remove="(id) => perform(() => manage('remove', undefined, id))"
          @leave="requestLeave"
          @close="perform(() => manage('close'))"
          @select-episode="(episode) => player?.selectEpisode(episode)"
        >
          <PlayerPanel
            ref="player"
            :key="room.roomId"
            :room="room"
            :initial-file="initialFile"
            :helper-generation="helperGeneration"
            @snapshot="(value) => (room = value)"
            @connection="connectionChanged"
            @recheck="recheck"
            @ended="
              (reason) => {
                if (!departing && room) void ended(reason);
              }
            "
          />
        </RoomPanel>
        <div v-else class="home">
          <HomeIntro />
          <section class="create-card" aria-labelledby="create-title">
            <div class="card-heading">
              <h2 id="create-title" tabindex="-1">{{ t('app.startParty') }}</h2>
              <span class="private-badge"
                ><Icon name="shield" :size="14" />{{
                  t('app.privateRoom')
                }}</span
              >
            </div>
            <form @submit.prevent="!attempt && perform(create, 'create')">
              <MediaPicker
                ref="picker"
                :room-id="creationKey"
                :disabled="busy || !!attempt"
              />
              <div class="room-draft">
                <label for="room-name"
                  >{{ t('app.roomName') }}
                  <span class="hint">{{ t('common.optional') }}</span></label
                ><input
                  id="room-name"
                  v-model="title"
                  :readonly="busy || !!attempt"
                  maxlength="120"
                  :placeholder="t('app.roomPlaceholder')"
                  :aria-invalid="invalidField === 'room-name' || undefined"
                  @input="invalidField = undefined"
                />
              </div>
              <div class="draft-settings">
                <span
                  ><Icon name="users" :size="16" />{{
                    draftSettings.controllers === 'host'
                      ? t('app.hostControls')
                      : t('app.everyoneControls')
                  }}<span class="separator">·</span
                  >{{
                    draftSettings.waitForAll
                      ? t('settings.wait')
                      : t('app.joinWhenReady')
                  }}</span
                ><button
                  type="button"
                  class="quiet icon-button"
                  :aria-label="t('common.settings')"
                  :disabled="busy || !!attempt"
                  @click="settingsOpen = true"
                >
                  <Icon name="sliders" />
                </button>
              </div>
              <button class="create-submit" :disabled="busy || !!attempt">
                {{ busy ? t('app.preparingRoom') : t('app.createRoom')
                }}<Icon name="arrow" />
              </button>
            </form>
          </section>
          <section class="join-section" aria-labelledby="join-title">
            <h2 id="join-title">{{ t('app.haveInvitation') }}</h2>
            <form
              class="input-action"
              @submit.prevent="!attempt && perform(join, 'join')"
            >
              <input
                id="join-code"
                v-model="code"
                :aria-label="t('app.invitationInput')"
                :readonly="busy || !!attempt"
                maxlength="2048"
                :placeholder="t('app.invitationPlaceholder')"
                autocomplete="off"
                spellcheck="false"
                :aria-invalid="invalidField === 'join-code' || undefined"
                @input="invalidField = undefined"
              /><button
                id="join-submit"
                class="quiet"
                :disabled="busy || !!attempt"
              >
                {{ t('app.join') }}<Icon name="arrow" :size="16" />
              </button>
            </form>
          </section>
          <p class="privacy-note">
            <Icon name="shield" :size="15" />{{ t('app.privacy') }}
          </p>
        </div>
      </template>
    </main>
    <footer>
      <span
        >OVS<span class="separator">/</span>{{ t('app.footerTogether') }}</span
      ><span>{{ t('app.footerPrivate') }}</span>
    </footer>
    <CommandPalette
      v-if="paletteOpen"
      :commands="commands"
      @close="paletteOpen = false"
    />
    <Modal
      v-if="leaveConfirmation && room"
      :title="t('room.leaveTitle')"
      @close="leaveConfirmation = false"
    >
      <p>{{ t('room.leaveWarning') }}</p>
      <p v-if="failure" class="notice error" role="alert">
        {{ translate(failure.text) }}
      </p>
      <div class="actions">
        <button class="quiet" autofocus @click="leaveConfirmation = false">
          {{ t('common.cancel') }}
        </button>
        <button :disabled="busy" @click="perform(confirmLeave)">
          {{ t('room.confirmLeave') }}
        </button>
      </div>
    </Modal>
    <Modal
      v-if="settingsOpen"
      :title="t('common.settings')"
      @close="settingsOpen = false"
      ><form @submit.prevent="settingsOpen = false">
        <SettingsForm v-model="draftSettings" :disabled="busy" /><button>
          {{ t('app.applySettings') }}
        </button>
      </form></Modal
    >
    <Modal
      v-if="profileOpen"
      :title="t('app.profile')"
      @close="profileOpen = false"
      ><IdentityPanel
        :busy="busy || !!attempt"
        :invalid="invalidField === 'display-name'"
        @edit="invalidField = undefined"
        @rename="
          (name) =>
            perform(async () => {
              await identity.rename(name, controller.signal);
              message = msg('app.nameSaved');
            }, 'rename')
        "
        @forget="perform(forget)"
    /></Modal>
  </div>
</template>
