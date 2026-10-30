<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef } from 'vue';
import { APIError, request, type Snapshot } from '../../transport/api';
import type { MediaDescriptor } from '../../transport/contracts';
import type { Readiness, ReadinessStatus } from '../../transport/protocol-values';
import {
  RoomSocket,
  type Command,
  type EndReason,
  type ProbeResult,
} from '../../transport/room-socket';
import { BilibiliAdapter } from '../../player/bilibili/adapter';
import { HelperError } from '../../player/bilibili/bridge';
import { parseSelection } from '../../player/bilibili/media';
import { LocalAdapter, type PlayerAdapter } from '../../player/adapters/local';
import { localFingerprint } from '../../player/fingerprint';
import { reportedReadiness, SyncController } from '../../sync/controller';
import { nextSyncQuality, type SyncQualityState } from '../../sync/clock';
import { memberState, phaseText, readinessText } from '../status-text';

const props = defineProps<{ room: Snapshot }>();
const emit = defineEmits<{
  snapshot: [snapshot: Snapshot];
  connection: [connected: boolean];
  recheck: [];
  ended: [reason: EndReason];
}>();
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
  heading = ref<HTMLElement>(),
  status = ref('Connecting…'),
  error = ref(''),
  errorReload = ref(false),
  invalidBilibili = ref(false),
  mediaStatus = ref<ReadinessStatus>('no_media'),
  calibration = ref('Calibrating clocks…');
// Sampled every 250 ms; only a changed label re-renders the panel.
let quality: SyncQualityState = { quality: 'calibrating', degradedSince: undefined };
const qualityText = {
  calibrating: 'Calibrating clocks…',
  calibrated: 'Clock calibrated',
  degraded: 'Synchronization may drift (unstable network timing)',
};
const active = ref(false),
  connected = ref(false),
  loading = ref(false),
  uncertain = ref<Command>(),
  label = ref(''),
  seekSeconds = ref(0),
  muted = ref(true),
  volume = ref(1);
const waitTimedOut = ref(false),
  replaced = ref(false);
const current = ref(props.room);
// Rendered state must be reactive; the adapter itself stays outside reactivity.
const descriptor = shallowRef<MediaDescriptor>();
const host = computed(() => current.value.selfMemberId === current.value.hostMemberId);
const permitted = computed(() => host.value || current.value.settings.controllers === 'everyone');
const controls = computed(
  () => connected.value && active.value && permitted.value && !uncertain.value,
);
const matched = computed(() => mediaMatches(current.value.media, descriptor.value));
// One reason, in priority order, explains why room controls are unavailable.
const controlNote = computed(() => {
  if (replaced.value) return 'This page no longer controls playback.';
  if (!connected.value || !active.value)
    return 'Reconnecting. Room controls return when the connection is restored.';
  if (uncertain.value) return 'Checking the previous command before accepting another.';
  if (!permitted.value)
    return 'Only the host can play, pause, or seek in this room. Volume, mute, and fullscreen stay local.';
  if (!current.value.media)
    return host.value
      ? 'Select a video for the room to enable playback controls.'
      : 'Waiting for the host to select a video.';
  return '';
});
const canPlay = computed(
  () => controls.value && !!current.value.media && matched.value && !loading.value,
);
const canControl = computed(() => controls.value && !!current.value.media);
const shownStatus = computed<ReadinessStatus>(() =>
  loading.value ? 'loading' : mediaStatus.value,
);
const blockers = computed(() => {
  const room = current.value,
    barrier = room.barrier;
  if (!barrier) return [];
  return barrier.requiredMemberIds.flatMap((id) => {
    const member = room.members.find((m) => m.memberId === id);
    if (!member) return [];
    const r = member.readiness;
    const ready =
      member.presence === 'connected' &&
      r?.status === 'ready' &&
      r.mediaGeneration === room.mediaGeneration &&
      r.barrierId === barrier.barrierId;
    return ready ? [] : [member];
  });
});
const waitingText = computed(() => {
  const barrier = current.value.barrier;
  if (!barrier) return '';
  const at = `${(barrier.targetPositionMs / 1000).toFixed(1)} seconds`;
  const names = blockers.value.map((m) =>
    m.memberId === current.value.selfMemberId ? 'you' : m.displayName,
  );
  if (!names.length) return `Waiting at ${at} for readiness to settle.`;
  const shown = names.slice(0, 5),
    more = names.length - shown.length;
  const list =
    more > 0
      ? `${shown.join(', ')}, and ${more} more`
      : shown.length > 1
        ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
        : shown[0];
  return `Waiting at ${at} for ${list}.`;
});
let adapter: PlayerAdapter | undefined;
let lastConnected: boolean | undefined;
let selection = new AbortController(),
  selectionGeneration = 0;
