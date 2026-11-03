<script setup lang="ts">
import { nextTick, onUnmounted, ref, watch } from 'vue';

import Icon from '../../components/Icon.vue';
import {
  errorMessage,
  LocalizedError,
  message,
  t,
  translate,
  type Message,
} from '../../i18n';
import { LocalAdapter } from '../../player/adapters/local';
import { HelperBridge } from '../../player/bilibili/bridge';
import {
  decodePreview,
  parseSelection,
  selectionInput,
} from '../../player/bilibili/media';
import { localFingerprint } from '../../player/fingerprint';
import { decodeMedia, type MediaDescriptor } from '../../transport/contracts';

const props = defineProps<{
  disabled?: boolean;
  roomId: string;
  bilibiliOnly?: boolean;
}>();
const source = ref<'bilibili' | 'local'>('bilibili');
const url = ref(''),
  part = ref(1),
  parts = ref(1),
  summary = ref(''),
  localSummary = ref<Message | ''>(''),
  error = ref<Message | ''>(''),
  working = ref(false);
const fileName = ref('');
let file: File | undefined,
  prepared: MediaDescriptor | undefined,
  bridge: HelperBridge | undefined;
let controller = new AbortController();
function invalidate(): void {
  controller.abort();
  controller = new AbortController();
  bridge?.close(2, false);
  bridge = undefined;
  prepared = undefined;
  summary.value = '';
  localSummary.value = '';
  error.value = '';
  working.value = false;
}
watch(() => props.roomId, invalidate);
function switchSource(value: 'local' | 'bilibili'): void {
  if (working.value || props.disabled) return;
  invalidate();
  source.value = value;
}
function choose(selected?: File): void {
  if (!selected || props.disabled || working.value) return;
  invalidate();
  file = selected;
  fileName.value = selected.name;
}
function fileInput(event: Event): void {
  choose((event.target as HTMLInputElement).files?.[0]);
}
function drop(event: DragEvent): void {
  event.preventDefault();
  choose(event.dataTransfer?.files[0]);
}
async function prepare(): Promise<
  { media: MediaDescriptor; file?: File; title?: string } | undefined
