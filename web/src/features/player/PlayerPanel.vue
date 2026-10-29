<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { Snapshot } from '../../transport/api';
import type { MediaDescriptor } from '../../transport/contracts';
import type { Readiness, ReadinessStatus } from '../../transport/protocol-values';
import { RoomSocket, type Command } from '../../transport/room-socket';
import { BilibiliAdapter } from '../../player/bilibili/adapter';
import { parseSelection } from '../../player/bilibili/media';
import { LocalAdapter, type PlayerAdapter } from '../../player/adapters/local';
import { localFingerprint } from '../../player/fingerprint';
import { SyncController } from '../../sync/controller';

const props = defineProps<{ room: Snapshot }>();
const emit = defineEmits<{ snapshot: [snapshot: Snapshot] }>();
const overlay = ref<HTMLElement>(),
  stage = ref<HTMLElement>();
const bilibiliURL = ref(''),
  part = ref(1),
  danmakuStatus = ref(''),
  showDanmaku = ref(true),
  density = ref(20),
  danmakuSize = ref(20);
let publishing = false;
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
const waitTimedOut = ref(false);
const current = ref(props.room);
const host = computed(() => current.value.selfMemberId === current.value.hostMemberId);
const self = computed(() =>
  current.value.members.find((m) => m.memberId === current.value.selfMemberId),
);
const controls = computed(
  () =>
    connected.value &&
    active.value &&
    (host.value || current.value.settings.controllers === 'everyone') &&
    !uncertain.value,
);
let adapter: PlayerAdapter | undefined, descriptor: MediaDescriptor | undefined;
let selection = new AbortController(),
  selectionGeneration = 0;
let timer: ReturnType<typeof setInterval> | undefined, subscription: (() => void) | undefined;
let lastReport = '',
  lastReportAt = 0,
  disposed = false;
let probedBarrier = '',
  probingBarrier = '';