let timer: ReturnType<typeof setInterval> | undefined, subscription: (() => void) | undefined;
let lastReport = '',
  lastReportAt = 0,
  disposed = false;
let probedBarrier = '',
  probingBarrier = '';
const sync = new SyncController();
async function probe(signal: AbortSignal): Promise<ProbeResult> {
  try {
    await request(`/rooms/${props.room.roomId}`, 'GET', '', undefined, signal);
    return 'reachable';
  } catch (reason) {
    if (reason instanceof APIError && reason.code === 'session_required') return 'session_ended';
    if (reason instanceof APIError && reason.code === 'not_found') return 'room_unavailable';
    return 'unreachable';
  }
}
const transport = new RoomSocket(
  props.room.roomId,
  {
    snapshot(snapshot) {
      if (snapshot.epoch !== current.value.epoch) {
        sync.invalidate();
        lastReport = '';
        probedBarrier = '';
        probingBarrier = '';
      }
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
      if (
        snapshot.mediaGeneration !== current.value.mediaGeneration ||
        snapshot.epoch !== current.value.epoch
      ) {
        const local = descriptor.value;
        if (
          !(local && (publishing || local.kind === 'local') && mediaMatches(snapshot.media, local))
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
      if (lastConnected !== transport.connected) {
        lastConnected = transport.connected;
        emit('connection', transport.connected);
      }
    },
    lease(value) {
      active.value = value;
      if (!value) clearMedia();
    },
    error(value, options) {
      error.value = value;
      errorReload.value = !!options?.reload;
      if (options?.recheck) emit('recheck');
    },
    uncertain(value) {
      uncertain.value = value;
    },
    ended(reason) {
      if (reason === 'replaced') replaced.value = true;
      else emit('ended', reason);
    },
  },
  probe,
);
function clearMedia(): void {
  selection.abort();
  selection = new AbortController();
  selectionGeneration++;
  subscription?.();
  adapter?.dispose();
  adapter = undefined;
  descriptor.value = undefined;
  sync.invalidate();
  mediaStatus.value = 'no_media';
  lastReport = '';
  probedBarrier = '';
  probingBarrier = '';
  loading.value = false;
  danmakuStatus.value = '';
  publishing = false;
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
function showError(value: string, reload = false): void {
  error.value = value;
  errorReload.value = reload;
}
async function chooseBilibili(): Promise<void> {
  if (
    !video.value ||
    !overlay.value ||
    !active.value ||
    !connected.value ||
    loading.value ||
    uncertain.value
  )
    return;
  let selected: { bvid: string; part: number };
  try {
    const room = current.value.media;
    selected =
      !host.value && room?.kind === 'bilibili'
        ? { bvid: room.bvid, part: room.part }
        : parseSelection(bilibiliURL.value, part.value);
  } catch (reason) {
    showError(reason instanceof Error ? reason.message : 'Invalid Bilibili selection.');
    invalidBilibili.value = true;
    await nextTick();
    document.getElementById('bilibili-url')?.focus();
    return;
  }
  invalidBilibili.value = false;
  clearMedia();
  const generation = selectionGeneration,
    signal = selection.signal;
  loading.value = true;
  showError('');
  mediaStatus.value = 'loading';
  const local = new BilibiliAdapter(
    video.value,
    overlay.value,
    (value) => {
      if (adapter === local) danmakuStatus.value = value;
    },
    (failure) => {
      if (adapter === local) showError(failure.message, failure.reload);
    },
  );
  adapter = local;
  danmakuPreferences();
  void sample();
  try {
    const media = await local.load(selected.bvid, selected.part, signal);
    if (signal.aborted || generation !== selectionGeneration) return;
    descriptor.value = media;
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
      const failure = reason instanceof HelperError ? reason : new HelperError('invalid-media');
      showError(failure.message, failure.reload);
      clearMedia();
      // Platform access failures reach other participants as access_denied readiness.
      mediaStatus.value = failure.status;
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
  if (!file || !video.value || uncertain.value || !connected.value) return;
  clearMedia();
  const generation = selectionGeneration,
    signal = selection.signal;
  loading.value = true;
  showError('');
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
    descriptor.value = {
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
      const media = { ...descriptor.value, ...(label.value ? { label: label.value } : {}) };
      publishing = true;
      transport.command({ media });
    }
    await sample();
  } catch (reason) {
    if (!signal.aborted && generation === selectionGeneration) {
      showError(reason instanceof Error ? reason.message : 'Local matching failed.');
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
  quality = nextSyncQuality(quality, estimate, now);
  calibration.value = qualityText[quality.quality];
  const local = adapter,
    snapshot = current.value;
  if (!local) {
    if (loading.value) mediaStatus.value = 'loading';
    else if (!['unsupported', 'error', 'access_denied'].includes(mediaStatus.value))
      mediaStatus.value = 'no_media';
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
  const matched = mediaMatches(snapshot.media, descriptor.value);
  if (!matched && descriptor.value) {
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
      // Gesture denial has its own persistent notice with the Enable playback action.
      if (adapter === local && local.getState().status !== 'gesture_required')
        showError('The player could not apply room state. Reload the media.');
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
  const readiness = reportedReadiness({
    pending: loading.value && !descriptor.value,
    matched,
    estimate,
    seeking: observation.seeking,
    status: mediaStatus.value,
  });
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
  if (key !== lastReport || (report.barrierId !== null && now - lastReportAt >= 1000)) {
    transport.readiness(report);
    lastReport = key;
    lastReportAt = now;
  }
}
function command(action: 'play' | 'pause' | 'replay' | 'seek'): void {
  if (!(action === 'play' ? canPlay.value : canControl.value)) return;
  showError('');
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
    showError('');
    await sample();
    // The button disappears with the notice; keep keyboard focus in the player.
    heading.value?.focus();
  } catch {
    if (adapter === local && generation === selectionGeneration)
      showError(
        local.getState().status === 'gesture_required'
          ? 'The browser still blocked playback. Select Enable playback again, or allow autoplay for this site.'
          : 'This browser cannot decode this video. Try another file or browser.',
      );
  }
}
function reload(): void {
  location.reload();
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
    <h3 id="player-title" ref="heading" tabindex="-1">Watch together</h3>
    <p role="status">{{ status }} · {{ calibration }}</p>
    <div v-if="error" role="alert" class="notice error">
      <p><strong>Error:</strong> {{ error }}</p>
      <button v-if="errorReload" type="button" @click="reload">Reload page</button>
    </div>
    <div class="player-notices" role="status">
      <p v-if="replaced" class="notice">
        This room is open elsewhere. Playback continues in the newer page. Reload this page to use
        it here instead.
      </p>
      <div v-if="uncertain" class="notice">
        <p>Checking the command result.</p>
        <button
          type="button"
          :aria-disabled="!connected || undefined"
          @click="connected && transport.resolveUncertain()"
        >
          Check original command
        </button>
      </div>
      <div v-if="mediaStatus === 'gesture_required'" class="notice">
        <p>This browser needs your permission before it plays the room video.</p>
        <button type="button" @click="enable">Enable playback</button>
      </div>
      <p v-if="mediaStatus === 'mismatch'" class="notice">
        This video does not match the room. Select the same file or Bilibili part as the host.
      </p>
      <p v-if="current.barrier" class="notice">
        {{ waitingText }}
        {{
          current.barrier.reason === 'buffering'
            ? 'Playback resumes after everyone stays ready for one second.'
            : 'Each participant selects matching media and enables playback when asked.'
        }}
      </p>
      <p v-if="waitTimedOut" class="notice">
        Waiting timed out. The room stays paused.
        {{
          permitted
            ? 'Select Play together to try again.'
            : 'The host can select Play together to try again.'
        }}
      </p>
    </div>
    <ul v-if="blockers.length" class="waiting-list" aria-label="Waiting for">
      <li v-for="member in blockers" :key="member.memberId">
        {{ member.memberId === current.selfMemberId ? 'You' : member.displayName }}:
        {{ memberState(member, current.mediaGeneration) }}
      </li>
    </ul>
    <p>
      Media:
      {{
        current.media?.kind === 'local'
          ? current.media.label || 'Local video'
          : current.media?.kind === 'bilibili'
            ? `${current.media.bvid} · part ${current.media.part}`
            : 'None selected'
      }}
      · Yours:
      <span data-testid="media-status" :data-state="shownStatus">{{
        readinessText[shownStatus]
      }}</span>
      · Room:
      <span data-testid="playback-phase" :data-state="current.playback.phase">{{
        phaseText[current.playback.phase]
      }}</span>
    </p>
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
        :aria-valuetext="`${density} comments`"
        @input="danmakuPreferences"
      />
      <label for="danmaku-size">Danmaku text size</label
      ><input
        id="danmaku-size"
        v-model.number="danmakuSize"
        type="range"
        min="16"
        max="32"
        :aria-valuetext="`${danmakuSize} pixels`"
        @input="danmakuPreferences"
      />
      <button type="button" @click="reloadDanmaku">Reload danmaku</button>
    </div>
    <p v-if="controlNote" id="control-note" class="hint">{{ controlNote }}</p>
    <div class="actions">
      <button
        type="button"
        :aria-disabled="!canPlay || undefined"
        :aria-describedby="controlNote ? 'control-note' : undefined"
        @click="command('play')"
      >
        Play together
      </button>
      <button
        type="button"
        :aria-disabled="!canControl || undefined"
        :aria-describedby="controlNote ? 'control-note' : undefined"
        @click="command('pause')"
      >
        Pause together
      </button>
      <button
        type="button"
        :aria-disabled="!canControl || undefined"
        :aria-describedby="controlNote ? 'control-note' : undefined"
        @click="command('replay')"
      >
        Replay
      </button>
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
        :readonly="!canControl"
      /><button
        :aria-disabled="!canControl || undefined"
        :aria-describedby="controlNote ? 'control-note' : undefined"
      >
        Seek together
      </button>
    </form>
    <div class="form-row">
      <button type="button" @click="fullscreen">Fullscreen locally</button>
      <label class="checkbox"
        ><input id="local-mute" v-model="muted" type="checkbox" /> Mute locally</label
      ><label for="local-volume">Local volume</label
      ><input
        id="local-volume"
        v-model.number="volume"
        type="range"
        min="0"
        max="1"
        step="0.05"
        :aria-valuetext="`${Math.round(volume * 100)}%${muted ? ' (muted)' : ''}`"
      />
    </div>
    <h4 class="media-choice">Choose media</h4>
    <template v-if="host"
      ><label for="media-label">Shared media label (optional)</label
      ><input id="media-label" v-model="label" maxlength="120" :readonly="loading"
    /></template>
    <form class="bilibili-selection" @submit.prevent="chooseBilibili">
      <template v-if="host">
        <label for="bilibili-url">Bilibili video URL or BV identifier</label>
        <input
          id="bilibili-url"
          v-model="bilibiliURL"
          maxlength="2048"
          placeholder="https://www.bilibili.com/video/BV…"
          :readonly="!active || !connected || loading || !!uncertain"
          :aria-invalid="invalidBilibili || undefined"
          @input="invalidBilibili = false"
        />
        <label for="bilibili-part">Bilibili part</label>
        <input
          id="bilibili-part"
          v-model.number="part"
          type="number"
          min="1"
          max="10000"
          required
          :readonly="!active || !connected || loading || !!uncertain"
        />
      </template>
      <button
        v-if="host || current.media?.kind === 'bilibili'"
        :aria-disabled="!active || !connected || loading || !!uncertain || undefined"
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
      :disabled="!active"
      :aria-disabled="!connected || !!uncertain || undefined"
      :aria-describedby="controlNote ? 'control-note' : undefined"
      @click="(event) => (!connected || uncertain) && event.preventDefault()"
      @change="choose"
    />
    <p class="hint">
      Each participant selects their own file. Only matching metadata is shared. File names and
      video bytes stay in your browser.
    </p>
    <p class="hint">
      After reloading, select your file or load the room’s Bilibili video again. Sampled file
      matching detects accidental differences. Browser and codec support varies. Controller
      permission still applies while the host is disconnected.
    </p>
  </section>
</template>
