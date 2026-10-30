<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watchEffect } from 'vue';
import { useConnectionStore } from './stores/connection';
import { useIdentityStore } from './stores/identity';
import {
  APIError,
  decodeInvitation,
  decodeList,
  decodeRoomResult,
  decodeSnapshot,
  defaultSettings,
  object,
  request,
  requestKey,
  type Invitation,
  type RoomSummary,
  type Snapshot,
} from './transport/api';
import { decodeRoomSettings, type RoomSettings } from './transport/contracts';
import type { EndReason } from './transport/room-socket';
import { describeFailure, type Failure, type FailureContext } from './features/failures';
import IdentityPanel from './features/identity/IdentityPanel.vue';
import RoomPanel from './features/rooms/RoomPanel.vue';
import PlayerPanel from './features/player/PlayerPanel.vue';

const props = defineProps<{ initialInvitation?: string | undefined }>();
const connection = useConnectionStore(),
  identity = useIdentityStore();
const controller = new AbortController();
const busy = ref(false),
  failure = ref<Failure>(),
  invalidField = ref<string>(),
  message = ref('');
const title = ref(''),
  code = ref('');
const room = ref<Snapshot>(),
  invitation = ref<Invitation>();
const recent = ref<RoomSummary[]>([]),
  nextCursor = ref<string | null>(null);
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
          : 'Your rooms'
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
async function list(append = false): Promise<void> {
  const shown = recent.value.length;
  const value = decodeList(
    await api(`/rooms${append && nextCursor.value ? `?cursor=${nextCursor.value}` : ''}`),
  );
  recent.value = append ? [...recent.value, ...value.rooms] : value.rooms;
  nextCursor.value = value.nextCursor;
  if (append) {
    await nextTick();
    document.querySelectorAll<HTMLButtonElement>('.room-list li > button')[shown]?.focus();
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
    await list();
    message.value = 'Request recovery expired. Check Your rooms before choosing a new action.';
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
    message.value = 'Room ready.';
    void focus('room-title');
  } catch (reason) {
    if (reason instanceof APIError && reason.code === 'request_outcome_unknown') {
      attempt.value = undefined;
      await list();
      message.value = reason.message;
      return;
    }
    // Uncertain outcomes keep the original request for an explicit retry.
    if (reason instanceof APIError && !['busy', 'storage_unavailable'].includes(reason.code))
      attempt.value = undefined;
    throw reason;
  }
}
async function create(): Promise<void> {
  attempt.value = {
    path: '/rooms',
    payload: { title: title.value, settings: defaultSettings() },
    key: requestKey(),
    started: performance.now(),
    sent: false,
  };
  await submitAttempt();
}
async function join(): Promise<void> {
  attempt.value = {
    path: '/invitations/redeem',
    payload: pendingLink.value ? { linkSecret: pendingLink.value } : { code: code.value },
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
  operation: 'settings' | 'rotate' | 'remove' | 'close',
  settings?: RoomSettings,
  memberId?: string,
): Promise<void> {
  const current = room.value;
  if (!current) return;
  const self = operation === 'close' || (operation === 'remove' && !memberId);
  const suffix =
    operation === 'settings'
      ? '/settings'
      : operation === 'rotate'
        ? '/invitations'
        : operation === 'remove'
          ? `/members/${memberId ?? current.selfMemberId}`
          : '';
  const method = operation === 'settings' ? 'PATCH' : operation === 'rotate' ? 'POST' : 'DELETE';
  const payload = {
    epoch: current.epoch,
    expectedRevision: current.revision,
    ...(settings ? { settings: decodeRoomSettings(settings) } : {}),
  };
  let response: Record<string, unknown>;
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
  await list();
  void focus('recent-title');
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
  try {
    await list();
  } catch (error) {
    failure.value = describeFailure(error);
  }
  // Keep focus where it is unless the room took it or the refreshed list removed it.
  if (focusInside || !active?.isConnected) void focus('recent-title');
}
async function forget(): Promise<void> {
  await identity.forget(controller.signal);
  room.value = undefined;
  invitation.value = undefined;
  recent.value = [];
  attempt.value = undefined;
  pendingLink.value = undefined;
  history.replaceState(null, '', '/');
  await identity.bootstrap(controller.signal);
  await list();
  message.value = 'A new identity is active.';
  void focus('identity-title');
}
function connectionChanged(): void {
  recheck();
}
function visibility(): void {
  if (document.visibilityState === 'visible' && connection.status !== 'ready') recheck();
}
onMounted(() => {
  recheck();
  window.addEventListener('online', recheck);
  document.addEventListener('visibilitychange', visibility);
  void perform(async () => {
    await identity.bootstrap(controller.signal);
    await list();
    const route = /^\/rooms\/([a-f0-9]{32})$/.exec(location.pathname);
    if (route) await open(route[1]!);
    if (pendingLink.value) {
      message.value = 'An invitation is ready. Select Join room to continue.';
      void focus('join-submit');
    }
  });
});
onUnmounted(() => {
  controller.abort();
  window.removeEventListener('online', recheck);
  document.removeEventListener('visibilitychange', visibility);
  identity.session = undefined;
});
</script>

<template>
  <div class="shell">
    <a class="skip" href="#main" @click.prevent="focusMain">Skip to main content</a>
    <header>
      <p class="eyebrow">Private rooms · Your media stays with you</p>
      <h1>Open Video Sync</h1>
      <p role="status">{{ serverText }}</p>
    </header>
    <main id="main" tabindex="-1">
      <div v-if="failure" id="app-alert" role="alert" class="notice error">
        <p><strong>Error:</strong> {{ failure.text }}</p>
        <button v-if="failure.reload" id="app-reload" type="button" @click="reload">
          Reload page
        </button>
      </div>
      <div role="status">
        <p v-if="message" class="notice">{{ message }}</p>
      </div>
      <template v-if="!identity.session">
        <p>{{ busy ? 'Restoring your identity…' : 'Your identity could not be restored.' }}</p>
        <button
          v-if="!busy"
          @click="
            perform(async () => {
              await identity.bootstrap(controller.signal);
              await list();
            })
          "
        >
          Retry connection
        </button>
      </template>
      <template v-else>
        <div v-if="attempt" class="notice">
          <p>The request outcome is uncertain. Retry the original request to check its result.</p>
          <button
            id="retry-attempt"
            :aria-disabled="busy || undefined"
            @click="perform(submitAttempt)"
          >
            Retry original request
          </button>
        </div>
        <RoomPanel
          v-if="room"
          :room="room"
          :host="host"
          :invitation="invitation"
          :busy="busy"
          @refresh="
            perform(async () => {
              if (room) await open(room.roomId);
            })
          "
          @back="perform(back)"
          @settings="(value) => perform(() => manage('settings', value))"
          @share="perform(share)"
          @rotate="perform(() => manage('rotate'))"
          @remove="(memberId) => perform(() => manage('remove', undefined, memberId))"
          @leave="perform(() => manage('remove'))"
          @close="perform(() => manage('close'))"
        >
          <PlayerPanel
            :key="room.roomId"
            :room="room"
            @snapshot="(value) => (room = value)"
            @connection="connectionChanged"
            @recheck="recheck"
            @ended="(reason) => void ended(reason)"
          />
        </RoomPanel>
        <IdentityPanel
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
        />
        <template v-if="!room">
          <div class="rooms-grid">
            <section aria-labelledby="create-title">
              <h2 id="create-title">Create a room</h2>
              <form @submit.prevent="!attempt && perform(create, 'create')">
                <label for="room-name">Room title</label
                ><input
                  id="room-name"
                  v-model="title"
                  :readonly="busy || !!attempt"
                  maxlength="240"
                  required
                  :aria-invalid="invalidField === 'room-name' || undefined"
                  :aria-describedby="invalidField === 'room-name' ? 'app-alert' : undefined"
                  @input="invalidField = undefined"
                /><button :aria-disabled="busy || !!attempt || undefined">Create room</button>
              </form>
            </section>
            <section aria-labelledby="join-title">
              <h2 id="join-title">Join a room</h2>
              <form @submit.prevent="!attempt && perform(join, 'join')">
                <p v-if="pendingLink">An invitation link is ready.</p>
                <template v-else
                  ><label for="join-code">Invitation code</label
                  ><input
                    id="join-code"
                    v-model="code"
                    :readonly="busy || !!attempt"
                    maxlength="32"
                    required
                    autocomplete="off"
                    spellcheck="false"
                    :aria-invalid="invalidField === 'join-code' || undefined"
                    :aria-describedby="invalidField === 'join-code' ? 'app-alert' : undefined"
                    @input="invalidField = undefined" /></template
                ><button id="join-submit" :aria-disabled="busy || !!attempt || undefined">
                  Join room
                </button>
              </form>
            </section>
          </div>
          <section aria-labelledby="recent-title">
            <div class="form-row">
              <h2 id="recent-title" tabindex="-1">Your rooms</h2>
              <button
                class="quiet"
                :aria-disabled="busy || undefined"
                @click="perform(() => list())"
              >
                Refresh list
              </button>
            </div>
            <p v-if="!recent.length">Create a room or join with a private invitation.</p>
            <ul class="room-list">
              <li v-for="item in recent" :key="item.roomId">
                <button
                  class="quiet"
                  :aria-disabled="busy || undefined"
                  @click="perform(() => open(item.roomId, true))"
                >
                  {{ item.title }}</button
                ><small>{{ item.role === 'host' ? 'You host this room' : 'Participant' }}</small>
              </li>
            </ul>
            <button
              v-if="nextCursor"
              :aria-disabled="busy || undefined"
              @click="perform(() => list(true))"
            >
              More rooms
            </button>
          </section>
        </template>
      </template>
    </main>
    <footer>
      Video and danmaku stay in each participant’s browser. OVS shares playback state only.
    </footer>
  </div>
</template>
