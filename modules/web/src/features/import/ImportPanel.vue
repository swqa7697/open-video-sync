<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';

import FormFeedback from '../../components/FormFeedback.vue';
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
const destination = ref<'new' | 'existing'>('new');
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
  if (working.value) return t('import.replacing');
  if (!value) return '';
  const text = translate(value.message ?? message(`import.${value.status}`));
  return value.status === 'unavailable'
    ? `${text} ${t('import.takeoverHint')}`
    : text;
});
const mediaText = (media: MediaDescriptor | null | undefined): string =>
  !media
    ? t('import.noMedia')
    : media.kind === 'local'
      ? t('common.localFile')
      : media.episodeId
        ? `EP${media.episodeId}`
        : `${media.bvid} · ${t('import.part', { part: media.part })}`;
const roomFeedback = computed(() => {
  if (listError.value || roomError.value)
    return translate(listError.value || roomError.value);
  if (listing.value || loadingRoom.value) return t('import.loadingRooms');
  if (snapshot.value)
    return `${t('import.currentVideo')} ${mediaText(snapshot.value.media)}`;
  return !rooms.value.length
    ? t(nextCursor.value ? 'import.noHostedPage' : 'import.noRooms')
    : t('import.hostOnly');
});
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
    rooms.value = more ? [...rooms.value, ...value.rooms] : value.rooms;
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
    if (
      value.selfMemberId !== value.hostMemberId &&
      !value.settings.everyoneCanSelectMedia
    )
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
      <FormFeedback :text="t('import.hint')" :announce="false" />
    </div>
    <FormFeedback
      :text="initialImport.invalid ? t('import.invalid') : ''"
      tone="error"
    />
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
      <FormFeedback
        v-if="prepared"
        class="import-media"
        :text="
          previewTitle
            ? `${previewTitle} · ${mediaText(prepared)}`
            : mediaText(prepared)
        "
        :announce="false"
      />
      <FormFeedback v-else :text="translate(prepareError)" tone="error" />
      <button
        v-if="!prepared"
        class="create-submit"
        :disabled="locked"
        @click="preview"
      >
        {{ t('import.continue') }}<Icon name="arrow" />
      </button>
    </section>

    <div v-if="prepared" class="import-workspace">
      <h2 id="import-destination" tabindex="-1">
        {{ t('import.destination') }}
      </h2>
      <div
        v-if="outcome?.status !== 'accepted'"
        class="import-destination-switch"
        role="group"
        :aria-label="t('import.destination')"
      >
        <button
          type="button"
          :aria-pressed="destination === 'new'"
          :disabled="locked"
          aria-controls="import-new-room"
          @click="destination = 'new'"
        >
          {{ t('import.newRoom') }}
        </button>
        <button
          type="button"
          :aria-pressed="destination === 'existing'"
          :disabled="locked"
          aria-controls="import-existing-room"
          @click="destination = 'existing'"
        >
          {{ t('import.existingRoom') }}
        </button>
      </div>
      <div v-if="outcome?.status !== 'accepted'" class="import-destinations">
        <form
          id="import-new-room"
          class="create-card import-destination-card"
          :class="{ 'import-inactive': destination !== 'new' }"
          aria-labelledby="import-new-title"
          @submit.prevent="create"
          @keydown.enter="
            (event) => event.isComposing && event.preventDefault()
          "
        >
          <div class="card-heading">
            <h2 id="import-new-title">{{ t('import.newRoom') }}</h2>
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
          <div class="import-card-actions">
            <button type="submit" :disabled="locked">
              {{ t('app.createRoom') }}
            </button>
          </div>
        </form>

        <section
          id="import-existing-room"
          class="create-card import-destination-card"
          :class="{ 'import-inactive': destination !== 'existing' }"
          aria-labelledby="import-existing-title"
        >
          <div class="card-heading">
            <h2 id="import-existing-title">{{ t('import.existingRoom') }}</h2>
            <div class="import-list-actions">
              <button
                v-if="nextCursor"
                type="button"
                class="quiet icon-button"
                :aria-label="t('import.moreRooms')"
                :title="t('import.moreRooms')"
                :disabled="locked || listing"
                @click="list(true)"
              >
                <Icon name="plus" :size="16" />
              </button>
              <button
                type="button"
                class="quiet icon-button"
                :aria-label="t('import.refresh')"
                :title="t('import.refresh')"
                :disabled="locked || listing"
                @click="list()"
              >
                <Icon name="replay" :size="16" />
              </button>
            </div>
          </div>
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
          <FormFeedback
            id="import-result"
            :text="outcomeText || roomFeedback"
            :tone="
              !working && (outcome || listError || roomError) ? 'error' : 'hint'
            "
            :reserve="true"
            :class="{ 'import-current': snapshot && !outcome }"
            class="import-room-feedback"
            tabindex="-1"
          />
          <FormFeedback :text="t('import.paused')" :announce="false" />
          <div class="import-card-actions">
            <button
              v-if="outcome?.status === 'uncertain'"
              :disabled="working || disabled"
              @click="submitReplacement"
            >
              {{ t('import.retry') }}
            </button>
            <button
              v-else-if="outcome?.status === 'unavailable'"
              :disabled="locked"
              @click="open"
            >
              {{ t('import.openAndReplace') }}
            </button>
            <button
              v-else-if="
                outcome?.status === 'stale' || outcome?.status === 'failed'
              "
              :disabled="locked"
              @click="loadRoom"
            >
              {{ t('import.refreshRoom') }}
            </button>
            <button
              v-else
              :disabled="
                locked || listing || !snapshot || loadingRoom || !!outcome
              "
              @click="confirm"
            >
              {{ t('import.replaceVideo') }}
            </button>
          </div>
        </section>
      </div>
      <FormFeedback
        v-else
        id="import-result"
        :text="outcomeText"
        tone="success"
        tabindex="-1"
      />
    </div>

    <Modal
      v-if="confirmation && pending"
      :title="t('import.replaceVideo')"
      @close="confirmation = false"
    >
      <FormFeedback
        :text="t('import.confirmTitle', { room: pending.snapshot.title })"
        :announce="false"
      />
      <FormFeedback
        :text="
          t('import.confirmVideo', {
            video: previewTitle || mediaText(pending.media),
          })
        "
        :announce="false"
      />
      <p class="hint">{{ t('import.paused') }}</p>
      <div class="import-confirm-actions">
        <button
          :disabled="working || disabled"
          :aria-label="
            working ? t('import.replacing') : t('import.replaceVideo')
          "
          @click="submitReplacement"
        >
          <span class="stable-label">
            <span
              :data-inactive="working"
              :aria-hidden="working || undefined"
              >{{ t('import.replaceVideo') }}</span
            ><span
              :data-inactive="!working"
              :aria-hidden="!working || undefined"
              >{{ t('import.replacing') }}</span
            >
          </span>
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
  width: min(100%, 980px);
  height: 100%;
  min-width: 0;
  min-height: 0;
  margin-inline: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.import-heading,