const sync = new SyncController();
const transport = new RoomSocket(props.room.roomId, {
  snapshot(snapshot) {
    const barrier = current.value.barrier;
    if (
      barrier &&
      snapshot.playback.phase === 'paused' &&
      snapshot.serverNowMs >= barrier.deadlineServerMs
    )
      waitTimedOut.value = true;
    if (
      snapshot.playback.desiredPlaying ||
      snapshot.mediaGeneration !== current.value.mediaGeneration
    )
      waitTimedOut.value = false;
    if (snapshot.mediaGeneration !== current.value.mediaGeneration) {
      if (
        !(
          descriptor &&
          (publishing || descriptor.kind === 'local') &&
          mediaMatches(snapshot.media, descriptor)
        )
      )
        clearMedia();
      publishing = false;
    }
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
  probedBarrier = '';
  probingBarrier = '';
  loading.value = false;
  danmakuStatus.value = '';
  publishing = false;
}
function matches(): boolean {
  return mediaMatches(current.value.media, descriptor);
}
function mediaMatches(
  selected: MediaDescriptor | null,
  local: MediaDescriptor | undefined,
): boolean {
  if (!selected || !local || Math.abs(selected.durationMs - local.durationMs) > 250) return false;
  if (selected.kind === 'local' && local.kind === 'local')
    return selected.digest === local.digest && selected.sizeBytes === local.sizeBytes;
  return (
    selected.kind === 'bilibili' &&
    local.kind === 'bilibili' &&
    selected.bvid === local.bvid &&
    selected.cid === local.cid &&
    selected.part === local.part
  );
}
function danmakuPreferences(): void {
  if (adapter instanceof BilibiliAdapter) {
    adapter.danmaku.visible = showDanmaku.value;
    adapter.danmaku.density = density.value;
    adapter.danmaku.fontSize = danmakuSize.value;
  }
}
async function fullscreen(): Promise<void> {
  try {
    await stage.value?.requestFullscreen();
  } catch {
    error.value = 'Fullscreen is unavailable in this browser.';
  }
}
function reloadDanmaku(): void {
  if (adapter instanceof BilibiliAdapter) adapter.reloadDanmaku();
}
async function chooseBilibili(): Promise<void> {
  if (!video.value || !overlay.value || !active.value || !connected.value) return;
  let selected: { bvid: string; part: number };
  try {
    const room = current.value.media;
    selected =
      !host.value && room?.kind === 'bilibili'
        ? { bvid: room.bvid, part: room.part }
        : parseSelection(bilibiliURL.value, part.value);
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : 'Invalid Bilibili selection.';
    return;
  }
  clearMedia();
  const generation = selectionGeneration,
    signal = selection.signal;
  loading.value = true;
  error.value = '';
  mediaStatus.value = 'loading';
  const local = new BilibiliAdapter(
    video.value,
    overlay.value,
    (value) => {
      if (adapter === local) danmakuStatus.value = value;
    },
    (value) => {
      if (adapter === local) error.value = value;
    },
  );
  adapter = local;
  danmakuPreferences();
  void sample();
  try {
    const media = await local.load(selected.bvid, selected.part, signal);
    if (signal.aborted || generation !== selectionGeneration) return;
    descriptor = media;
    subscription = local.subscribe(() => {
      void sample();
    });
    if (host.value) {
      publishing = true;
      transport.command({ media });
    }
    await sample();
  } catch (reason) {
    if (!signal.aborted && generation === selectionGeneration) {
      error.value = reason instanceof Error ? reason.message : 'Bilibili playback failed.';
      clearMedia();
      mediaStatus.value = 'error';
      void sample();
    }
  } finally {
    if (generation === selectionGeneration) loading.value = false;
  }
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
      publishing = true;
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
      const barrier = snapshot.barrier;
      if (
        matched &&
        active.value &&
        transport.connected &&
        barrier &&
        local.getState().status === 'ready' &&
        !local.getState().seeking &&
        probedBarrier !== barrier.barrierId
      ) {
        if (probingBarrier === barrier.barrierId) return;
        probingBarrier = barrier.barrierId;
        try {
          // A loaded file alone cannot establish browser autoplay permission.
          await local.play();
          await local.pause();
          if (adapter === local) probedBarrier = barrier.barrierId;
        } finally {
          if (probingBarrier === barrier.barrierId) probingBarrier = '';
        }
      }
    } catch {
      if (adapter === local) {
        error.value =
          local.getState().status === 'gesture_required'
            ? 'Select Enable playback to allow this browser to play.'
            : 'The player could not apply room state. Reload the media.';
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
  waitTimedOut.value = false;
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
      error.value = 'Playback needs permission or this browser cannot decode this video.';
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
    <h2 id="player-title">Watch together</h2>
    <p role="status">{{ status }} · {{ calibration }}</p>
    <p v-if="error" role="alert" class="notice error">{{ error }}</p>
    <p v-if="!active && !transport.roomClosed" class="notice">
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
    <form class="bilibili-selection" @submit.prevent="chooseBilibili">
      <template v-if="host">
        <label for="bilibili-url">Bilibili video URL or BV identifier</label>
        <input
          id="bilibili-url"
          v-model="bilibiliURL"
          maxlength="2048"
          placeholder="https://www.bilibili.com/video/BV…"
          :disabled="!active || !connected || loading || !!uncertain"
        />
        <label for="bilibili-part">Bilibili part</label>
        <input
          id="bilibili-part"
          v-model.number="part"
          type="number"
          min="1"
          max="10000"
          required
          :disabled="!active || !connected || loading || !!uncertain"
        />
      </template>
      <button
        v-if="host || current.media?.kind === 'bilibili'"
        :disabled="!active || !connected || loading || !!uncertain"
      >
        {{ host ? 'Select Bilibili video' : 'Load room Bilibili video' }}
      </button>
    </form>
    <p class="hint">
      Bilibili needs the
      <a href="/userscripts/ovs-bilibili.user.js" target="_blank" rel="noopener noreferrer"
        >OVS Bilibili helper 1.0.0</a
      >
      in Tampermonkey. Install or update from this instance, then reload. Each browser uses its own
      Bilibili access. Local files work without the helper.
    </p>
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
      {{
        current.media?.kind === 'local'
          ? current.media.label || 'Local video'
          : current.media?.kind === 'bilibili'
            ? `${current.media.bvid} · part ${current.media.part}`
            : 'None selected'
      }}
      · <span data-testid="media-status">{{ loading ? 'loading' : mediaStatus }}</span> · Room:
      <span data-testid="playback-phase">{{ current.playback.phase }}</span>
    </p>
    <p v-if="mediaStatus === 'mismatch'" class="notice">
      This media does not match the room. Select the same file or Bilibili part as the host.
    </p>
    <p v-if="current.barrier" class="notice" role="status">
      Waiting for participants at
      {{ (current.barrier.targetPositionMs / 1000).toFixed(1) }} seconds.
      {{
        current.barrier.reason === 'buffering'
          ? 'Playback resumes after everyone stays ready for one second.'
          : 'Select matching media and enable playback when requested.'
      }}
    </p>
    <p v-if="waitTimedOut" class="notice">
      Waiting timed out. The room stays paused. The host can retry Play together, exclude a
      participant, or change the waiting policy.
    </p>
    <p v-if="current.playback.phase === 'playing' && !self?.playbackEligible" class="notice">
      You are outside active playback. Select matching media. With Wait at next play, wait for the
      next explicit Play together command.
    </p>
    <ul aria-label="Playback readiness">
      <li v-for="member in current.members" :key="member.memberId">
        {{ member.displayName }}:
        {{
          !member.playbackActive
            ? 'inactive tab or disconnected'
            : member.readiness?.status === 'no_media' || !member.readiness
              ? 'select matching media'
              : member.readiness.status
        }}
        <span v-if="member.excludedFromWaiting"> · excluded from waiting for this media</span>
        <span
          v-if="
            member.readiness?.capabilities.canPlay &&
            !member.readiness.capabilities.canDetectBuffering &&
            current.settings.waitMode === 'all' &&
            current.settings.waitOnBuffering &&
            !member.excludedFromWaiting
          "
        >
          · buffering detection unavailable; the host must disable waiting on buffering or exclude
          this participant
        </span>
        <button
          v-if="host && member.role !== 'host' && current.media"
          class="quiet"
          :disabled="!controls"
          :aria-label="`${member.excludedFromWaiting ? 'Include' : 'Exclude'} ${member.displayName} ${member.excludedFromWaiting ? 'in' : 'from'} waiting`"
          @click="
            transport.command({ memberId: member.memberId, excluded: !member.excludedFromWaiting })
          "
        >
          {{ member.excludedFromWaiting ? 'Include in waiting' : 'Exclude from waiting' }}
        </button>
      </li>
    </ul>
    <div ref="stage" class="video-stage">
      <video
        ref="video"
        preload="auto"
        playsinline
        :muted="muted"
        :volume="volume"
        aria-label="Room video"
      />
      <div ref="overlay" class="danmaku-overlay" aria-hidden="true" />
    </div>
    <div v-if="descriptor?.kind === 'bilibili'" class="danmaku-controls">
      <p role="status">{{ showDanmaku ? danmakuStatus : `Danmaku hidden · ${danmakuStatus}` }}</p>
      <label class="checkbox"
        ><input v-model="showDanmaku" type="checkbox" @change="danmakuPreferences" /> Show danmaku
        locally</label
      >
      <label for="danmaku-density">Danmaku density</label
      ><input
        id="danmaku-density"
        v-model.number="density"
        type="range"
        min="1"
        max="40"
        @input="danmakuPreferences"
      />
      <label for="danmaku-size">Danmaku text size</label
      ><input
        id="danmaku-size"
        v-model.number="danmakuSize"
        type="range"
        min="16"
        max="32"
        @input="danmakuPreferences"
      />
      <button @click="reloadDanmaku">Reload danmaku</button>
    </div>
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
      <button @click="fullscreen">Fullscreen locally</button>
      <label class="checkbox"><input v-model="muted" type="checkbox" /> Mute locally</label
      ><label for="local-volume">Local volume</label
      ><input id="local-volume" v-model.number="volume" type="range" min="0" max="1" step="0.05" />
    </div>
    <p class="hint">
      After reloading, select your file or load the room’s Bilibili video again. Sampled file
      matching detects accidental differences. Browser and codec support varies. The host keeps
      ownership while disconnected and must resume after the 15-second grace.
    </p>
  </section>
</template>
