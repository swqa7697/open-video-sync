<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
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
import type { MediaInfo } from '../../player/bilibili/media';
import Icon from '../../components/Icon.vue';
import Modal from '../../components/Modal.vue';
import MediaPicker from '../media/MediaPicker.vue';
import { LocalAdapter, type PlayerAdapter } from '../../player/adapters/local';
import { localFingerprint } from '../../player/fingerprint';
import { reportedReadiness, SyncController } from '../../sync/controller';
import { nextSyncQuality, type SyncQualityState } from '../../sync/clock';
import { phaseText, readinessText } from '../status-text';

const props = defineProps<{
  room: Snapshot;
  initialFile?: File | undefined;
  helperGeneration?: number;
}>();
const emit = defineEmits<{
  snapshot: [snapshot: Snapshot];
  connection: [connected: boolean];
  recheck: [];
  ended: [reason: EndReason];
}>();
const overlay = ref<HTMLElement>(),
  stage = ref<HTMLElement>();
const danmakuStatus = ref(''),
  showDanmaku = ref(true),
  density = ref(20),
  danmakuSize = ref(20);
let publishing = false;
const video = ref<HTMLVideoElement>(),
  heading = ref<HTMLElement>(),
  status = ref('Connecting…'),
  error = ref(''),
  errorReload = ref(false),
  roomError = ref(''),
  roomErrorReload = ref(false),
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
  seekSeconds = ref(0),
  muted = ref(true),
  volume = ref(1);
const position = ref(0),
  buffered = ref(0),
  dragging = ref(false),
  playerMenu = ref(false),
  replaceOpen = ref(false),
  hoveredTime = ref<number>(),
  idle = ref(false),
  controlsHovered = ref(false);
const mediaPicker = ref<InstanceType<typeof MediaPicker>>();
const streamInfo = shallowRef<MediaInfo>();
const videoTitle = ref('');
const totalSeconds = computed(() => (current.value.media?.durationMs ?? 0) / 1000);
const isPlaying = computed(() => current.value.playback.phase === 'playing');
let idleTimer: ReturnType<typeof setTimeout> | undefined;
function wake(): void {
  idle.value = false;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (
      !controlsHovered.value &&
      isPlaying.value &&
      !playerMenu.value &&
      !stage.value?.contains(document.activeElement)
    )
      idle.value = true;
  }, 2500);
}
const formatTime = (seconds: number): string => {
  const n = Math.max(0, Math.floor(seconds));
  return n >= 3600
    ? `${Math.floor(n / 3600)}:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
    : `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};
