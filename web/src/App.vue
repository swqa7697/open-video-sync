<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watchEffect } from 'vue';
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
import AppearancePanel from './features/AppearancePanel.vue';

const props = defineProps<{ initialInvitation?: string | undefined }>();
const connection = useConnectionStore(),
  identity = useIdentityStore();
const controller = new AbortController();
const departing = ref(false);
const busy = ref(false),
  failure = ref<Failure>(),
  invalidField = ref<string>(),
  message = ref('');
const title = ref(''),
  code = ref('');
const room = ref<Snapshot>(),
  invitation = ref<Invitation>();
const creationKey = ref(requestKey());
const picker = ref<InstanceType<typeof MediaPicker>>();
const draftSettings = ref(defaultSettings()),
  settingsOpen = ref(false),
  profileOpen = ref(false);
const appearanceOpen = ref(false);
const helperGeneration = ref(0);
let initialFile: File | undefined;
const safeName = computed(() => identity.session?.identity.displayName || 'Guest');
const host = computed(() => room.value?.selfMemberId === room.value?.hostMemberId);
// Retain uncertain create/redeem intent and its key in memory until its outcome is known.
const attempt = ref<{
  path: string;
  payload: unknown;
  key: string;
  started: number;
  sent: boolean;
}>();
const pendingLink = ref(props.initialInvitation);
const serverText = computed(
  () =>
    ({
      checking: 'Server: checking…',
      ready: 'Server: ready',
      not_ready: 'Server: online, but cannot save changes',
      unreachable: 'Server: unreachable',
    })[connection.status],
);
// Room titles stay out of browser history; the room heading names the room.
watchEffect(() => {
  document.title = `${
    room.value
      ? 'Room'
      : !identity.session && !busy.value
        ? 'Connection problem'
        : pendingLink.value
          ? 'Join a room'
          : 'Watch together'
  } · Open Video Sync`;
});
const api = (path: string, method = 'GET', payload?: unknown, key?: string, replayOnly = false) =>
  request(
    path,
    method,
    identity.session?.csrfToken ?? '',
    payload,
    controller.signal,
    key,
    replayOnly,
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
  context: FailureContext = 'other',
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
      if (reason instanceof APIError && reason.code === 'invitation_reset_required')
        message.value = reason.message;
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
    message.value =
      'Request recovery expired. No second room was created. Check the room link or start a new request explicitly.';
    return;
  }
  try {
    const replayOnly = pending.sent && pending.path === '/rooms';
    pending.sent = true;
    const value = decodeRoomResult(
      await api(pending.path, 'POST', pending.payload, pending.key, replayOnly),
    );
    attempt.value = undefined;
    pendingLink.value = undefined;
    code.value = '';
    title.value = '';
    show(value.snapshot, value.invitation ?? undefined);
    if (pending.path !== '/rooms') initialFile = undefined;
    message.value = 'Room ready.';
    void focus('room-title');
  } catch (reason) {
    if (reason instanceof APIError && reason.code === 'request_outcome_unknown') {
      attempt.value = undefined;
      try {
        await open(pending.key, true);
        if (room.value) return;
      } catch {
        /* No unauthorized state is exposed. */
      }
      message.value =
        'The original room could not be recovered. No second room was created. You can start a new request.';
      creationKey.value = requestKey();
      return;
    }
    // Uncertain outcomes keep the original request for an explicit retry.
    if (reason instanceof APIError && !['busy', 'storage_unavailable'].includes(reason.code))
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
      title: title.value.trim() || 'Watch party',
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
  if (pendingLink.value) return { linkSecret: pendingLink.value };
  const raw = code.value.trim();
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
const managed: Record<'settings' | 'rotate' | 'remove', string> = {
  settings: 'Preferences saved.',
  rotate: 'Invitation replaced. Previous links and codes no longer work.',
  remove: 'Participant removed. The invitation was replaced.',
};
async function manage(
  operation: 'settings' | 'rotate' | 'remove' | 'close' | 'leave',
  settings?: RoomSettings,
  memberId?: string,
): Promise<void> {
  const current = room.value;
  if (!current) return;
  const self =
    operation === 'close' || operation === 'leave' || (operation === 'remove' && !memberId);
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
    response = object(await api(`/rooms/${current.roomId}${suffix}`, method, payload));
  } catch (reason) {
    if (reason instanceof APIError && reason.code === 'not_found') {
      // The room may still exist; only a missing room ends this view.
      await open(current.roomId);
      if (room.value && operation === 'remove' && !self) {
        message.value = 'That participant already left.';
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
      operation === 'close' ? `You closed “${current.title}”.` : `You left “${current.title}”.`;
    await back();
    return;
  }
  room.value = decodeSnapshot(
    operation === 'remove' ? await api(`/rooms/${current.roomId}`) : response.snapshot,
  );
  if (operation === 'rotate') invitation.value = decodeInvitation(response.invitation);
  if (operation === 'remove') {
    invitation.value = undefined;
    if (host.value) await share();
  }
  message.value = managed[operation];
}
async function share(): Promise<void> {
  if (!room.value || !host.value) return;
  invitation.value = decodeInvitation(
    object(await api(`/rooms/${room.value.roomId}/invitations`)).invitation,
  );
}
async function back(): Promise<void> {
  room.value = undefined;
  invitation.value = undefined;
  history.replaceState(null, '', '/');
  initialFile = undefined;
  creationKey.value = requestKey();
  void focus('create-title');
}
// A room connection ended for good. Leave the room view and say why.
async function ended(reason: EndReason): Promise<void> {
  const name = room.value?.title,
    active = document.activeElement,
    focusInside = !active || active === document.body || !!active.closest('.room');
  room.value = undefined;
  invitation.value = undefined;
  history.replaceState(null, '', '/');
  const quoted = name ? `“${name}”` : 'This room';
  if (reason === 'session_ended' || reason === 'revoked') {
    failure.value = {
      text:
        reason === 'session_ended'
          ? 'Your identity session ended in this browser. Reload to continue with a new identity.'
          : 'The room connection ended. Reload to continue.',
      reload: true,
    };
    if (reason === 'session_ended') identity.session = undefined;
    if (focusInside) void focus('app-reload');
    return;
  }
  message.value =
    reason === 'closed'
      ? `The host closed ${quoted}.`
      : reason === 'removed'
        ? `You were removed from ${quoted}. Ask the host for a new invitation.`
        : `${quoted} is no longer available to you.`;
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
  message.value = 'A new identity is active.';
  void focus('identity-title');
}
function connectionChanged(): void {
  recheck();
}
function visibility(): void {
  if (document.visibilityState === 'visible' && connection.status !== 'ready') recheck();
}
function navigate(): void {
  void perform(async () => {
    const destination = location.pathname;
    if (room.value) await manage('leave');
    const route = /^\/rooms\/([a-f0-9]{32})$/.exec(destination);
    if (route) await open(route[1]!, true);
  });
}
function keyboardInput(): void {
  document.documentElement.dataset.input = 'keyboard';
}
function pointerInput(): void {
  document.documentElement.dataset.input = 'pointer';
}
onMounted(() => {
  document.addEventListener('keydown', keyboardInput, true);
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
      message.value = 'This invitation is unavailable or the room has closed.';
  });
});
onUnmounted(() => {
  document.removeEventListener('keydown', keyboardInput, true);
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
    <a class="skip" href="#main" @click.prevent="focusMain">Skip to main content</a>
    <header class="app-header">
      <button
        class="brand quiet"
        aria-label="OVS home"
        :disabled="busy"
        @click="room && perform(() => manage('leave'))"
      >
        <span class="brand-mark"><Icon name="play" :size="18" /></span><span>OVS</span
        ><span class="brand-name">Open Video Sync</span>
      </button>
      <div class="header-end">
        <p class="server-status" role="status" :data-state="connection.status">
          <span class="status-dot" />{{ serverText }}
        </p>
        <button
          class="quiet icon-button"
          aria-label="Appearance"
          title="Appearance"
          @click="appearanceOpen = true"
        >
          <Icon name="appearance" />
        </button>
        <button
          v-if="identity.session"
          :title="safeName"
          class="profile-button quiet"
          @click="profileOpen = true"
        >
          <span class="avatar">{{ Array.from(safeName)[0]?.toUpperCase() }}</span
          ><span class="profile-name">{{ safeName }}</span
          ><Icon name="chevron" :size="16" />
        </button>
      </div>
    </header>
    <HelperNotice @ready="helperGeneration++" />
    <main id="main" tabindex="-1">
      <div v-if="failure" id="app-alert" role="alert" class="notice error">
        <p><strong>Error:</strong> {{ failure.text }}</p>
        <button v-if="failure.reload" id="app-reload" class="quiet" @click="reload">
          Reload page
        </button>
      </div>
      <div class="app-message" role="status">
        <p v-if="message" class="notice">{{ message }}</p>
      </div>
      <template v-if="!identity.session"
        ><div class="initializing">
          <Icon name="screen" :size="32" />
          <h2>{{ busy ? 'Getting things ready…' : 'Your identity could not be restored.' }}</h2>
          <button v-if="!busy" @click="perform(() => identity.bootstrap(controller.signal))">
            Retry connection
          </button>
        </div></template
      >
      <template v-else>
        <div v-if="attempt" class="notice">
          <p>The request outcome is uncertain. Check the original request to recover its result.</p>
          <button id="retry-attempt" :disabled="busy" @click="perform(submitAttempt)">
            Retry original request
          </button>
        </div>
        <RoomPanel
          v-if="room"
          :room="room"
          :host="host"
          :invitation="invitation"
          :busy="busy"
          :error="failure?.text"
          @refresh="
            perform(async () => {
              if (room) await open(room.roomId);
            })
          "
          @settings="(value) => perform(() => manage('settings', value))"
          @share="perform(share)"
          @rotate="perform(() => manage('rotate'))"
          @remove="(id) => perform(() => manage('remove', undefined, id))"
          @leave="perform(() => manage('leave'))"
          @close="perform(() => manage('close'))"
        >
          <PlayerPanel
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
          <div class="home-heading">
            <p class="eyebrow"><span class="status-dot" />A private place to press play</p>
            <h1>Good company.<br /><span>Perfectly in sync.</span></h1>
            <p>Pick a video. Invite your people. Watch together.</p>
          </div>
          <section class="create-card" aria-labelledby="create-title">
            <div class="card-heading">
              <h2 id="create-title" tabindex="-1">Start a watch party</h2>
              <span class="private-badge"><Icon name="shield" :size="14" />Private room</span>
            </div>
            <form @submit.prevent="!attempt && perform(create, 'create')">
              <MediaPicker ref="picker" :room-id="creationKey" :disabled="busy || !!attempt" />
              <div class="room-draft">
                <label for="room-name">Room name <span class="hint">optional</span></label
                ><input
                  id="room-name"
                  v-model="title"
                  :readonly="busy || !!attempt"
                  maxlength="120"
                  placeholder="e.g. Friday movie night"
                  :aria-invalid="invalidField === 'room-name' || undefined"
                  @input="invalidField = undefined"
                />
              </div>
              <div class="draft-settings">
                <span
                  ><Icon name="users" :size="16" />{{
                    draftSettings.controllers === 'host' ? 'Host controls' : 'Everyone controls'
                  }}<span class="separator">·</span
                  >{{ draftSettings.waitForAll ? 'Wait for everyone' : 'Join when ready' }}</span
                ><button
                  type="button"
                  class="quiet icon-button"
                  aria-label="Room settings"
                  :disabled="busy || !!attempt"
                  @click="settingsOpen = true"
                >
                  <Icon name="settings" />
                </button>
              </div>
              <button class="create-submit" :disabled="busy || !!attempt">
                {{ busy ? 'Preparing room…' : 'Create room' }}<Icon name="arrow" />
              </button>
            </form>
          </section>
          <section class="join-section" aria-labelledby="join-title">
            <h2 id="join-title">Already have an invitation?</h2>
            <form class="input-action" @submit.prevent="!attempt && perform(join, 'join')">
              <input
                id="join-code"
                v-model="code"
                aria-label="Invitation link or code"
                :readonly="busy || !!attempt"
                maxlength="2048"
                placeholder="Paste an invitation link or code"
                autocomplete="off"
                spellcheck="false"
                :aria-invalid="invalidField === 'join-code' || undefined"
                @input="invalidField = undefined"
              /><button id="join-submit" class="quiet" :disabled="busy || !!attempt">
                Join<Icon name="arrow" :size="16" />
              </button>
            </form>
          </section>
          <p class="privacy-note">
            <Icon name="shield" :size="15" />Your media stays yours. Only playback stays in sync.
          </p>
        </div>
      </template>
    </main>
    <footer>
      <span>OVS<span class="separator">/</span>Made for watching together</span
      ><span>Private rooms. Your own media.</span>
    </footer>
    <Modal v-if="settingsOpen" title="Room settings" @close="settingsOpen = false"
      ><form @submit.prevent="settingsOpen = false">
        <SettingsForm v-model="draftSettings" :disabled="busy" /><button>Apply settings</button>
      </form></Modal
    >
    <Modal v-if="appearanceOpen" title="Appearance" @close="appearanceOpen = false">
      <AppearancePanel />
    </Modal>
    <Modal v-if="profileOpen" title="Your profile" @close="profileOpen = false"
      ><IdentityPanel
        :busy="busy || !!attempt"
        :invalid="invalidField === 'display-name'"
        @edit="invalidField = undefined"
        @rename="
          (name) =>
            perform(async () => {
              await identity.rename(name, controller.signal);
              message = 'Name saved.';
            }, 'rename')
        "
        @forget="perform(forget)"
    /></Modal>
  </div>
</template>
