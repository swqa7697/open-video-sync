<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId } from 'vue';

import Icon from '../../components/Icon.vue';
import { t } from '../../i18n';
import type { PlayerStatistics } from '../../player/statistics';
import { object, request } from '../../transport/api';

const props = defineProps<{
  read: () => Promise<PlayerStatistics | undefined>;
}>();
const emit = defineEmits<{ close: [] }>();
const titleId = useId();
const statistics = ref<PlayerStatistics>();
const samples = ref<number[]>([]);
const versions = ref<Record<string, string>>();
const copyText = ref('');
const copied = ref(false);
const fallback = ref<HTMLTextAreaElement>();
let disposed = false;
let reading = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
const downloadURLs = new Map<string, ReturnType<typeof setTimeout>>();
const lifetime = new AbortController();

// Export only the fields displayed by this panel. Provider objects and media locations
// must never enter a downloaded snapshot, even if an adapter returns extra properties.
function snapshot(value: PlayerStatistics): PlayerStatistics {
  return {
    ...(value.width !== undefined ? { width: value.width } : {}),
    ...(value.height !== undefined ? { height: value.height } : {}),
    ...(value.frameRate !== undefined
      ? {
          frameRate: value.frameRate,
          frameRateEstimated: value.frameRateEstimated === true,
        }
      : {}),
    ...(value.videoBitrate !== undefined
      ? { videoBitrate: value.videoBitrate }
      : {}),
    ...(value.audioBitrate !== undefined
      ? { audioBitrate: value.audioBitrate }
      : {}),
    ...(value.videoCodec ? { videoCodec: value.videoCodec } : {}),
    ...(value.audioCodec ? { audioCodec: value.audioCodec } : {}),
    ...(value.videoSegment
      ? {
          videoSegment: {
            current: value.videoSegment.current,
            total: value.videoSegment.total,
          },
        }
      : {}),
    ...(value.audioSegment
      ? {
          audioSegment: {
            current: value.audioSegment.current,
            total: value.audioSegment.total,
          },
        }
      : {}),
    bufferAheadSeconds: value.bufferAheadSeconds,
    ...(value.downloadBytesPerSecond !== undefined
      ? { downloadBytesPerSecond: value.downloadBytesPerSecond }
      : {}),
  };
}
async function sample(): Promise<void> {
  clearTimeout(timer);
  if (disposed || reading || document.visibilityState !== 'visible') return;
  reading = true;
  try {
    const value = await props.read();
    if (disposed || document.visibilityState !== 'visible') return;
    statistics.value = value ? snapshot(value) : undefined;
    if (value?.downloadBytesPerSecond !== undefined)
      samples.value = [
        ...samples.value.slice(-29),
        value.downloadBytesPerSecond,
      ];
  } catch {
    // Optional statistics must never affect playback, readiness, or room state.
    if (!disposed) statistics.value = undefined;
  } finally {
    reading = false;
    if (!disposed && document.visibilityState === 'visible')
      timer = setTimeout(() => void sample(), 1000);
  }
}
function visibility(): void {
  clearTimeout(timer);
  if (document.visibilityState === 'visible') void sample();
}
async function loadVersions(): Promise<void> {
  const timeout = setTimeout(() => lifetime.abort(), 5000);
  try {
    const value = object(
      await request('/version', 'GET', '', undefined, lifetime.signal),
    );
    const result: Record<string, string> = {};
    for (const name of ['sync', 'web', 'helper']) {
      const version = value[name];
      if (
        typeof version !== 'string' ||
        version.length > 64 ||
        !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)
      )
        return;
      result[name] = version;
    }
    if (!disposed) versions.value = result;
  } catch {
    // A version lookup failure does not hide available playback statistics.
  } finally {
    clearTimeout(timeout);
  }
}
const exported = computed(() =>
  JSON.stringify(
    {
      ...(versions.value ? { versions: versions.value } : {}),
      statistics: statistics.value,
    },
    null,
    2,
  ),
);
async function copy(): Promise<void> {
  try {
    if (!navigator.clipboard) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(exported.value);
    if (disposed) return;
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    if (disposed) return;
    copyText.value = exported.value;
    await nextTick();
    fallback.value?.focus({ preventScroll: true });
    fallback.value?.select();
  }
}
function download(): void {
  const url = URL.createObjectURL(
    new Blob([exported.value], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ovs-video-statistics.json';
  link.click();
  downloadURLs.set(
    url,
    setTimeout(() => {
      URL.revokeObjectURL(url);
      downloadURLs.delete(url);
    }, 1000),
  );
}
const graph = computed(() => {
  const maximum = Math.max(1, ...samples.value);
  return samples.value
    .map(
      (value, index) => `${(index / 29) * 280},${36 - (value / maximum) * 32}`,
    )
    .join(' ');
});
function bitrate(value: number): string {
  return `${Math.round(value / 1000)} Kbps`;
}
function network(value: number): string {
  return value >= 1024 * 1024
    ? `${(value / (1024 * 1024)).toFixed(2)} MiB/s`
    : `${(value / 1024).toFixed(1)} KiB/s`;
}
function keyboard(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    emit('close');
  }
}
onMounted(() => {
  void sample();
  void loadVersions();
  document.addEventListener('visibilitychange', visibility);
});
onUnmounted(() => {
  disposed = true;
  clearTimeout(timer);
  clearTimeout(copiedTimer);
  lifetime.abort();
  document.removeEventListener('visibilitychange', visibility);
  for (const [url, release] of downloadURLs) {
    clearTimeout(release);
    URL.revokeObjectURL(url);
  }
  downloadURLs.clear();
});
</script>

<template>
  <section
    class="player-statistics"
    role="region"
    :aria-labelledby="titleId"
    @click.stop
    @pointerdown.stop
    @pointermove.stop
    @focusin.stop
    @keydown.stop="keyboard"
    @keyup.stop
    @keypress.stop
  >
    <header>
      <strong :id="titleId">{{ t('player.statistics') }}</strong>
      <button
        type="button"
        class="icon-button quiet"
        :aria-label="t('player.closeStatistics')"
        @click="emit('close')"
      >
        <Icon name="close" :size="17" />
      </button>
    </header>
    <dl v-if="statistics">
      <div v-if="statistics.width && statistics.height">
        <dt>{{ t('player.statResolution') }}</dt>
        <dd>{{ statistics.width }} × {{ statistics.height }}</dd>
      </div>
      <div v-if="statistics.frameRate !== undefined">
        <dt>{{ t('player.statFrameRate') }}</dt>
        <dd>
          {{ statistics.frameRate.toFixed(2) }} fps<span
            v-if="statistics.frameRateEstimated"
          >
            · {{ t('player.estimated') }}</span
          >
        </dd>
      </div>
      <div v-if="statistics.videoBitrate !== undefined">
        <dt>{{ t('player.statVideoBitrate') }}</dt>
        <dd>
          {{ bitrate(statistics.videoBitrate)
          }}<span v-if="statistics.videoCodec">
            · {{ statistics.videoCodec }}</span
          >
        </dd>
      </div>
      <div v-if="statistics.audioBitrate !== undefined">
        <dt>{{ t('player.statAudioBitrate') }}</dt>
        <dd>
          {{ bitrate(statistics.audioBitrate)
          }}<span v-if="statistics.audioCodec">
            · {{ statistics.audioCodec }}</span
          >
        </dd>
      </div>
      <div v-if="statistics.videoSegment">
        <dt>{{ t('player.statVideoSegments') }}</dt>
        <dd>
          {{ statistics.videoSegment.current }} /
          {{ statistics.videoSegment.total }}
        </dd>
      </div>
      <div v-if="statistics.audioSegment">
        <dt>{{ t('player.statAudioSegments') }}</dt>
        <dd>
          {{ statistics.audioSegment.current }} /
          {{ statistics.audioSegment.total }}
        </dd>
      </div>
      <div>
        <dt>{{ t('player.statBuffer') }}</dt>
        <dd>{{ statistics.bufferAheadSeconds.toFixed(1) }} s</dd>
      </div>
      <div v-if="statistics.downloadBytesPerSecond !== undefined">
        <dt>{{ t('player.statNetwork') }}</dt>
        <dd>{{ network(statistics.downloadBytesPerSecond) }}</dd>
      </div>
    </dl>
    <p v-else class="statistics-note">
      {{ t('player.statisticsUnavailable') }}
    </p>
    <svg
      v-if="
        statistics?.downloadBytesPerSecond !== undefined && samples.length > 1
      "
      class="network-graph"
      viewBox="0 0 280 40"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path d="M0 38H280" stroke="currentColor" opacity="0.2" />
      <polyline
        :points="graph"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        vector-effect="non-scaling-stroke"
      />
    </svg>
    <div class="statistics-footer">
      <p v-if="versions" class="statistics-versions">
        OVS · sync {{ versions.sync }} · web {{ versions.web }} · helper
        {{ versions.helper }}
      </p>
      <div class="statistics-actions">
        <button
          type="button"
          class="quiet"
          :disabled="!statistics"
          @click="copy"
        >
          {{ t(copied ? 'player.statisticsCopied' : 'player.copyStatistics') }}
        </button>
        <button
          type="button"
          class="quiet"
          :disabled="!statistics"
          @click="download"
        >
          {{ t('player.downloadStatistics') }}
        </button>
      </div>
      <label v-if="copyText" class="statistics-fallback"
        >{{ t('player.copyStatisticsManually')
        }}<textarea
          ref="fallback"
          readonly
          :value="copyText"
          :aria-label="t('player.statisticsSnapshot')"
        />
      </label>
    </div>
  </section>
</template>

<style scoped>
.player-statistics {
  position: absolute;
  z-index: 7;
  top: 12px;
  left: 12px;
  width: min(400px, calc(100% - 24px));
  max-height: calc(100% - 24px);
  overflow: auto;
  overscroll-behavior: contain;
  border: 1px solid #ffffff26;
  border-radius: 10px;
  padding: 0 14px 12px;
  background: #10141ae8;
  color: #f0f2f5;
  font-size: 0.76rem;
  line-height: 1.5;
}
header {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 45px;
  background: #10141af5;
}
header strong {
  font-size: 0.86rem;
  font-weight: 600;
}
header button {
  flex-shrink: 0;
  width: 28px;
  min-height: 28px;
  padding: 4px;
  color: inherit;
}
dl {
  margin: 1px 0 8px;
}
dl > div {
  display: grid;
  grid-template-columns: minmax(90px, 0.9fr) minmax(0, 1.3fr);
  gap: 12px;
  padding: 3px 0;
}
dt {
  color: #b5becb;
}
dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}
.network-graph {
  display: block;
  width: 100%;
  height: 40px;
  margin: 4px 0 10px;
  color: #97c3e8;
}
.statistics-versions,
.statistics-note {
  color: #b5becb;
  font-size: 0.65rem;
  overflow-wrap: anywhere;
  margin: 8px 0;
}
.statistics-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.statistics-actions button {
  border-color: #ffffff26;
  min-height: 30px;
  padding: 4px 9px;
  color: inherit;
  background: #ffffff0d;
  font: inherit;
  font-size: 0.7rem;
}
.statistics-actions button:hover,
header button:hover {
  background: #ffffff1a;
}
.statistics-fallback {
  display: block;
  margin-top: 10px;
  font-size: 0.7rem;
  color: #b5becb;
}
.statistics-fallback textarea {
  display: block;
  width: 100%;
  min-height: 90px;
  margin-top: 6px;
  background: #080b10;
  border: 1px solid #ffffff26;
  color: #f0f2f5;
  font-size: 0.68rem;
}
</style>
