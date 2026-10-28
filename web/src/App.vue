<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
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
import IdentityPanel from './features/identity/IdentityPanel.vue';
import RoomPanel from './features/rooms/RoomPanel.vue';
import PlayerPanel from './features/player/PlayerPanel.vue';

const props = defineProps<{ initialInvitation?: string | undefined }>();
const connection = useConnectionStore(),
  identity = useIdentityStore();
const controller = new AbortController();
const busy = ref(false),
  error = ref(''),
  message = ref('');
const title = ref(''),
  code = ref('');
const room = ref<Snapshot>(),
  invitation = ref<Invitation>();
const recent = ref<RoomSummary[]>([]),
  nextCursor = ref<string | null>(null);
const host = computed(() => room.value?.selfMemberId === room.value?.hostMemberId);
// Retain uncertain create/redeem intent and its key in memory until its outcome is known.
const attempt = ref<{ path: string; payload: unknown; key: string }>();
const pendingLink = ref(props.initialInvitation);
const api = (path: string, method = 'GET', payload?: unknown, key?: string) =>
  request(path, method, identity.session?.csrfToken ?? '', payload, controller.signal, key);

async function perform(work: () => Promise<void>): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  message.value = '';
  try {
    await work();
  } catch (reason) {
    if (!controller.signal.aborted)
      error.value =
        reason instanceof APIError
          ? reason.message
          : 'The request could not finish. Check the connection and try again.';
  } finally {
    if (!controller.signal.aborted) busy.value = false;
  }
}
async function list(append = false): Promise<void> {
  const value = decodeList(
    await api(`/rooms${append && nextCursor.value ? `?cursor=${nextCursor.value}` : ''}`),
  );
  recent.value = append ? [...recent.value, ...value.rooms] : value.rooms;
  nextCursor.value = value.nextCursor;
}
function show(snapshot: Snapshot, share?: Invitation): void {
  room.value = snapshot;
  invitation.value = share;
  history.replaceState(null, '', `/rooms/${snapshot.roomId}`);
}
async function open(id: string): Promise<void> {
  show(decodeSnapshot(await api(`/rooms/${id}`)));
}
async function submitAttempt(): Promise<void> {
  const pending = attempt.value;
  if (!pending) return;
  try {
    const value = decodeRoomResult(await api(pending.path, 'POST', pending.payload, pending.key));
    attempt.value = undefined;
    pendingLink.value = undefined;
    code.value = '';
    title.value = '';
    show(value.snapshot, value.invitation ?? undefined);
    message.value =
      value.replayed && !value.invitation
        ? 'The previous request succeeded. Hosts can replace the invitation to obtain new sharing details.'
        : 'Room ready.';
  } catch (reason) {
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
  };
  await submitAttempt();
}
async function join(): Promise<void> {
  attempt.value = {
    path: '/invitations/redeem',
    payload: pendingLink.value ? { linkSecret: pendingLink.value } : { code: code.value },
    key: requestKey(),
  };
  await submitAttempt();
}
async function manage(
  operation: 'settings' | 'rotate' | 'remove' | 'close',
  settings?: RoomSettings,
  memberId?: string,
): Promise<void> {
  const current = room.value;
  if (!current) return;
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
  const response = object(await api(`/rooms/${current.roomId}${suffix}`, method, payload));
  if (
    operation === 'close' ||
    (operation === 'remove' && (!memberId || memberId === current.selfMemberId))
  ) {
    await back();
    return;
  }
  room.value = decodeSnapshot(
    operation === 'remove' ? await api(`/rooms/${current.roomId}`) : response.snapshot,
  );
  if (operation === 'rotate') invitation.value = decodeInvitation(response.invitation);
  if (operation === 'remove') invitation.value = undefined;
  message.value = 'Room updated.';
}
async function back(): Promise<void> {
  room.value = undefined;
  invitation.value = undefined;
  history.replaceState(null, '', '/');
  await list();
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
}
onMounted(() => {
  void connection.checkReadiness(controller.signal);
  void perform(async () => {
    await identity.bootstrap(controller.signal);
    await list();
    const route = /^\/rooms\/([a-f0-9]{32})$/.exec(location.pathname);
    if (route) await open(route[1]!);
    if (pendingLink.value) message.value = 'An invitation is ready. Select Join room to continue.';
  });
});
onUnmounted(() => {
  controller.abort();
  identity.session = undefined;
});
</script>

