<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

import Icon from '../../components/Icon.vue';
import Modal from '../../components/Modal.vue';
import { errorMessage, message, t, translate, type Message } from '../../i18n';
import { useIdentityStore } from '../../stores/identity';
import {
  decodeList,
  decodeSnapshot,
  request,
  type RoomSummary,
  type Snapshot,
} from '../../transport/api';
import type { MediaDescriptor } from '../../transport/contracts';
import MediaPicker from '../media/MediaPicker.vue';
import { clearImport, type ImportEntry } from './entry';
import type { ImportOutcome } from './types';

const props = defineProps<{
  initialImport: ImportEntry;
  disabled?: boolean;
  replace: (
    snapshot: Snapshot,
    media: MediaDescriptor,
  ) => Promise<ImportOutcome>;
  openRoom: (
    snapshot: Snapshot,
    media: MediaDescriptor,
  ) => Promise<ImportOutcome>;
}>();
const emit = defineEmits<{
  create: [selection: { media: MediaDescriptor; title: string }];
}>();
const identity = useIdentityStore();
const picker = ref<InstanceType<typeof MediaPicker>>();
const prepared = ref<MediaDescriptor>();
const previewTitle = ref('');
const title = ref('');
const rooms = ref<RoomSummary[]>([]);
const nextCursor = ref<string | null>(null);
const selectedRoom = ref('');
const snapshot = ref<Snapshot>();
const listing = ref(false),
  loadingRoom = ref(false),
  working = ref(false),
  confirmation = ref(false);
const listError = ref<Message | ''>(''),
  roomError = ref<Message | ''>(''),
  prepareError = ref<Message | ''>('');
const outcome = ref<ImportOutcome>();
let pending: { snapshot: Snapshot; media: MediaDescriptor } | undefined;
let prefilled = false;
const lifecycle = new AbortController();
let roomController: AbortController | undefined;
const locked = computed(
  () =>
    props.disabled || working.value || outcome.value?.status === 'uncertain',
);
const outcomeText = computed(() => {
  const value = outcome.value;
  if (!value) return '';
  return translate(value.message ?? message(`import.${value.status}`));
});
const mediaText = (media: MediaDescriptor | null | undefined): string =>
  !media
    ? t('import.noMedia')
    : media.kind === 'local'
      ? t('common.localFile')
      : media.episodeId
        ? `EP${media.episodeId}`
        : `${media.bvid} · ${t('import.part', { part: media.part })}`;
const api = (path: string, signal = lifecycle.signal) =>
  request(path, 'GET', identity.session?.csrfToken ?? '', undefined, signal);

async function list(more = false): Promise<void> {
  if (listing.value || lifecycle.signal.aborted) return;
  listing.value = true;
  listError.value = '';
  try {
    const cursor = more ? nextCursor.value : null;
    const value = decodeList(
      await api(`/rooms?limit=20${cursor ? `&cursor=${cursor}` : ''}`),
    );
    if (lifecycle.signal.aborted) return;
    const hosts = value.rooms.filter((room) => room.role === 'host');
    rooms.value = more ? [...rooms.value, ...hosts] : hosts;
    nextCursor.value = value.nextCursor;
    if (!more) {
      if (!rooms.value.some((room) => room.roomId === selectedRoom.value))
        selectedRoom.value = '';
      else await loadRoom();
    }
  } catch (reason) {
    if (!lifecycle.signal.aborted)
      listError.value = errorMessage(reason, 'import.roomsFailed');
  } finally {
    if (!lifecycle.signal.aborted) listing.value = false;
  }
}

async function loadRoom(): Promise<void> {
  roomController?.abort();
  roomController = new AbortController();
  const signal = roomController.signal;
  snapshot.value = undefined;
  roomError.value = '';
  outcome.value = undefined;
  pending = undefined;
  loadingRoom.value = false;
  if (!selectedRoom.value) return;
  loadingRoom.value = true;
  try {
    const value = decodeSnapshot(
      await api(`/rooms/${selectedRoom.value}`, signal),
    );
    if (signal.aborted) return;
    if (value.selfMemberId !== value.hostMemberId)
      roomError.value = message('api.forbidden');
    else snapshot.value = value;
  } catch (reason) {
    if (!signal.aborted)
      roomError.value = errorMessage(reason, 'import.roomsFailed');
  } finally {
    if (!signal.aborted) loadingRoom.value = false;
  }
}
watch(selectedRoom, loadRoom);
watch(
  [() => props.disabled, picker],
  async ([disabled, input]) => {
    if (disabled || !input || prefilled || !props.initialImport.selection)
      return;
    prefilled = true;
    await input.selectBilibili(props.initialImport.selection);
  },
  { flush: 'post' },
);