> {
  if (working.value) return;
  if (prepared)
    return {
      media: prepared,
      ...(summary.value ? { title: summary.value } : {}),
      ...(source.value === 'local' && file ? { file } : {}),
    };
  working.value = true;
  error.value = '';
  const signal = controller.signal;
  let local: LocalAdapter | undefined;
  let inspection: HelperBridge | undefined;
  try {
    let media: MediaDescriptor;
    if (source.value === 'local') {
      if (!file || !file.size)
        throw new LocalizedError(message('media.selectFirst'));
      const video = document.createElement('video');
      video.preload = 'auto';
      video.muted = true;
      local = new LocalAdapter(video);
      const [digest] = await Promise.all([
        localFingerprint(file, props.roomId, signal),
        local.load(file, signal),
      ]);
      media = decodeMedia({
        kind: 'local',
        fingerprintVersion: 1,
        digest,
        sizeBytes: file.size,
        durationMs: local.getState().durationMs,
      });
      summary.value = '';
      localSummary.value = message('media.summary', {
        name: fileName.value,
        seconds: Math.round(media.durationMs / 1000),
      });
    } else {
      const selected = parseSelection(url.value, part.value);
      inspection = new HelperBridge();
      bridge = inspection;
      await inspection.hello(true);
      const info = decodePreview(
        await inspection.call('preview', selected),
        selected,
      );
      if (signal.aborted) return;
      url.value = selectionInput(info);
      part.value = info.part;
      parts.value = info.parts;
      summary.value = info.title;
      media = {
        kind: 'bilibili',
        bvid: info.bvid,
        ...(info.episodeId ? { episodeId: info.episodeId } : {}),
        cid: info.cid,
        part: info.part,
        durationMs: Math.round(info.duration * 1000),
      };
    }
    if (signal.aborted) return;
    prepared = media;
    return {
      media,
      ...(summary.value ? { title: summary.value } : {}),
      ...(source.value === 'local' && file ? { file } : {}),
    };
  } catch (reason) {
    if (!signal.aborted)
      error.value = errorMessage(reason, 'media.prepareFailed');
  } finally {
    local?.dispose();
    inspection?.close(2, false);
    if (bridge === inspection) bridge = undefined;
    if (!signal.aborted) working.value = false;
  }
}
onUnmounted(() => {
  controller.abort();
  bridge?.close(2, false);
  file = undefined;
});
async function selectBilibili(
  selection?: ReturnType<typeof parseSelection>,
): Promise<void> {
  if (props.disabled || working.value) return;
  switchSource('bilibili');
  if (selection) {
    url.value = selectionInput(selection);
    part.value = selection.part;
    parts.value = 0;
  }
  await nextTick();
  document.getElementById('bilibili-url')?.focus();
}
async function selectLocal(): Promise<void> {
  if (props.disabled || working.value) return;
  switchSource('local');
  await nextTick();
  document.getElementById('create-local-video')?.focus();
}
defineExpose({ prepare, selectBilibili, selectLocal });
</script>
<template>
  <div class="media-picker">
    <div
      v-if="!bilibiliOnly"
      class="source-tabs"
      role="group"
      :aria-label="t('media.source')"
    >
      <button
        type="button"
        :aria-pressed="source === 'bilibili'"
        :disabled="disabled || working"
        @click="switchSource('bilibili')"
      >
        <Icon name="screen" />{{ t('media.bilibili') }}
      </button>
      <button
        type="button"
        :aria-pressed="source === 'local'"
        :disabled="disabled || working"
        @click="switchSource('local')"
      >
        <Icon name="file" />{{ t('common.localFile') }}
      </button>
    </div>
    <template v-if="source === 'bilibili'">
      <label for="bilibili-url">{{ t('media.url') }}</label>
      <div class="input-action">
        <input
          id="bilibili-url"
          v-model="url"
          :readonly="disabled || working"
          maxlength="2048"
          autocomplete="off"
          :placeholder="t('media.urlPlaceholder')"
          @input="invalidate"
        /><button
          type="button"
          class="quiet"
          :disabled="disabled || working || !url.trim()"
          @click="prepare"
        >
          {{ working ? t('media.checking') : t('media.preview') }}
        </button>
      </div>
      <div v-if="parts > 1 || part > 1" class="part-row">
        <label for="bilibili-part">{{ t('media.part') }}</label
        ><input
          id="bilibili-part"
          v-model.number="part"
          type="number"
          autocomplete="off"
          min="1"
          :max="parts || 10000"
          :readonly="disabled || working"
          @input="invalidate"
        /><span v-if="parts" class="hint">{{
          t('media.partTotal', { count: parts })
        }}</span>
      </div>
    </template>
    <div v-else class="file-drop" @dragover.prevent @drop="drop">
      <Icon name="file" :size="30" /><strong>{{
        fileName || t('media.bringVideo')
      }}</strong
      ><span class="hint">{{ t('media.fileHint') }}</span>
      <label class="file-button" for="create-local-video">{{
        fileName ? t('common.chooseAnother') : t('media.chooseFile')
      }}</label>
      <input
        id="create-local-video"
        class="visually-hidden"
        type="file"
        accept="video/*,.mkv"
        :disabled="disabled || working"
        @change="fileInput"
      />
      <span class="hint">{{ t('media.drop') }}</span>
    </div>
    <p v-if="summary || localSummary" class="media-preview">
      <Icon name="check" />{{ translate(localSummary) || summary }}
    </p>
    <p v-if="error" role="alert" class="notice error">{{ translate(error) }}</p>
    <p v-if="working" role="status" class="hint">
      {{ t('common.preparingVideo') }}
    </p>
  </div>
</template>