const qualityName = (value: number): string =>
  ({
    6: '240p',
    16: '360p',
    32: '480p',
    64: '720p',
    74: '720p 60',
    80: '1080p',
    112: '1080p+',
    116: '1080p 60',
    120: '4K',
    125: 'HDR',
    126: 'Dolby Vision',
    127: '8K',
  })[value] ?? `Quality ${value}`;
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
let autoAttempt = '';
let handoff = props.initialFile;
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
      if (snapshot.settings.controllers === 'host') hostNotice.value = false;
      const previousHost = current.value.members.find((m) => m.role === 'host');
      if (
        current.value.settings.controllers === 'host' &&
        snapshot.settings.controllers === 'everyone' &&
        previousHost &&
        snapshot.members.find((m) => m.memberId === previousHost.memberId)?.presence !== 'connected'
      )
        hostNotice.value = true;
      current.value = snapshot;
      emit('snapshot', snapshot);
      void autoLoad();
      void sample();
    },
    status(value) {
      status.value = value;
      connected.value = transport.connected;
      if (!transport.connected) {
        sync.invalidate();
        void adapter?.pause();
      }
      if (transport.connected) void autoLoad();
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
      roomError.value = value;
      roomErrorReload.value = !!options?.reload;
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
  streamInfo.value = undefined;
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
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stage.value?.requestFullscreen();
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
async function chooseBilibili(
  selected: Extract<MediaDescriptor, { kind: 'bilibili' }>,
  publishMedia = false,
  quality?: number,
): Promise<void> {
  if (
    !video.value ||
    !overlay.value ||
    !active.value ||
    !connected.value ||
    loading.value ||
    uncertain.value
  )
    return;
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
    const media = await local.load(selected.bvid, selected.part, signal, quality);
    streamInfo.value = local.mediaInfo;
    videoTitle.value = local.mediaInfo?.title ?? selected.bvid;
    if (signal.aborted || generation !== selectionGeneration) return;
    descriptor.value = media;
    subscription = local.subscribe(() => {
      void sample();
    });
    if (publishMedia && host.value) {
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
function chooseFile(): void {
  document.getElementById('local-video')?.click();
}
async function choose(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = '';
  if (file) await loadLocal(file);
}
async function loadLocal(
  file: File,
  prepared?: MediaDescriptor,
  publishMedia = false,
): Promise<void> {
  if (!video.value || uncertain.value || !connected.value) return;
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
      prepared?.kind === 'local'
        ? Promise.resolve(prepared.digest)
        : localFingerprint(file, props.room.roomId, signal),
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
    if (publishMedia && host.value) {
      const media = descriptor.value;
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
const hostNotice = ref(false);
async function autoLoad(): Promise<void> {
  if (
    disposed ||
    !active.value ||
    !transport.connected ||
    !video.value ||
    !overlay.value ||
    loading.value ||
    descriptor.value
  )
    return;
  const selected = current.value.media;
  if (!selected) return;
  const key = `${current.value.epoch}:${current.value.mediaGeneration}:${props.helperGeneration ?? 0}`;
  if (autoAttempt === key) return;
  autoAttempt = key;
  if (selected.kind === 'bilibili') await chooseBilibili(selected);
  else if (handoff) {
    const file = handoff;
    handoff = undefined;
    await loadLocal(file, selected);
  }
}
watch(
  () => props.helperGeneration,
  () => {
    if (current.value.media?.kind === 'bilibili' && !matched.value) {
      autoAttempt = '';
      void autoLoad();
    }
  },
);
async function retryMedia(): Promise<void> {
  autoAttempt = '';
  clearMedia();
  await autoLoad();
}
async function replaceMedia(): Promise<void> {
  const selected = await mediaPicker.value?.prepare();
  if (!selected) return;
  replaceOpen.value = false;
  if (selected.media.kind === 'local' && selected.file)
    await loadLocal(selected.file, selected.media, true);
  else if (selected.media.kind === 'bilibili') await chooseBilibili(selected.media, true);
}
async function changeQuality(event: Event): Promise<void> {
  const selected = current.value.media;
  const quality = Number((event.target as HTMLSelectElement).value);
  if (
    selected?.kind !== 'bilibili' ||
    !streamInfo.value?.qualities.includes(quality) ||
    loading.value
  )
    return;
  await chooseBilibili(selected, false, quality);
}
function hoverSeek(event: PointerEvent): void {
  const box = event.currentTarget as HTMLElement;
  hoveredTime.value = Math.max(
    0,
    Math.min(
      totalSeconds.value,
      ((event.clientX - box.getBoundingClientRect().left) / box.clientWidth) * totalSeconds.value,
    ),
  );
}
function dragSeek(event: Event): void {
  dragging.value = true;
  seekSeconds.value = Number((event.target as HTMLInputElement).value);
}
function seek(event: Event): void {
  seekSeconds.value = Number((event.target as HTMLInputElement).value);
  dragging.value = false;
  command('seek');
}
function keyboard(event: KeyboardEvent): void {
  if (event.target !== stage.value || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === ' ' || event.key === 'k') {
    event.preventDefault();
    command(isPlaying.value ? 'pause' : 'play');
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    seekSeconds.value = Math.min(
      totalSeconds.value,
      Math.max(0, position.value + (event.key === 'ArrowLeft' ? -5 : 5)),
    );
    command('seek');
  } else if (event.key === 'm') muted.value = !muted.value;
  else if (event.key === 'f') {
    event.preventDefault();
    void fullscreen();
  }
  wake();
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
  if (video.value && local) {
    position.value = video.value.currentTime;
    const ranges = video.value.buffered;
    buffered.value = ranges.length ? ranges.end(ranges.length - 1) : 0;
  }
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
    } catch (reason) {
      // Gesture denial has its own persistent notice with the Enable playback action. An
      // interrupted play is not a failure; a later sample applies room state again.
      if (
        adapter === local &&
        !(reason instanceof DOMException && reason.name === 'AbortError') &&
        local.getState().status !== 'gesture_required'
      )
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
  roomError.value = '';
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
  } catch (reason) {
    if (adapter !== local || generation !== selectionGeneration) return;
    if (reason instanceof DOMException && reason.name === 'AbortError') {
      // An interrupted play is not a failure. If the notice stays, the participant can select
      // it again; otherwise its button is gone, so keep keyboard focus in the player.
      if (local.getState().status !== 'gesture_required') heading.value?.focus();
      return;
    }
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
  clearTimeout(idleTimer);
  handoff = undefined;
  document.removeEventListener('visibilitychange', visibility);
  transport.dispose();
  clearMedia();
});
</script>

<template>
  <section class="player-panel" aria-labelledby="player-title">
    <h3 id="player-title" ref="heading" class="visually-hidden" tabindex="-1">Watch together</h3>
    <div
      ref="stage"
      class="video-stage"
      :class="{ 'controls-idle': idle && isPlaying && !playerMenu }"
      tabindex="0"
      aria-label="Video player. Space to play or pause, arrows to seek, M to mute, F for fullscreen."
      @keydown="keyboard"
      @pointermove="wake"
      @pointerdown="wake"
      @focusin="wake"
      @pointerleave="wake"
    >
      <video
        ref="video"
        preload="auto"
        playsinline
        :muted="muted"
        :volume="volume"
        aria-label="Room video"
      />
      <div ref="overlay" class="danmaku-overlay" aria-hidden="true" />
      <div v-if="replaced" class="player-state">
        <Icon name="screen" :size="36" />
        <h3>Playback moved to another page</h3>
        <p>This room is open elsewhere. Playback continues in the newer page.</p>
        <button @click="reload">Use this page</button>
      </div>
      <div v-else-if="error && !loading" class="player-state" role="alert">
        <Icon name="screen" :size="32" />
        <p>{{ error }}</p>
        <button v-if="errorReload" @click="reload">Reload page</button
        ><button v-else-if="current.media?.kind === 'bilibili'" @click="retryMedia">
          Retry video</button
        ><button v-else type="button" class="file-button" @click="chooseFile">
          Choose another file
        </button>
      </div>
      <div v-else-if="mediaStatus === 'gesture_required'" class="player-state">
        <Icon name="play" :size="36" />
        <h3>Join the moment</h3>
        <p>Your browser needs permission to play this video.</p>
        <button @click="enable">Enable playback</button>
      </div>
      <div
        v-else-if="!descriptor && !loading && current.media?.kind === 'local'"
        class="player-state"
      >
        <span class="state-symbol"><Icon name="file" :size="34" /></span>
        <h3>Your seat is ready</h3>
        <p>Select your copy of the room’s video to watch together.</p>
        <label class="file-button" for="local-video"
          ><Icon name="plus" />Choose matching video</label
        ><small>Your file stays on your device.</small>
      </div>
      <div v-else-if="mediaStatus === 'mismatch'" class="player-state">
        <h3>A different video</h3>
        <p>This video does not match the room. Choose the same file as the host.</p>
        <button type="button" class="file-button" @click="chooseFile">Choose matching video</button>
      </div>
      <div
        v-else-if="loading || (!descriptor && current.media?.kind === 'bilibili')"
        class="player-state"
      >
        <Icon name="screen" :size="36" />
        <h3>{{ loading ? 'Preparing your video…' : 'Connect your playback helper' }}</h3>
        <p>
          {{
            loading
              ? 'Getting everything ready for you.'
              : 'Set up the OVS helper to load this video automatically.'
          }}
        </p>
        <button v-if="!loading" class="quiet" @click="retryMedia">Retry video</button>
      </div>
      <div v-else-if="current.playback.phase === 'ended'" class="player-state">
        <h3>One more time?</h3>
        <button :disabled="!canControl" @click="command('replay')">
          <Icon name="replay" />Replay
        </button>
      </div>
      <div
        v-if="current.barrier && descriptor && mediaStatus !== 'gesture_required'"
        class="waiting-overlay"
        role="status"
      >
        {{ waitingText }}
      </div>
      <input
        id="local-video"
        tabindex="-1"
        class="visually-hidden"
        type="file"
        accept="video/*,.mkv"
        :disabled="!active || !connected || !!uncertain"
        aria-label="Select matching local video"
        @change="choose"
      />
      <div
        class="player-controls"
        @pointerdown="wake"
        @pointerenter="
          controlsHovered = true;
          wake();
        "
        @pointerleave="
          controlsHovered = false;
          wake();
        "
      >
        <div class="seek-track" @pointermove="hoverSeek" @pointerleave="hoveredTime = undefined">
          <div
            class="buffered-track"
            :style="{ width: `${totalSeconds ? (buffered / totalSeconds) * 100 : 0}%` }"
          />
          <div
            class="played-track"
            :style="{
              width: `${totalSeconds ? ((dragging ? seekSeconds : position) / totalSeconds) * 100 : 0}%`,
            }"
          />
          <input
            id="seek-seconds"
            :value="dragging ? seekSeconds : position"
            type="range"
            min="0"
            :max="totalSeconds || 1"
            step="0.1"
            aria-label="Seek"
            :aria-valuetext="`${formatTime(dragging ? seekSeconds : position)} of ${formatTime(totalSeconds)}`"
            :disabled="!canControl"
            @input="dragSeek"
            @change="seek"
          />
          <span v-if="hoveredTime !== undefined" class="seek-preview">{{
            formatTime(hoveredTime)
          }}</span>
        </div>
        <div class="control-bar">
          <div class="control-start">
            <button
              class="icon-button"
              :aria-label="
                isPlaying
                  ? 'Pause together'
                  : current.playback.phase === 'ended'
                    ? 'Replay'
                    : 'Play together'
              "
              :title="controlNote || (isPlaying ? 'Pause (Space)' : 'Play (Space)')"
              :disabled="isPlaying ? !canControl : !canPlay"
              :aria-describedby="controlNote ? 'control-note' : undefined"
              @click="
                command(
                  isPlaying ? 'pause' : current.playback.phase === 'ended' ? 'replay' : 'play',
                )
              "
            >
              <Icon
                :name="isPlaying ? 'pause' : current.playback.phase === 'ended' ? 'replay' : 'play'"
                :size="22"
              />
            </button>
            <button
              class="icon-button"
              :aria-label="muted ? 'Unmute locally' : 'Mute locally'"
              :aria-pressed="muted"
              @click="muted = !muted"
            >
              <Icon :name="muted || !volume ? 'mute' : 'volume'" />
            </button>
            <input
              id="local-volume"
              v-model.number="volume"
              class="volume-slider"
              type="range"
              min="0"
              max="1"
              step="0.05"
              aria-label="Local volume"
              :aria-valuetext="`${Math.round(volume * 100)}%${muted ? ' (muted)' : ''}`"
            />
            <span class="player-time"
              >{{ formatTime(dragging ? seekSeconds : position)
              }}<span>/ {{ formatTime(totalSeconds) }}</span></span
            >
          </div>
          <div class="control-end">
            <button
              v-if="current.media?.kind === 'bilibili'"
              class="icon-button danmaku-toggle"
              aria-label="Show danmaku locally"
              :aria-pressed="showDanmaku"
              @click="
                showDanmaku = !showDanmaku;
                danmakuPreferences();
              "
            >
              <Icon name="chat" />
            </button>
            <button
              v-if="current.media?.kind === 'bilibili'"
              class="quality-trigger quiet"
              :aria-expanded="playerMenu"
              @click="playerMenu = !playerMenu"
            >
              {{ streamInfo ? qualityName(streamInfo.quality) : 'Quality'
              }}<Icon name="chevron" :size="14" />
            </button>
            <button
              class="icon-button"
              aria-label="Player settings"
              :aria-expanded="playerMenu"
              @click="playerMenu = !playerMenu"
            >
              <Icon name="settings" />
            </button>
            <button class="icon-button" aria-label="Fullscreen locally" @click="fullscreen">
              <Icon name="fullscreen" />
            </button>
          </div>
        </div>
      </div>
      <div v-if="playerMenu" class="player-menu" @keydown.esc.stop="playerMenu = false">
        <div class="menu-heading">
          <strong>Playback preferences</strong
          ><button
            class="icon-button quiet"
            aria-label="Close player settings"
            @click="playerMenu = false"
          >
            <Icon name="close" :size="16" />
          </button>
        </div>
        <label for="menu-volume">Volume</label
        ><input
          id="menu-volume"
          v-model.number="volume"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :aria-valuetext="`${Math.round(volume * 100)}%`"
        />
        <template v-if="current.media?.kind === 'bilibili'">
          <label for="video-quality">Video quality</label
          ><select
            v-if="streamInfo"
            id="video-quality"
            :value="streamInfo.quality"
            :disabled="loading"
            @change="changeQuality"
          >
            <option v-for="q in streamInfo.qualities" :key="q" :value="q">
              {{ qualityName(q) }}
            </option>
          </select>
          <p v-else class="hint">Quality is available after the video loads.</p>
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
          <p class="hint" role="status">
            {{ showDanmaku ? danmakuStatus : `Hidden by you · ${danmakuStatus}` }}
          </p>
          <button class="quiet" @click="reloadDanmaku">Reload danmaku</button>
        </template>
      </div>
    </div>
    <div class="video-information">
      <div class="video-description">
        <span class="source-label">{{
          current.media?.kind === 'local' ? 'LOCAL FILE' : 'BILIBILI'
        }}</span>
        <h3
          :title="
            videoTitle ||
            (current.media?.kind === 'local'
              ? current.media.label || 'Watching together'
              : current.media?.bvid)
          "
        >
          {{
            videoTitle ||
            (current.media?.kind === 'local'
              ? current.media.label || 'Watching together'
              : current.media?.bvid)
          }}<span v-if="current.media?.kind === 'bilibili'" class="hint">
            · Part {{ current.media.part }}</span
          >
        </h3>
        <p v-if="controlNote" id="control-note" class="hint">{{ controlNote }}</p>
      </div>
      <button
        v-if="host"
        class="quiet change-media"
        :disabled="loading || !connected || !active || !!uncertain"
        @click="replaceOpen = true"
      >
        <Icon name="plus" :size="16" />Change video
      </button>
    </div>
    <div class="playback-status">
      <div role="status">
        <span class="status-dot" />{{ status }}<span class="separator">·</span>{{ calibration }}
      </div>
      <span class="media-status" data-testid="media-status" :data-state="shownStatus">{{
        readinessText[shownStatus]
      }}</span
      ><span data-testid="playback-phase" :data-state="current.playback.phase">{{
        phaseText[current.playback.phase]
      }}</span>
    </div>
    <div v-if="roomError" class="notice error" role="alert">
      <span>{{ roomError }}</span
      ><button v-if="roomErrorReload" class="quiet" @click="reload">Reload page</button>
    </div>
    <p v-if="hostNotice" class="notice" role="status">
      The host left. Everyone can now control playback.
    </p>
    <div v-if="uncertain" class="notice" role="status">
      <span>Checking the command result.</span
      ><button :disabled="!connected" @click="transport.resolveUncertain()">
        Check original command
      </button>
    </div>
    <p v-if="waitTimedOut" class="notice" role="status">
      Waiting timed out. The room stays paused.
      {{ permitted ? 'Select Play to try again.' : 'The host can retry playback.' }}
    </p>
    <Modal v-if="replaceOpen" title="Change the video" @close="replaceOpen = false"
      ><MediaPicker ref="mediaPicker" :room-id="current.roomId" :disabled="loading" />
      <p class="hint">Everyone will pause at the start of the new video.</p>
      <button :disabled="loading" @click="replaceMedia">Use this video</button></Modal
    >
  </section>
</template>