async function preview(): Promise<void> {
  if (locked.value) return;
  prepareError.value = '';
  const value = await picker.value?.prepare();
  if (lifecycle.signal.aborted || !value) return;
  if (value.media.kind !== 'bilibili') {
    prepareError.value = message('import.bilibiliOnly');
    return;
  }
  prepared.value = value.media;
  previewTitle.value = value.title ?? '';
  await nextTick();
  document.getElementById('import-destination')?.focus();
}
function edit(): void {
  if (locked.value) return;
  prepared.value = undefined;
  outcome.value = undefined;
  pending = undefined;
  void nextTick(() => document.getElementById('bilibili-url')?.focus());
}
function create(): void {
  if (locked.value || !prepared.value) return;
  emit('create', {
    media: prepared.value,
    title: title.value.trim() || t('app.defaultRoomName'),
  });
}
function confirm(): void {
  if (locked.value || listing.value || !snapshot.value || !prepared.value)
    return;
  pending = { snapshot: snapshot.value, media: prepared.value };
  confirmation.value = true;
}
async function submitReplacement(): Promise<void> {
  if (working.value || props.disabled || !pending) return;
  const intent = pending;
  working.value = true;
  try {
    const result = await props.replace(intent.snapshot, intent.media);
    if (lifecycle.signal.aborted) return;
    confirmation.value = false;
    outcome.value = result;
    if (result.status === 'accepted') clearImport();
    await nextTick();
    document.getElementById('import-result')?.focus();
  } catch (reason) {
    if (!lifecycle.signal.aborted) {
      confirmation.value = false;
      // Once submitted, an unexpected failure cannot prove the command was absent.
      outcome.value = {
        status: 'uncertain',
        message: errorMessage(reason, 'import.uncertain'),
      };
    }
  } finally {
    if (!lifecycle.signal.aborted) working.value = false;
  }
}
async function open(): Promise<void> {
  if (locked.value || !pending || outcome.value?.status !== 'unavailable')
    return;
  const intent = pending;
  working.value = true;
  try {
    const result = await props.openRoom(intent.snapshot, intent.media);
    if (!lifecycle.signal.aborted) outcome.value = result;
  } catch (reason) {
    if (!lifecycle.signal.aborted)
      outcome.value = {
        status: 'failed',
        message: errorMessage(reason, 'import.failed'),
      };
  } finally {
    if (!lifecycle.signal.aborted) working.value = false;
  }
}
onMounted(() => {
  void list();
});
onUnmounted(() => {
  lifecycle.abort();
  roomController?.abort();
});
</script>

