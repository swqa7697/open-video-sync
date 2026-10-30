<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import { HelperBridge, HelperError } from '../../player/bilibili/bridge';
import { decodeInfo, parseSelection } from '../../player/bilibili/media';
import { LocalAdapter } from '../../player/adapters/local';
import { localFingerprint } from '../../player/fingerprint';
import { decodeMedia, type MediaDescriptor } from '../../transport/contracts';
import Icon from '../../components/Icon.vue';
const props = defineProps<{ disabled?: boolean; roomId: string }>();
const source = ref<'bilibili' | 'local'>('bilibili');
const url = ref(''),
  part = ref(1),
  parts = ref(1),
  summary = ref(''),
  error = ref(''),
  working = ref(false);
const fileName = ref('');
let file: File | undefined, prepared: MediaDescriptor | undefined, bridge: HelperBridge | undefined;
let controller = new AbortController();
function invalidate(): void {
  controller.abort();
  controller = new AbortController();
  bridge?.close(2);
  bridge = undefined;
  prepared = undefined;
  summary.value = '';
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
async function prepare(): Promise<{ media: MediaDescriptor; file?: File } | undefined> {
  if (working.value) return;
  if (prepared) return { media: prepared, ...(source.value === 'local' && file ? { file } : {}) };
  working.value = true;
  error.value = '';
  const signal = controller.signal;
  let local: LocalAdapter | undefined;
  try {
    let media: MediaDescriptor;
    if (source.value === 'local') {
      if (!file || !file.size) throw new Error('Select a supported video file first.');
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
      summary.value = `${fileName.value} · ${Math.round(media.durationMs / 1000)} seconds`;
    } else {
      const selected = parseSelection(url.value, part.value);
      bridge = new HelperBridge();
      await bridge.hello();
      const info = decodeInfo(
        await bridge.call('open', { ...selected, generation: 1 }),
        selected.bvid,
        selected.part,
      );
      if (signal.aborted) return;
      url.value = info.bvid;
      part.value = info.part;
      parts.value = info.parts;
      summary.value = info.title;
      media = {
        kind: 'bilibili',
        bvid: info.bvid,
        cid: info.cid,
        part: info.part,
        durationMs: Math.round(info.duration * 1000),
      };
    }
    if (signal.aborted) return;
    prepared = media;
    return { media, ...(source.value === 'local' && file ? { file } : {}) };
  } catch (reason) {
    if (!signal.aborted)
      error.value =
        reason instanceof HelperError || reason instanceof Error
          ? reason.message
          : 'This video could not be prepared.';
  } finally {
    local?.dispose();
    bridge?.close(2);
    bridge = undefined;
    if (!signal.aborted) working.value = false;
  }
}
onUnmounted(() => {
  controller.abort();
  bridge?.close(2);
  file = undefined;
});
defineExpose({ prepare });
</script>
<template>
  <div class="media-picker">
    <div class="source-tabs" role="group" aria-label="Video source">
      <button
        type="button"
        :aria-pressed="source === 'bilibili'"
        :disabled="disabled || working"
        @click="switchSource('bilibili')"
      >
        <Icon name="screen" />Bilibili
      </button>
      <button
        type="button"
        :aria-pressed="source === 'local'"
        :disabled="disabled || working"
        @click="switchSource('local')"
      >
        <Icon name="file" />Local file
      </button>
    </div>
    <template v-if="source === 'bilibili'">
      <label for="bilibili-url">Video URL or BV identifier</label>
      <div class="input-action">
        <input
          id="bilibili-url"
          v-model="url"
          :readonly="disabled || working"
          maxlength="2048"
          placeholder="Paste a Bilibili link or BV identifier"
          @input="invalidate"
        /><button
          type="button"
          class="quiet"
          :disabled="disabled || working || !url.trim()"
          @click="prepare"
        >
          {{ working ? 'Checking…' : 'Preview video' }}
        </button>
      </div>
      <div v-if="parts > 1" class="part-row">
        <label for="bilibili-part">Part</label
        ><input
          id="bilibili-part"
          v-model.number="part"
          type="number"
          min="1"
          :max="parts"
          :readonly="disabled || working"
          @input="invalidate"
        /><span class="hint">of {{ parts }}</span>
      </div>
    </template>
    <div v-else class="file-drop" @dragover.prevent @drop="drop">
      <Icon name="file" :size="30" /><strong>{{ fileName || 'Bring your own video' }}</strong
      ><span class="hint">Your file stays on your device. Everyone needs their own copy.</span>
      <label class="file-button" for="create-local-video">{{
        fileName ? 'Choose another file' : 'Choose a video file'
      }}</label>
      <input
        id="create-local-video"
        class="visually-hidden"
        type="file"
        accept="video/*,.mkv"
        :disabled="disabled || working"
        @change="fileInput"
      />
      <span class="hint">or drop a file here</span>
    </div>
    <p v-if="summary" class="media-preview"><Icon name="check" />{{ summary }}</p>
    <p v-if="error" role="alert" class="notice error">{{ error }}</p>
    <p v-if="working" role="status" class="hint">Preparing your video…</p>
  </div>
</template>
