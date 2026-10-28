<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { Snapshot } from '../../transport/api';
import type { MediaDescriptor } from '../../transport/contracts';
import type { Readiness, ReadinessStatus } from '../../transport/protocol-values';
import { RoomSocket, type Command } from '../../transport/room-socket';
import { LocalAdapter } from '../../player/adapters/local';
import { localFingerprint } from '../../player/fingerprint';
import { SyncController } from '../../sync/controller';

const props = defineProps<{ room: Snapshot }>();
const emit = defineEmits<{ snapshot: [snapshot: Snapshot] }>();
const video = ref<HTMLVideoElement>(),
  status = ref('Connecting…'),
  error = ref(''),
  mediaStatus = ref<ReadinessStatus>('no_media'),
  calibration = ref('Calibrating clocks…');
const active = ref(false),
  connected = ref(false),
  loading = ref(false),
  uncertain = ref<Command>(),
  label = ref(''),
  seekSeconds = ref(0),
  muted = ref(true),
  volume = ref(1);
const current = ref(props.room);
const host = computed(() => current.value.selfMemberId === current.value.hostMemberId);
const controls = computed(
  () =>
    connected.value &&
    active.value &&
    (host.value || current.value.settings.controllers === 'everyone') &&
    !uncertain.value,
);
let adapter: LocalAdapter | undefined, descriptor: MediaDescriptor | undefined;
let selection = new AbortController(),
  selectionGeneration = 0;
let timer: ReturnType<typeof setInterval> | undefined, subscription: (() => void) | undefined;
let lastReport = '',
  lastReportAt = 0,
  disposed = false;
const sync = new SyncController();
const transport = new RoomSocket(props.room.roomId, {
  snapshot(snapshot) {
    current.value = snapshot;
    emit('snapshot', snapshot);
    void sample();
  },
  status(value) {
    status.value = value;
    connected.value = transport.connected;
    if (!transport.connected) {
      sync.invalidate();
      void adapter?.pause();
    }
  },
  lease(value) {
    active.value = value;
    if (!value) clearMedia();
  },
  error(value) {
    error.value = value;
  },
  uncertain(value) {
    uncertain.value = value;
  },
});
function clearMedia(): void {
  selection.abort();
  selection = new AbortController();
  selectionGeneration++;
  subscription?.();
  adapter?.dispose();
  adapter = undefined;
  descriptor = undefined;
  sync.invalidate();
  mediaStatus.value = 'no_media';
  lastReport = '';
  loading.value = false;
}
function matches(): boolean {
  const selected = current.value.media,
    local = descriptor;
  return (
    !!selected &&
    !!local &&
    selected.kind === 'local' &&
    local.kind === 'local' &&
    selected.digest === local.digest &&
    selected.sizeBytes === local.sizeBytes &&
    Math.abs(selected.durationMs - local.durationMs) <= 250
  );
}
async function choose(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = '';
  if (!file || !video.value) return;
  clearMedia();
  const generation = selectionGeneration,
    signal = selection.signal;
  loading.value = true;
  error.value = '';
  mediaStatus.value = 'loading';
  const local = new LocalAdapter(video.value);
  adapter = local;
  void sample();
  try {
    const [digest] = await Promise.all([
      localFingerprint(file, props.room.roomId, signal),
      local.load(file, signal),
    ]);
    if (signal.aborted || generation !== selectionGeneration) return;
    descriptor = {
      kind: 'local',
      fingerprintVersion: 1,
      digest,
      sizeBytes: file.size,
      durationMs: local.getState().durationMs,
    };
    subscription = local.subscribe(() => {
      void sample();
    });
    sync.invalidate();
    if (host.value) {
      const media = { ...descriptor, ...(label.value ? { label: label.value } : {}) };
      transport.command({ media });
    }
    await sample();
  } catch (reason) {
    if (!signal.aborted && generation === selectionGeneration) {
      error.value = reason instanceof Error ? reason.message : 'Local matching failed.';
      const failed = local.getState().status === 'unsupported' ? 'unsupported' : 'error';
      clearMedia();
      mediaStatus.value = failed;
      void sample();
    }
  } finally {
    if (generation === selectionGeneration) loading.value = false;
  }
}
async function sample(): Promise<void> {
  if (disposed) return;
  connected.value = transport.connected;
  const now = performance.now(),
    estimate = transport.clock.estimate(now);
  calibration.value = !estimate
    ? 'Calibrating clocks…'
    : estimate.uncertaintyMs > 250
      ? 'Degraded synchronization'
      : 'Clock calibrated';
  const local = adapter,
    snapshot = current.value;
  if (!local) {
    if (loading.value) mediaStatus.value = 'loading';
    else if (!['unsupported', 'error'].includes(mediaStatus.value)) mediaStatus.value = 'no_media';
    publish(
      {
        status: mediaStatus.value,
        mediaGeneration: snapshot.mediaGeneration,
        barrierId: snapshot.barrier?.barrierId ?? null,
        sampledAtClientMs: Math.round(performance.now()),
        positionMs: null,
        durationMs: null,
        capabilities: {
          canPlay: false,
          canPause: false,
          canSeek: false,
          canReadPosition: false,
          canSetPlaybackRate: false,
          canDetectBuffering: false,
          canShowDanmaku: false,
          positionResolutionMs: 1000,
        },
      },
      now,
    );
    return;
  }
  const matched = matches();
  if (!matched && descriptor) {
    mediaStatus.value = 'mismatch';
    sync.invalidate();
    await local.pause();
  } else {
    try {
      await sync.reconcile(
        local,
        snapshot,
        estimate,
        now,
        active.value && transport.connected && matched && document.visibilityState === 'visible',
      );
    } catch {
      if (adapter === local) {
        error.value =
          local.getState().status === 'gesture_required'
            ? 'Select Enable playback to allow this browser to play.'
            : 'The player could not apply room state. Select the file again.';
      }
    }
    if (adapter !== local || disposed) return;
    mediaStatus.value = local.getState().status;
  }
  if (adapter !== local || disposed) return;
  if (
    snapshot.epoch !== current.value.epoch ||
    snapshot.mediaGeneration !== current.value.mediaGeneration
  )
    return;
  const observation = local.getState();
  const readiness: ReadinessStatus =
    loading.value && !descriptor
      ? 'loading'
      : !matched
        ? 'mismatch'
        : !estimate || estimate.uncertaintyMs > 250
          ? 'loading'
          : observation.seeking
            ? 'loading'
            : mediaStatus.value;
  const report = {
    status: readiness,
    mediaGeneration: snapshot.mediaGeneration,
    barrierId: snapshot.barrier?.barrierId ?? null,
    sampledAtClientMs: Math.round(performance.now()),
    positionMs: matched ? observation.positionMs : null,
    durationMs: matched ? observation.durationMs : null,
    capabilities: local.capabilities,
  };
  publish(report, now);
}
function publish(report: Readiness, now: number): void {
  const key = JSON.stringify([report.status, report.mediaGeneration, report.barrierId]);
  if (key !== lastReport || now - lastReportAt >= 1000) {
    transport.readiness(report);
    lastReport = key;
    lastReportAt = now;
  }
}
function command(action: 'play' | 'pause' | 'replay' | 'seek'): void {
  error.value = '';
  sync.invalidate();
  transport.command(
    action === 'seek' ? { action, positionMs: Math.round(seekSeconds.value * 1000) } : { action },
  );
}
async function enable(): Promise<void> {
  const local = adapter,
    generation = selectionGeneration;
  if (!local) return;
  try {
    await local.play();
    if (adapter !== local || generation !== selectionGeneration) return;
    if (current.value.playback.phase !== 'playing') await local.pause();
    if (adapter !== local || generation !== selectionGeneration) return;
    error.value = '';
    await sample();
  } catch {
    if (adapter === local && generation === selectionGeneration)
      error.value = 'Playback needs permission or this browser cannot decode the file.';
  }
}
function visibility(): void {
  transport.resetClock();
  sync.invalidate();
  if (document.visibilityState !== 'visible') void adapter?.pause();
  else void sample();
}
onMounted(() => {
  transport.start();
  timer = setInterval(() => {
    void sample();
  }, 250);
  document.addEventListener('visibilitychange', visibility);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
  document.removeEventListener('visibilitychange', visibility);
  transport.dispose();
  clearMedia();
});
</script>