<template>
  <section class="import-panel" aria-labelledby="import-title">
    <div class="import-heading">
      <p class="eyebrow">BILIBILI → OVS</p>
      <h1 id="import-title">{{ t('import.title') }}</h1>
      <p class="hint">{{ t('import.hint') }}</p>
    </div>
    <p v-if="initialImport.invalid" class="notice error" role="alert">
      {{ t('import.invalid') }}
    </p>
    <section class="create-card import-video" :aria-label="t('media.preview')">
      <div class="card-heading">
        <h2>{{ t('import.video') }}</h2>
        <button
          v-if="prepared && !outcome"
          class="quiet"
          :disabled="locked"
          @click="edit"
        >
          {{ t('import.edit') }}
        </button>
      </div>
      <MediaPicker
        v-show="!prepared"
        ref="picker"
        bilibili-only
        room-id="import"
        :disabled="locked"
      />
      <p v-if="prepared" class="import-media">
        <Icon name="screen" /><span
          ><strong v-if="previewTitle">{{ previewTitle }}</strong
          ><span>{{ mediaText(prepared) }}</span></span
        >
      </p>
      <p v-if="prepareError" class="notice error" role="alert">
        {{ translate(prepareError) }}
      </p>
      <button
        v-if="!prepared"
        class="create-submit"
        :disabled="locked"
        @click="preview"
      >
        {{ t('import.continue') }}<Icon name="arrow" />
      </button>
    </section>

    <template v-if="prepared">
      <h2 id="import-destination" tabindex="-1">
        {{ t('import.destination') }}
      </h2>
      <p
        v-if="outcome"
        id="import-result"
        :class="['notice', { error: outcome.status !== 'accepted' }]"
        role="status"
        tabindex="-1"
      >
        {{ outcomeText }}
      </p>
      <p v-if="working" class="hint" role="status">
        {{ t('import.replacing') }}
      </p>
      <div v-if="outcome?.status === 'uncertain'" class="import-recovery">
        <button :disabled="working || disabled" @click="submitReplacement">
          {{ t('import.retry') }}
        </button>
      </div>
      <div
        v-else-if="outcome?.status === 'unavailable'"
        class="import-recovery"
      >
        <p class="hint">{{ t('import.takeoverHint') }}</p>
        <button :disabled="locked" @click="open">
          {{ t('import.openAndReplace') }}
        </button>
      </div>
      <div v-else-if="outcome?.status === 'stale'" class="import-recovery">
        <button :disabled="locked" @click="loadRoom">
          {{ t('import.refreshRoom') }}
        </button>
      </div>

      <div v-if="outcome?.status !== 'accepted'" class="import-destinations">
        <form
          class="create-card"
          @submit.prevent="create"
          @keydown.enter="
            (event) => event.isComposing && event.preventDefault()
          "
        >
          <div class="card-heading">
            <h2>{{ t('import.newRoom') }}</h2>
            <Icon name="plus" />
          </div>
          <label for="import-room-title"
            >{{ t('app.roomName') }}
            <span class="hint">{{ t('common.optional') }}</span></label
          >
          <input
            id="import-room-title"
            v-model="title"
            :readonly="locked"
            maxlength="120"
            autocomplete="off"
            :placeholder="t('app.roomPlaceholder')"
          />
          <p class="hint">{{ t('import.defaults') }}</p>
          <button type="submit" :disabled="locked">
            {{ t('app.createRoom') }}
          </button>
        </form>

        <section class="create-card" :aria-label="t('import.existingRoom')">
          <div class="card-heading">
            <h2>{{ t('import.existingRoom') }}</h2>
            <button class="quiet" :disabled="locked || listing" @click="list()">
              {{ t('import.refresh') }}
            </button>
          </div>
          <p class="hint">{{ t('import.hostOnly') }}</p>
          <label for="import-room">{{ t('import.room') }}</label>
          <select
            id="import-room"
            v-model="selectedRoom"
            :disabled="locked || !rooms.length"
          >
            <option value="">{{ t('import.chooseRoom') }}</option>
            <option
              v-for="room in rooms"
              :key="room.roomId"
              :value="room.roomId"
            >
              {{ room.title }}
            </option>
          </select>
          <p v-if="listing || loadingRoom" class="hint" role="status">
            {{ t('import.loadingRooms') }}
          </p>
          <p v-else-if="!rooms.length && !listError" class="hint">
            {{ t(nextCursor ? 'import.noHostedPage' : 'import.noRooms') }}
          </p>
          <p v-if="snapshot" class="import-current">
            {{ t('import.currentVideo') }}
            <strong>{{ mediaText(snapshot.media) }}</strong>
          </p>
          <p v-if="listError || roomError" class="notice error" role="alert">
            {{ translate(listError || roomError) }}
          </p>
          <button
            v-if="nextCursor"
            class="quiet"
            :disabled="locked || listing"
            @click="list(true)"
          >
            {{ t('import.moreRooms') }}
          </button>
          <p class="hint">{{ t('import.paused') }}</p>
          <button
            :disabled="
              locked || listing || !snapshot || loadingRoom || !!outcome
            "
            @click="confirm"
          >
            {{ t('import.replaceVideo') }}
          </button>
          <button
            v-if="outcome?.status === 'failed'"
            class="quiet"
            :disabled="locked"
            @click="loadRoom"
          >
            {{ t('import.refreshRoom') }}
          </button>
        </section>
      </div>
    </template>

    <Modal
      v-if="confirmation && pending"
      :title="t('import.confirmTitle', { room: pending.snapshot.title })"
      @close="confirmation = false"
    >
      <p>
        {{
          t('import.confirmVideo', {
            video: previewTitle || mediaText(pending.media),
          })
        }}
      </p>
      <p class="hint">{{ t('import.paused') }}</p>
      <div class="import-confirm-actions">
        <button :disabled="working || disabled" @click="submitReplacement">
          {{ working ? t('import.replacing') : t('import.replaceVideo') }}
        </button>
        <button class="quiet" :disabled="working" @click="confirmation = false">
          {{ t('common.cancel') }}
        </button>
      </div>
    </Modal>
  </section>
</template>

<style scoped>
.import-panel {
  width: min(calc(100% - 40px), 980px);
  margin: 42px auto;
  display: grid;
  gap: 24px;
}
.import-heading h1 {
  font-size: clamp(1.6rem, 3vw, 2rem);
  margin: 8px 0 12px;
}
.import-heading .eyebrow {
  color: var(--muted);
  font-size: 0.72rem;
  letter-spacing: 0.1em;
}
.import-heading .hint {
  max-width: 64ch;
}
.import-panel h2 {
  font-size: 1rem;
}
.import-panel .card-heading {
  margin-bottom: 16px;
}
.import-destinations {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px;
  align-items: start;
}
.import-destinations .create-card {
  min-width: 0;
}
.import-destinations .hint,
.import-current {
  margin: 12px 0 16px;
}
.import-media {
  display: flex;
  align-items: center;
  gap: 10px;
  overflow-wrap: anywhere;
}
.import-media > span {
  display: grid;
  gap: 6px;
}
.import-current strong {
  display: block;
  margin-top: 6px;
  overflow-wrap: anywhere;
}
.import-confirm-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 24px;
}
.import-recovery button {
  max-width: 100%;
}
.import-panel .notice {
  overflow-wrap: anywhere;
}
@media (max-width: 700px) {
  .import-panel {
    margin: 24px auto;
    gap: 20px;
  }
  .import-destinations {
    grid-template-columns: minmax(0, 1fr);
  }
  .import-panel .create-card {
    padding: 20px;
  }
  .import-panel .create-submit {
    margin-top: 20px;
  }
}
</style>