.import-video {
  flex: none;
}
.import-heading h1 {
  font-size: clamp(1.1rem, 2vw, 1.5rem);
  margin: 2px 0 4px;
}
.import-heading .eyebrow {
  color: var(--muted);
  font-size: 0.65rem;
  letter-spacing: 0.1em;
}
.import-panel .form-feedback {
  margin: 0;
}
.import-panel h2 {
  font-size: 0.9rem;
}
.import-panel .create-card {
  min-width: 0;
  padding: 12px 14px;
}
.import-panel .card-heading {
  min-width: 0;
  min-height: 36px;
  margin: 0;
  gap: 8px;
}
.import-panel .card-heading h2 {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.import-video {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.import-video .card-heading > button {
  flex: none;
  min-height: 36px;
  padding: 6px 10px;
}
.import-video .create-submit {
  margin: 0;
}
.import-workspace {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.import-destination-switch {
  display: none;
}
.import-destinations {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  min-width: 0;
  min-height: 0;
}
.import-destination-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  min-height: 0;
}
.import-destination-card label {
  margin: 0;
}
.import-destination-card .hint {
  margin: 0;
  font-size: 0.75rem;
}
.import-card-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  margin-top: auto;
  padding-top: 4px;
}
.import-card-actions > button {
  min-width: 0;
  min-height: 44px;
  font-size: 0.8rem;
  padding: 8px;
}
.import-list-actions {
  display: flex;
  flex: none;
  gap: 2px;
}
.import-list-actions > button {
  width: 36px;
  min-height: 36px;
  padding: 6px;
}
.import-confirm-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  margin-top: 24px;
}
.import-confirm-actions > button {
  min-width: 0;
}
@media (max-width: 700px) {
  .import-panel {
    padding: 10px 12px;
    gap: 10px;
  }
  .import-heading .eyebrow {
    display: none;
  }
  .import-destination-switch {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    padding: 3px;
    gap: 3px;
    border: 1px solid var(--subtle-border);
    border-radius: 8px;
    background: var(--input);
    flex: none;
  }
  .import-destination-switch > button {
    min-width: 0;
    min-height: 44px;
    padding: 6px;
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
    font-size: 0.75rem;
    line-height: 1.3;
  }
  .import-destination-switch > button[aria-pressed='true'] {
    background: var(--surface-raised);
    color: var(--text);
    box-shadow: 0 1px 3px #0003;
  }
  .import-destinations {
    grid-template-columns: minmax(0, 1fr);
  }
  .import-destination-card.import-inactive {
    display: none;
  }
  .import-destination-card input,
  .import-destination-card select {
    font-size: 16px;
  }
}
</style>