<template>
  <section class="player-panel" aria-labelledby="player-title">
    <h2 id="player-title">Watch local video</h2>
    <p role="status">{{ status }} · {{ calibration }}</p>
    <p v-if="error" role="alert" class="notice error">{{ error }}</p>
    <p v-if="!active" class="notice">
      Playback is inactive in this tab. <button @click="transport.activate()">Use this tab</button>
    </p>
    <p v-if="uncertain" class="notice">
      Checking the command result.
      <button :disabled="!connected" @click="transport.resolveUncertain()">
        Check original command
      </button>
    </p>
    <template v-if="host"
      ><label for="media-label">Shared media label (optional)</label
      ><input id="media-label" v-model="label" maxlength="120" :disabled="loading"
    /></template>
    <label for="local-video">{{
      host ? 'Select local video for the room' : 'Select matching local video'
    }}</label>
    <input
      id="local-video"
      type="file"
      accept="video/*,.mkv"
      :disabled="!active || !connected || !!uncertain"
      @change="choose"
    />
    <p class="hint">
      Each participant selects their own file. Only matching metadata is shared. File names and
      video bytes stay in your browser.
    </p>
    <p>
      Media:
      {{ current.media?.kind === 'local' ? current.media.label || 'Local video' : 'None selected' }}
      · <span data-testid="media-status">{{ loading ? 'loading' : mediaStatus }}</span> · Room:
      <span data-testid="playback-phase">{{ current.playback.phase }}</span>
    </p>
    <p v-if="mediaStatus === 'mismatch'" class="notice">
      This file does not match the room. Select the same file as the host.
    </p>
    <video
      ref="video"
      preload="auto"
      playsinline
      :muted="muted"
      :volume="volume"
      aria-label="Local room video"
    />
    <div class="form-row">
      <button
        :disabled="!controls || !current.media || !matches() || loading"
        @click="command('play')"
      >
        Play together
      </button>
      <button :disabled="!controls || !current.media" @click="command('pause')">
        Pause together
      </button>
      <button :disabled="!controls || !current.media" @click="command('replay')">Replay</button>
      <button v-if="mediaStatus === 'gesture_required'" @click="enable">Enable playback</button>
    </div>
    <form class="form-row" @submit.prevent="command('seek')">
      <label for="seek-seconds">Seek to seconds</label
      ><input
        id="seek-seconds"
        v-model.number="seekSeconds"
        type="number"
        min="0"
        :max="Math.floor((current.media?.durationMs ?? 0) / 1000)"
        step="0.1"
        required
        :disabled="!controls || !current.media"
      /><button :disabled="!controls || !current.media">Seek together</button>
    </form>
    <div class="form-row">
      <label class="checkbox"><input v-model="muted" type="checkbox" /> Mute locally</label
      ><label for="local-volume">Local volume</label
      ><input id="local-volume" v-model.number="volume" type="range" min="0" max="1" step="0.05" />
    </div>
    <p class="hint">
      Reloading requires file selection again. Sampled matching detects accidental differences.
      Browser and codec support varies. Full waiting and recovery policies are still in development.
    </p>
  </section>
</template>