<template>
  <a class="skip" href="#main">Skip to main content</a>
  <main id="main" :aria-busy="busy">
    <header>
      <p class="eyebrow">Private rooms · Your media stays with you</p>
      <h1>Open Video Sync</h1>
      <p role="status">Server: {{ connection.status }}</p>
    </header>
    <p v-if="error" role="alert" class="notice error">{{ error }}</p>
    <p v-if="message" role="status" class="notice">{{ message }}</p>
    <p v-if="!identity.session">
      {{ busy ? 'Restoring your identity…' : 'Your identity could not be restored.' }}
    </p>
    <button
      v-if="!identity.session && !busy"
      @click="
        perform(async () => {
          await identity.bootstrap(controller.signal);
          await list();
        })
      "
    >
      Retry connection
    </button>
    <template v-if="identity.session">
      <IdentityPanel
        :busy="busy || !!attempt"
        @rename="
          (name) =>
            perform(async () => {
              await identity.rename(name, controller.signal);
              message = 'Name saved.';
            })
        "
        @forget="perform(forget)"
      />
      <div v-if="attempt" class="notice">
        <p>The request outcome is uncertain. Retry the original request to check its result.</p>
        <button :disabled="busy" @click="perform(submitAttempt)">Retry original request</button>
      </div>
      <PlayerPanel
        v-if="room"
        :key="room.roomId"
        :room="room"
        @snapshot="(value) => (room = value)"
      />
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
        @rotate="perform(() => manage('rotate'))"
        @remove="(memberId) => perform(() => manage('remove', undefined, memberId))"
        @leave="perform(() => manage('remove'))"
        @close="perform(() => manage('close'))"
      />
      <template v-else>
        <div class="rooms-grid">
          <section aria-labelledby="create-title">
            <h2 id="create-title">Create a room</h2>
            <form @submit.prevent="perform(create)">
              <label for="room-name">Room title</label
              ><input
                id="room-name"
                v-model="title"
                :disabled="busy || !!attempt"
                required
              /><button :disabled="busy || !!attempt">Create room</button>
            </form>
          </section>
          <section aria-labelledby="join-title">
            <h2 id="join-title">Join a room</h2>
            <form @submit.prevent="perform(join)">
              <p v-if="pendingLink">An invitation link is ready.</p>
              <template v-else
                ><label for="join-code">Invitation code</label
                ><input
                  id="join-code"
                  v-model="code"
                  :disabled="busy || !!attempt"
                  required
                  autocomplete="off"
                  spellcheck="false" /></template
              ><button :disabled="busy || !!attempt">Join room</button>
            </form>
          </section>
        </div>
        <section aria-labelledby="recent-title">
          <div class="form-row">
            <h2 id="recent-title">Your rooms</h2>
            <button class="quiet" :disabled="busy" @click="perform(() => list())">
              Refresh list
            </button>
          </div>
          <p v-if="!recent.length">Create a room or join with a private invitation.</p>
          <ul class="room-list">
            <li v-for="item in recent" :key="item.roomId">
              <button class="quiet" :disabled="busy" @click="perform(() => open(item.roomId))">
                {{ item.title }}</button
              ><small>{{ item.role }}</small>
            </li>
          </ul>
          <button v-if="nextCursor" :disabled="busy" @click="perform(() => list(true))">
            More rooms
          </button>
        </section>
      </template>
    </template>
    <footer>
      Local synchronized viewing is in development. Bilibili and danmaku remain planned.
    </footer>
  </main>
</template>
