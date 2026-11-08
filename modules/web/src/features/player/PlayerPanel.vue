<script setup lang="ts">
import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  watch,
} from 'vue';

import { videoCodecRank } from '@ovs/helper/media-codecs';
import Icon from '../../components/Icon.vue';
import Modal from '../../components/Modal.vue';
import {
  dismissKeyboardOverlay,
  hasKeyboardOverlay,
} from '../../components/overlay-keyboard';
import {
  errorMessage,
  i18n,
  message,
  t,
  translate,
  type Message,
} from '../../i18n';
import { LocalAdapter, type PlayerAdapter } from '../../player/adapters/local';
import { BilibiliAdapter } from '../../player/bilibili/adapter';
import { HelperError } from '../../player/bilibili/bridge';
import {
  sameEpisode,
  type Episode,
  type MediaInfo,
  type Playlist,
} from '../../player/bilibili/media';
import { localFingerprint } from '../../player/fingerprint';
import {
  readPlayerPreferences,
  savePlayerPreferences,
} from '../../player/preferences';
import type { PlayerStatistics as StatisticsSnapshot } from '../../player/statistics';
import { nextSyncQuality, type SyncQualityState } from '../../sync/clock';
import {
  reportedReadiness,
  supportsPlaybackRate,
  SyncController,
} from '../../sync/controller';
import { APIError, request, type Snapshot } from '../../transport/api';
import { playbackRates, type MediaDescriptor } from '../../transport/contracts';
import type {
  Readiness,
  ReadinessStatus,
} from '../../transport/protocol-values';
import {
  RoomSocket,
  type Command,
  type EndReason,
  type ProbeResult,
} from '../../transport/room-socket';
import type {
  EpisodeActions,
  QuickCommand,
  VideoSelection,
} from '../commands/search';
import {
  ImportHandoff,
  type ImportRequest,
  type ImportResult,
} from '../import-handoff/handoff';
import MediaPicker from '../media/MediaPicker.vue';
import { phaseText, readinessText } from '../status-text';
import DanmakuControl from './DanmakuControl.vue';
import type { PlayerMenuItem } from './player-menu';
import PlayerChoiceMenu from './PlayerChoiceMenu.vue';
import PlayerContextMenu from './PlayerContextMenu.vue';
import PlayerShortcuts from './PlayerShortcuts.vue';
import PlayerStatistics from './PlayerStatistics.vue';

const props = defineProps<{
  room: Snapshot;
  initialFile?: File | undefined;
  helperGeneration?: number;
}>();
const emit = defineEmits<{
  snapshot: [snapshot: Snapshot];
  connection: [connected: boolean];
  episodeSelected: [];
  recheck: [];
  ended: [reason: EndReason];
}>();
const overlay = ref<HTMLElement>(),
  stage = ref<HTMLElement>();
type EscapeKeyboard = {
  lock(keys: string[]): Promise<void>;
  unlock(): void;
};
let escapeKeyboard: EscapeKeyboard | undefined;
let keyboardGeneration = 0;
let wasFullscreen = false;
let exitingFullscreen = false;
const windowFullscreen = ref(false);
const preferences = readPlayerPreferences();
const showDanmaku = ref(preferences.danmakuVisible),
  density = ref(preferences.danmakuDensity),
  danmakuSize = ref(preferences.danmakuSize),
  danmakuSpeed = ref(preferences.danmakuSpeed),
  danmakuArea = ref(preferences.danmakuArea);
let publishing = false;
const video = ref<HTMLVideoElement>(),
  heading = ref<HTMLElement>(),
  status = ref<Message>(message('player.connecting')),
  error = ref<Message | ''>(''),
  errorReload = ref(false),
  roomError = ref<Message | ''>(''),
  roomErrorReload = ref(false),
  mediaStatus = ref<ReadinessStatus>('no_media'),
  calibration = ref<Message>(message('player.calibrating'));
const videoAspectRatio = ref(16 / 9);
const details = ref<HTMLElement>(),
  detailsHeight = ref(0);
const layout = computed(() => ({
  aspectRatio: videoAspectRatio.value,
  detailsHeight: detailsHeight.value,
}));
let detailsObserver: ResizeObserver | undefined;
let detailsFrame: number | undefined;
function measureDetails(): void {
  detailsHeight.value = details.value?.getBoundingClientRect().height ?? 0;
}
function scheduleDetails(): void {
  if (detailsFrame !== undefined) return;
  detailsFrame = requestAnimationFrame(() => {
    detailsFrame = undefined;
    measureDetails();
  });
}
function updateVideoAspectRatio(): void {
  const element = video.value;
  if (element && element.videoWidth > 0 && element.videoHeight > 0)
    videoAspectRatio.value = element.videoWidth / element.videoHeight;
}
// Sampled every 250 ms; only a changed label re-renders the panel.
let quality: SyncQualityState = {
  quality: 'calibrating',
  degradedSince: undefined,
};
const qualityText = {
  calibrating: message('player.calibrating'),
  calibrated: message('player.calibrated'),
  degraded: message('player.degraded'),
};
const active = ref(false),
  connected = ref(false),
  loading = ref(false),
  pendingCommand = ref<Command>(),
  commandDelayed = ref(false),
  seekSeconds = ref(0),
  muted = ref(preferences.muted),
  volume = ref(preferences.volume);
const volumeFeedback = ref(false);
let volumeFeedbackTimer: ReturnType<typeof setTimeout> | undefined;
function showVolumeFeedback(): void {
  volumeFeedback.value = true;
  clearTimeout(volumeFeedbackTimer);
  volumeFeedbackTimer = setTimeout(() => {
    volumeFeedback.value = false;
  }, 1200);
}
const preferredQuality = ref(preferences.quality);
watch(
  [
    volume,
    muted,
    preferredQuality,
    showDanmaku,
    density,
    danmakuSize,
    danmakuSpeed,
    danmakuArea,
  ],
  () =>
    savePlayerPreferences({
      volume: volume.value,
      muted: muted.value,
      danmakuVisible: showDanmaku.value,
      danmakuDensity: density.value,
      danmakuSize: danmakuSize.value,
      danmakuSpeed: danmakuSpeed.value,
      danmakuArea: danmakuArea.value,
      ...(preferredQuality.value ? { quality: preferredQuality.value } : {}),
    }),
);
const position = ref(0),
  buffered = ref(0),
  dragging = ref(false),
  seekPointerDown = ref(false),
  danmakuMenu = ref(false),
  qualityMenu = ref(false),
  rateMenu = ref(false),
  replaceOpen = ref(false),
  hoveredTime = ref<number>(),
  seekPointerOffset = ref(0),
  seekTrackWidth = ref(0),
  idle = ref(false),
  controlsHovered = ref(false);
const mediaPicker = ref<InstanceType<typeof MediaPicker>>();
const contextPosition = ref<{ x: number; y: number }>();
const statisticsOpen = ref(false),
  shortcutsOpen = ref(false),
  statisticsVersion = ref(0);
let restoringOverlayFocus = false;
let suppressSurfaceClick = false;
function focusPlayerSilently(): void {
  restoringOverlayFocus = true;
  stage.value?.focus({ preventScroll: true });
  restoringOverlayFocus = false;
}
function closeContextMenu(restoreFocus = true): void {
  contextPosition.value = undefined;
  if (restoreFocus) focusPlayerSilently();
}
function showContextMenu(x: number, y: number): void {
  danmakuMenu.value = false;
  qualityMenu.value = false;
  rateMenu.value = false;
  shortcutsOpen.value = false;
  clearSeekPreview();
  suppressSurfaceClick = false;
  contextPosition.value = { x, y };
}
function contextMenu(event: MouseEvent): void {
  if (event.target !== video.value && event.target !== stage.value) return;
  const bounds = stage.value?.getBoundingClientRect();
  if (!bounds) return;
  event.preventDefault();
  showContextMenu(event.clientX - bounds.left, event.clientY - bounds.top);
}
function outsideContextMenu(event: PointerEvent): void {
  if (
    !contextPosition.value ||
    !(event.target instanceof Element) ||
    event.target.closest('.player-context-menu')
  )
    return;
  if (event.target === video.value || event.target === stage.value)
    suppressSurfaceClick = true;
  closeContextMenu(false);
}
function toggleStatistics(): void {
  statisticsOpen.value = !statisticsOpen.value;
  if (statisticsOpen.value) shortcutsOpen.value = false;
}
function closeStatistics(): void {
  statisticsOpen.value = false;
  focusPlayerSilently();
}
function openShortcuts(): void {
  shortcutsOpen.value = true;
}
function closeShortcuts(): void {
  shortcutsOpen.value = false;
  focusPlayerSilently();
}
async function readStatistics(): Promise<StatisticsSnapshot | undefined> {
  const local = adapter,
    generation = selectionGeneration;
  const value = await local?.getStatistics?.();
  return adapter === local && generation === selectionGeneration
    ? value
    : undefined;
}
const contextItems = computed<PlayerMenuItem[]>(() => {
  const media = current.value.media;
  return [
    ...(media?.kind === 'bilibili'
      ? [
          {
            id: 'original',
            label: t('player.openBilibili'),
            icon: 'arrow',
            href: media.episodeId
              ? `https://www.bilibili.com/bangumi/play/ep${media.episodeId}`
              : `https://www.bilibili.com/video/${media.bvid}?p=${media.part}`,
          },
          {
            id: 'danmaku',
            label: t(
              showDanmaku.value
                ? 'player.hideDanmakuMenu'
                : 'player.showDanmakuMenu',
            ),
            icon: showDanmaku.value ? 'chat' : 'chat-off',
            shortcut: 'D',
            separator: true,
          },
          {
            id: 'reload-danmaku',
            label: t('player.reloadDanmaku'),
            icon: 'replay',
            disabled: !streamInfo.value || loading.value,
          },
        ]
      : []),
    {
      id: 'shortcuts',
      label: t('player.keyboardHelp'),
      icon: 'screen',
      separator: media?.kind === 'bilibili',
    },
    {
      id: 'statistics',
      label: t(
        statisticsOpen.value ? 'player.closeStatistics' : 'player.statistics',
      ),
      icon: 'info',
    },
  ];
});
function selectContextItem(id: string): void {
  closeContextMenu();
  if (id === 'danmaku') toggleDanmaku();
  else if (id === 'reload-danmaku') reloadDanmaku();
  else if (id === 'statistics') toggleStatistics();
  else if (id === 'shortcuts') openShortcuts();
}
const streamInfo = shallowRef<MediaInfo>();
const previewCanvas = ref<HTMLCanvasElement>();
const thumbnailVisible = ref(false);
let thumbnailTimer: ReturnType<typeof setTimeout> | undefined;
let thumbnailRequest: AbortController | undefined;
let thumbnailVersion = 0;
let thumbnailRunning = false;
let thumbnailPending = false;

function clearSeekPreview(): void {
  hoveredTime.value = undefined;
  thumbnailVisible.value = false;
  thumbnailVersion++;
  thumbnailRequest?.abort();
  clearTimeout(thumbnailTimer);
  thumbnailTimer = undefined;
  thumbnailPending = false;
}
function queueThumbnail(): void {
  if (hoveredTime.value === undefined || !descriptor.value) return;
  thumbnailPending = true;
  if (!thumbnailTimer && !thumbnailRunning)
    thumbnailTimer = setTimeout(() => {
      thumbnailTimer = undefined;
      void renderThumbnail();
    }, 75);
}
async function renderThumbnail(): Promise<void> {
  if (thumbnailRunning || !thumbnailPending) return;
  thumbnailPending = false;
  const local = adapter,
    canvas = previewCanvas.value,
    seconds = hoveredTime.value;
  if (!local?.drawThumbnail || !canvas || seconds === undefined) return;
  thumbnailRunning = true;
  const version = thumbnailVersion,
    controller = new AbortController();
  thumbnailRequest = controller;
  try {
    const drawn = await local.drawThumbnail(
      seconds * 1000,
      canvas,
      controller.signal,
    );
    if (
      !controller.signal.aborted &&
      adapter === local &&
      version === thumbnailVersion
    )
      thumbnailVisible.value = drawn;
  } catch {
    // Optional previews do not change media readiness or interrupt room playback.
    if (!controller.signal.aborted && version === thumbnailVersion)
      thumbnailVisible.value = false;
  } finally {
    thumbnailRunning = false;
    if (thumbnailRequest === controller) thumbnailRequest = undefined;
    if (thumbnailPending) queueThumbnail();
  }
}
const videoCodec = computed(() => {
  if (current.value.media?.kind !== 'bilibili') return undefined;
  return ['AV1', 'HEVC', 'AVC'][
    videoCodecRank(streamInfo.value?.tracks[0]?.codec)
  ];
});
const playlist = shallowRef<Playlist>();
const videoTitle = ref('');
const totalSeconds = computed(
  () => (current.value.media?.durationMs ?? 0) / 1000,
);
const isPlaying = computed(() => current.value.playback.phase === 'playing');
const controlsPinned = computed(
  () =>
    controlsHovered.value ||
    danmakuMenu.value ||
    qualityMenu.value ||
    rateMenu.value ||
    dragging.value ||
    seekPointerDown.value,
);
let idleTimer: ReturnType<typeof setTimeout> | undefined,
  seekReleaseTimer: ReturnType<typeof setTimeout> | undefined;
let pointerOutside = false;
let windowFocusTarget: Element | null = null;
function rememberWindowFocus(): void {
  windowFocusTarget = document.activeElement;
}
function focusStage(event: FocusEvent): void {
  if (restoringOverlayFocus) return;
  // Restoring the browser window repeats focusin on its retained active element.
  const restored =
    event.relatedTarget === null && event.target === windowFocusTarget;
  windowFocusTarget = null;
  if (!restored) wake();
}
function hideControls(): void {
  clearTimeout(idleTimer);
  idle.value = !controlsPinned.value;
}
function wake(): void {
  idle.value = false;
  clearTimeout(idleTimer);
  if (isPlaying.value && !controlsPinned.value)
    idleTimer = setTimeout(hideControls, 3000);
}
function pointerActivity(event?: PointerEvent): void {
  if (event?.type === 'pointerdown' && event.button !== 0) return;
  windowFocusTarget = null;
  pointerOutside = false;
  wake();
}
function leaveStage(event: PointerEvent): void {
  if (event.pointerType === 'touch') return;
  pointerOutside = true;
  clearSeekPreview();
  controlsHovered.value = false;
  hideControls();
}
function hoverControls(event: PointerEvent, hovered: boolean): void {
  if (event.pointerType === 'touch') return;
  controlsHovered.value = hovered;
}
function startSeek(event: PointerEvent): void {
  if (!canControl.value) {
    event.preventDefault();
    return;
  }
  if (event.button !== 0) return;
  clearTimeout(seekReleaseTimer);
  seekPointerDown.value = true;
}
function endSeek(event?: PointerEvent): void {
  if (event && !seekPointerDown.value) return;
  clearTimeout(seekReleaseTimer);
  if (seekPointerDown.value && event && event.pointerType !== 'touch') {
    const bounds = stage.value?.getBoundingClientRect();
    // Native sliders can capture pointer events outside the stage until release.
    if (bounds?.width && bounds.height)
      pointerOutside =
        event.clientX < bounds.left ||
        event.clientX >= bounds.right ||
        event.clientY < bounds.top ||
        event.clientY >= bounds.bottom;
    if (pointerOutside) controlsHovered.value = false;
  }
  // Let the native range commit its change before Vue restores the displayed position.
  if (event?.type === 'pointerup')
    seekReleaseTimer = setTimeout(() => {
      seekPointerDown.value = false;
      dragging.value = false;
    }, 0);
  else {
    seekPointerDown.value = false;
    dragging.value = false;
  }
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
    126: t('player.dolby'),
    127: '8K',
  })[value] ?? t('player.qualityNumber', { value });
const waitTimedOut = ref(false),
  replaced = ref(false);
const current = ref(props.room);
const episodeSelection = shallowRef<{
  episode: Episode;
  phase: 'loading' | 'pending' | 'accepted' | 'failed';
  error?: Message;
}>();
let episodeCommandId: string | undefined;
watch([isPlaying, controlsPinned], () => {
  if (pointerOutside) hideControls();
  else if (!idle.value || controlsPinned.value) wake();
});
watch(
  () => current.value.media,
  (media) => {
    if (
      media?.kind !== 'bilibili' ||
      !playlist.value?.episodes.some((episode) => sameEpisode(media, episode))
    )
      playlist.value = undefined;
  },
);
// Rendered state must be reactive; the adapter itself stays outside reactivity.
const descriptor = shallowRef<MediaDescriptor>();
watch([hoveredTime, descriptor], queueThumbnail);
const host = computed(
  () => current.value.selfMemberId === current.value.hostMemberId,
);
const permitted = computed(
  () => host.value || current.value.settings.controllers === 'everyone',
);
let commandDelayTimer: ReturnType<typeof setTimeout> | undefined;
const commandRecovery = ref<HTMLButtonElement>();
// Pending commands remain unavailable through guards and aria-disabled. Avoid native
// disabling during that round trip so browsers keep the current control focused.
const controls = computed(
  () =>
    connected.value && active.value && permitted.value && !pendingCommand.value,
);
const matched = computed(() =>
  mediaMatches(current.value.media, descriptor.value),
);
// One reason, in priority order, explains why room controls are unavailable.
const controlNote = computed(() => {
  if (replaced.value) return t('player.controlReplaced');
  if (!connected.value || !active.value) return t('player.controlReconnecting');
  if (pendingCommand.value) return t('player.controlPending');
  if (!permitted.value) return t('player.controlHost');
  if (!current.value.media)
    return host.value ? t('player.controlSelect') : t('player.controlWait');
  return '';
});
const canPlay = computed(
  () =>
    controls.value && !!current.value.media && matched.value && !loading.value,
);
const canControl = computed(() => controls.value && !!current.value.media);
const canReplace = computed(
  () =>
    host.value &&
    !loading.value &&
    connected.value &&
    active.value &&
    !pendingCommand.value,
);
const shownStatus = computed<ReadinessStatus>(() =>
  loading.value ? 'loading' : mediaStatus.value,
);
const playbackIndicator = computed(() => {
  if (loading.value) return 'loading';
  if (
    !descriptor.value ||
    !matched.value ||
    current.value.playback.phase === 'ended'
  )
    return undefined;
  if (mediaStatus.value === 'loading' || mediaStatus.value === 'buffering')
    return mediaStatus.value;
  if (
    mediaStatus.value === 'ready' &&
    current.value.playback.phase === 'paused'
  )
    return 'paused';
  return undefined;
});
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
  const seconds = (barrier.targetPositionMs / 1000).toFixed(1);
  const names = blockers.value.map((m) =>
    m.memberId === current.value.selfMemberId
      ? t('common.youLower')
      : m.displayName,
  );
  if (!names.length) return t('player.waitSettling', { seconds });
  const shown = names.slice(0, 5),
    more = names.length - shown.length;
  const list = new Intl.ListFormat(i18n.global.locale.value, {
    type: 'conjunction',
  }).format(shown);
  return t('player.waitingFor', {
    seconds,
    names:
      more > 0 ? t('player.moreNames', { names: list, count: more }) : list,
  });
});
let adapter: PlayerAdapter | undefined;
let autoAttempt = '';
let handoff = props.initialFile;
let lastConnected: boolean | undefined;
let selection = new AbortController(),
  selectionGeneration = 0;
let timer: ReturnType<typeof setInterval> | undefined,
  subscription: (() => void) | undefined;
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
    if (reason instanceof APIError && reason.code === 'session_required')
      return 'session_ended';
    if (reason instanceof APIError && reason.code === 'not_found')
      return 'room_unavailable';
    return 'unreachable';
  }
}
const transport = new RoomSocket(
  props.room.roomId,
  {
    snapshot(snapshot) {
      const incoming = snapshot.media;
      const selectedEpisode = episodeSelection.value?.episode;
      if (
        snapshot.epoch !== current.value.epoch ||
        (snapshot.mediaGeneration !== current.value.mediaGeneration &&
          !(
            incoming?.kind === 'bilibili' &&
            selectedEpisode &&
            sameEpisode(incoming, selectedEpisode)
          ))
      ) {
        episodeSelection.value = undefined;
        episodeCommandId = undefined;
      }
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
        if (!(
          local &&
          (publishing || local.kind === 'local') &&
          mediaMatches(snapshot.media, local)
        ))
          clearMedia();
        publishing = false;
      }
      if (snapshot.settings.controllers === 'host') hostNotice.value = false;
      const previousHost = current.value.members.find((m) => m.role === 'host');
      if (
        current.value.settings.controllers === 'host' &&
        snapshot.settings.controllers === 'everyone' &&
        previousHost &&
        snapshot.members.find((m) => m.memberId === previousHost.memberId)
          ?.presence !== 'connected'
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
    pending(value) {
      clearTimeout(commandDelayTimer);
      if (!value && document.activeElement === commandRecovery.value)
        stage.value?.focus({ preventScroll: true });
      pendingCommand.value = value;
      const attempt = episodeSelection.value;
      if (value?.type === 'media.select' && attempt?.phase === 'loading') {
        episodeCommandId = value.commandId;
        episodeSelection.value = { ...attempt, phase: 'pending' };
      } else if (!value && episodeCommandId && attempt) {
        episodeCommandId = undefined;
        episodeSelection.value = {
          ...attempt,
          phase: 'failed',
          error: roomError.value || message('socket.stale'),
        };
      }
      commandDelayed.value = false;
      // Only the command round trip owns this timer. Media loading and readiness do not.
      if (value)
        commandDelayTimer = setTimeout(() => {
          commandDelayed.value = true;
        }, 3000);
    },
    result(command, accepted) {
      if (command.commandId === importedCommand?.requestId)
        finishImport({ status: accepted ? 'accepted' : 'rejected' });
      const attempt = episodeSelection.value;
      if (command.commandId !== episodeCommandId || !attempt) return;
      episodeCommandId = undefined;
      episodeSelection.value = {
        ...attempt,
        phase: accepted ? 'accepted' : 'failed',
        ...(!accepted
          ? { error: roomError.value || message('episodes.failed') }
          : {}),
      };
      if (accepted) emit('episodeSelected');
    },
    ended(reason) {
      if (reason === 'replaced') replaced.value = true;
      else emit('ended', reason);
    },
  },
  probe,
);
// Keep the original command after a timeout so a retry cannot select media twice.
let importedCommand:
  | {
      requestId: string;
      result?: ImportResult;
      waiting?: Promise<ImportResult>;
      resolve?: (result: ImportResult) => void;
      timer?: ReturnType<typeof setTimeout>;
    }
  | undefined;
function finishImport(result: ImportResult): void {
  const pending = importedCommand;
  if (!pending) return;
  if (result.status !== 'outcome_unknown') pending.result = result;
  clearTimeout(pending.timer);
  pending.resolve?.(result);
  delete pending.waiting;
  delete pending.resolve;
}
function importMedia(request: ImportRequest): Promise<ImportResult> {
  if (disposed) return Promise.resolve({ status: 'unavailable' });
  const previous = importedCommand?.requestId === request.requestId;
  if (previous && importedCommand?.result)
    return Promise.resolve(importedCommand.result);
  if (previous && importedCommand?.waiting) return importedCommand.waiting;
  if (!previous) {
    const s = current.value;
    if (!host.value || !transport.active || !transport.connected)
      return Promise.resolve({ status: 'unavailable' });
    if (pendingCommand.value) return Promise.resolve({ status: 'busy' });
    if (
      s.roomId !== request.target.roomId ||
      s.epoch !== request.target.epoch ||
      s.mediaGeneration !== request.target.mediaGeneration ||
      s.revision !== request.target.expectedRevision
    )
      return Promise.resolve({ status: 'stale' });
    importedCommand = { requestId: request.requestId };
  } else if (pendingCommand.value?.commandId !== request.requestId) {
    return Promise.resolve({
      status:
        current.value.epoch !== request.target.epoch
          ? 'stale'
          : 'outcome_unknown',
    });
  }
  const pending = importedCommand!;
  const waiting = new Promise<ImportResult>((resolve) => {
    pending.resolve = resolve;
    pending.timer = setTimeout(
      () => finishImport({ status: 'outcome_unknown' }),
      12000,
    );
  });
  pending.waiting = waiting;
  if (previous) transport.resolveUncertain();
  else if (
    !transport.command(
      { media: request.media },
      {
        commandId: request.requestId,
        epoch: request.target.epoch,
        mediaGeneration: request.target.mediaGeneration,
        expectedRevision: request.target.expectedRevision,
      },
    )
  )
    finishImport({ status: 'rejected' });
  return waiting;
}
const importHandoff = new ImportHandoff({
  room: () =>
    host.value && transport.active && transport.connected
      ? {
          roomId: current.value.roomId,
          epoch: current.value.epoch,
          mediaGeneration: current.value.mediaGeneration,
          expectedRevision: current.value.revision,
        }
      : undefined,
  execute: importMedia,
});
function clearMedia(): void {
  closeContextMenu(false);
  statisticsVersion.value++;
  clearSeekPreview();
  endSeek();
  danmakuMenu.value = false;
  if (stage.value?.querySelector('.player-menu:focus-within'))
    stage.value?.focus({ preventScroll: true });
  qualityMenu.value = false;
  rateMenu.value = false;
  selection.abort();
  selection = new AbortController();
  selectionGeneration++;
  subscription?.();
  adapter?.dispose();
  adapter = undefined;
  videoAspectRatio.value = 16 / 9;
  descriptor.value = undefined;
  sync.invalidate();
  mediaStatus.value = 'no_media';
  lastReport = '';
  probedBarrier = '';
  probingBarrier = '';
  loading.value = false;
  publishing = false;
  streamInfo.value = undefined;
}
function mediaMatches(
  selected: MediaDescriptor | null,
  local: MediaDescriptor | undefined,
): boolean {
  if (
    !selected ||
    !local ||
    Math.abs(selected.durationMs - local.durationMs) > 250
  )
    return false;
  if (selected.kind === 'local' && local.kind === 'local')
    return (
      selected.digest === local.digest && selected.sizeBytes === local.sizeBytes
    );
  return (
    selected.kind === 'bilibili' &&
    local.kind === 'bilibili' &&
    selected.bvid === local.bvid &&
    selected.cid === local.cid &&
    selected.part === local.part &&
    selected.episodeId === local.episodeId
  );
}
function danmakuPreferences(): void {
  if (adapter instanceof BilibiliAdapter) {
    adapter.danmaku.visible = showDanmaku.value;
    adapter.danmaku.density = density.value;
    adapter.danmaku.fontSize = danmakuSize.value;
    adapter.danmaku.speed = danmakuSpeed.value;
    adapter.danmaku.area = danmakuArea.value;
  }
}
function toggleDanmaku(): void {
  showDanmaku.value = !showDanmaku.value;
  danmakuPreferences();
}
function togglePlayback(): void {
  command(
    isPlaying.value
      ? 'pause'
      : current.value.playback.phase === 'ended'
        ? 'replay'
        : 'play',
  );
}
function clickSurface(event: MouseEvent): void {
  if (event.target !== video.value && event.target !== stage.value) return;
  if (suppressSurfaceClick) {
    suppressSurfaceClick = false;
    return;
  }
  if (contextPosition.value) {
    closeContextMenu();
    return;
  }
  stage.value?.focus({ preventScroll: true });
  if (danmakuMenu.value || qualityMenu.value || rateMenu.value) {
    danmakuMenu.value = false;
    qualityMenu.value = false;
    rateMenu.value = false;
    return;
  }
  togglePlayback();
}
async function fullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) {
      exitingFullscreen = true;
      try {
        await document.exitFullscreen();
      } catch (reason) {
        exitingFullscreen = false;
        throw reason;
      }
    } else {
      exitingFullscreen = false;
      // Allow overlays to consume Escape before the browser exits fullscreen.
      const options: FullscreenOptions & { keyboardLock: 'browser' } = {
        keyboardLock: 'browser',
      };
      try {
        await stage.value?.requestFullscreen(options);
      } catch (reason) {
        if (
          !(reason instanceof DOMException) ||
          reason.name !== 'NotSupportedError'
        )
          throw reason;
        await stage.value?.requestFullscreen();
      }
      const keyboard = (navigator as Navigator & { keyboard?: EscapeKeyboard })
        .keyboard;
      if (!disposed && document.fullscreenElement === stage.value && keyboard) {
        const generation = ++keyboardGeneration;
        escapeKeyboard = keyboard;
        try {
          // Chromium uses a separate, permission-controlled API for Escape.
          await keyboard.lock(['Escape']);
        } catch {
          // Fullscreen remains usable when the browser denies keyboard locking.
          if (generation === keyboardGeneration) escapeKeyboard = undefined;
        }
      }
    }
  } catch {
    showError(message('player.fullscreenUnavailable'));
  }
}
function releaseFullscreenKeyboard(): void {
  keyboardGeneration++;
  escapeKeyboard?.unlock();
  escapeKeyboard = undefined;
}
async function toggleWindowFullscreen(): Promise<void> {
  if (document.fullscreenElement === stage.value) {
    await fullscreen();
    if (disposed || document.fullscreenElement === stage.value) return;
    windowFullscreen.value = true;
  } else windowFullscreen.value = !windowFullscreen.value;
}
function fullscreenChanged(): void {
  const active = document.fullscreenElement === stage.value;
  if (!active) {
    releaseFullscreenKeyboard();
    // Browser-owned exits can bypass DOM keys when locking is unavailable/denied.
    if (wasFullscreen && !exitingFullscreen) {
      if (hasKeyboardOverlay()) dismissKeyboardOverlay();
      else if (statisticsOpen.value) closeStatistics();
    }
    exitingFullscreen = false;
  }
  wasFullscreen = active;
}
function reloadDanmaku(): void {
  if (adapter instanceof BilibiliAdapter) adapter.reloadDanmaku();
}
function showError(value: Message | '', reload = false): void {
  error.value = value;
  errorReload.value = reload;
}
async function chooseBilibili(
  selected: Pick<Episode, 'bvid' | 'part' | 'episodeId'>,
  publishMedia = false,
  quality?: number,
  autoPlay = false,
): Promise<void> {
  if (
    !video.value ||
    !overlay.value ||
    !active.value ||
    !connected.value ||
    loading.value ||
    pendingCommand.value
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
    (failure) => {
      if (adapter === local) showError(failure.text, failure.reload);
    },
    () => {
      if (adapter === local) queueThumbnail();
    },
  );
  adapter = local;
  danmakuPreferences();
  void sample();
  try {
    const media = await local.load(
      selected.bvid,
      selected.part,
      signal,
      quality ?? preferredQuality.value,
      selected.episodeId,
    );
    if (signal.aborted || generation !== selectionGeneration) return;
    streamInfo.value = local.mediaInfo;
    playlist.value =
      local.mediaInfo?.playlist ?? (autoPlay ? playlist.value : undefined);
    videoTitle.value = local.mediaInfo?.title ?? selected.bvid;
    descriptor.value = media;
    subscription = local.subscribe(() => {
      void sample();
    });
    if (publishMedia && host.value) {
      publishing = true;
      transport.command({ media, ...(autoPlay ? { autoPlay: true } : {}) });
    }
    await sample();
  } catch (reason) {
    if (!signal.aborted && generation === selectionGeneration) {
      const failure =
        reason instanceof HelperError
          ? reason
          : new HelperError('invalid-media');
      showError(failure.text, failure.reload);
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
  if (!video.value || pendingCommand.value || !connected.value) return;
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
      showError(errorMessage(reason, 'player.localFailed'));
      const failed =
        local.getState().status === 'unsupported' ? 'unsupported' : 'error';
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
  if (!canReplace.value) return;
  const selected = await mediaPicker.value?.prepare();
  if (!selected) return;
  replaceOpen.value = false;
  if (selected.media.kind === 'local' && selected.file)
    await loadLocal(selected.file, selected.media, true);
  else if (selected.media.kind === 'bilibili')
    await chooseBilibili(selected.media, true);
}
async function selectEpisode(episode: Episode): Promise<void> {
  if (
    !canReplace.value ||
    !playlist.value?.episodes.some((entry) => sameEpisode(entry, episode))
  )
    return;
  const media = current.value.media;
  if (media?.kind === 'bilibili' && sameEpisode(media, episode)) return;
  const attempt = { episode, phase: 'loading' as const };
  episodeSelection.value = attempt;
  await chooseBilibili(episode, true, undefined, true);
  if (!disposed && episodeSelection.value === attempt)
    episodeSelection.value = {
      ...attempt,
      phase: 'failed',
      error: error.value || roomError.value || message('episodes.failed'),
    };
}
function confirmMedia(event: KeyboardEvent): void {
  if (event.isComposing || event.keyCode === 229) {
    event.preventDefault();
    return;
  }
  if (
    event.target instanceof Element &&
    event.target.closest('button, a, select, textarea, input[type="file"]')
  )
    return;
  event.preventDefault();
  void replaceMedia();
}
async function openMedia(selection?: VideoSelection): Promise<void> {
  if (!canReplace.value) return;
  replaceOpen.value = true;
  await nextTick();
  await mediaPicker.value?.selectBilibili(selection);
}
const commands = computed<QuickCommand[]>(() => [
  ...(host.value
    ? [
        {
          id: 'video',
          label: t('player.changeVideo'),
          group: 'watch' as const,
          icon: 'screen',
          shortcut: '/video',
          aliases: 'replace change video bilibili link 更换 替换 视频 链接',
          disabled: !canReplace.value,
          detail: !canReplace.value
            ? controlNote.value || t('common.preparingVideo')
            : t('commands.videoHint'),
          run: (selection?: VideoSelection) => {
            void openMedia(selection);
          },
        },
      ]
    : []),
  ...(current.value.media?.kind === 'local'
    ? [
        {
          id: 'local',
          label: t('media.chooseFile'),
          group: 'watch' as const,
          icon: 'file',
          shortcut: '/local',
          aliases: 'local file 本地 文件 选择',
          disabled: loading.value,
          run: chooseFile,
        },
      ]
    : []),
  ...(['play', 'pause', 'replay'] as const).map((action) => ({
    id: action,
    label: t(
      action === 'play'
        ? 'player.playTogether'
        : action === 'pause'
          ? 'player.pauseTogether'
          : 'player.replay',
    ),
    group: 'watch' as const,
    icon: action,
    shortcut: `/${action}`,
    aliases:
      action === 'play'
        ? '播放 开始'
        : action === 'pause'
          ? '暂停 停止'
          : '重播 重新播放',
    disabled: action === 'play' ? !canPlay.value : !canControl.value,
    detail:
      controlNote.value ||
      (action === 'play' && !canPlay.value
        ? t(readinessText[shownStatus.value])
        : undefined),
    run: () => command(action),
  })),
  {
    id: 'seek',
    label: t('commands.seek'),
    group: 'watch',
    icon: 'replay',
    shortcut: '/seek',
    aliases: 'position jump seek 跳转 进度 定位',
    disabled: !canControl.value,
    detail: controlNote.value || undefined,
    run: () => {
      wake();
      stage.value
        ?.querySelector<HTMLInputElement>('input[type="range"]')
        ?.focus();
    },
  },
  {
    id: 'window-fullscreen',
    label: t(
      windowFullscreen.value
        ? 'player.exitWindowFullscreen'
        : 'player.windowFullscreen',
    ),
    group: 'watch',
    icon: 'window-fullscreen',
    shortcut: '/window-fullscreen',
    aliases: 'window fullscreen theater theatre 网页全屏 浏览器窗口全屏',
    run: () => {
      void toggleWindowFullscreen();
    },
  },
  {
    id: 'fullscreen',
    label: t('player.fullscreen'),
    group: 'watch',
    icon: 'fullscreen',
    shortcut: '/fullscreen',
    aliases: 'fullscreen screen full 全屏 屏幕',
    run: () => {
      void fullscreen();
    },
  },
  {
    id: 'mute',
    label: t(muted.value ? 'player.unmute' : 'player.mute'),
    group: 'watch',
    icon: muted.value ? 'volume' : 'mute',
    shortcut: '/mute',
    aliases: 'volume sound mute unmute 声音 静音 取消静音',
    run: () => {
      muted.value = !muted.value;
    },
  },
  ...(current.value.media?.kind === 'bilibili'
    ? [
        {
          id: 'danmaku',
          label: t(
            showDanmaku.value ? 'commands.hideDanmaku' : 'player.showDanmaku',
          ),
          group: 'watch' as const,
          icon: showDanmaku.value ? 'chat' : 'chat-off',
          shortcut: '/danmaku',
          aliases: 'comments danmaku 弹幕 显示 隐藏',
          run: toggleDanmaku,
        },
      ]
    : []),
  {
    id: 'statistics',
    label: t(
      statisticsOpen.value ? 'player.closeStatistics' : 'player.statistics',
    ),
    group: 'watch',
    icon: 'info',
    shortcut: '/stats',
    aliases: 'stats statistics video information 视频 统计 信息',
    run: toggleStatistics,
  },
  {
    id: 'shortcuts',
    label: t('player.keyboardHelp'),
    group: 'watch',
    icon: 'screen',
    shortcut: '/shortcuts',
    aliases: 'keyboard shortcuts help 快捷键 帮助',
    run: openShortcuts,
  },
]);
const episodeActions = computed<EpisodeActions>(() => {
  const media = current.value.media;
  return {
    playlist: playlist.value,
    current:
      media?.kind === 'bilibili'
        ? { ...media, title: videoTitle.value }
        : undefined,
    canSelect: canReplace.value,
    note: !host.value
      ? t('episodes.viewerHint')
      : controlNote.value ||
        (loading.value ? t('common.preparingVideo') : t('episodes.hostHint')),
    unavailable: !media
      ? t('episodes.noMedia')
      : media.kind === 'local'
        ? t('episodes.localOnly')
        : t('episodes.noList'),
    selection: episodeSelection.value
      ? {
          ...episodeSelection.value,
          error: translate(episodeSelection.value.error),
        }
      : undefined,
    select: (episode) => {
      void selectEpisode(episode);
    },
  };
});
defineExpose({
  layout,
  commands,
  playlist,
  canReplace,
  selectEpisode,
  episodeActions,
  importMedia,
});
async function changeQuality(quality: number): Promise<void> {
  const selected = current.value.media;
  if (
    selected?.kind !== 'bilibili' ||
    !streamInfo.value?.qualities.includes(quality) ||
    loading.value
  )
    return;
  preferredQuality.value = quality;
  if (streamInfo.value.quality === quality) return;
  await chooseBilibili(selected, false, quality);
}
function hoverSeek(event: PointerEvent): void {
  if (event.pointerType === 'touch') return;
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  if (!bounds.width) return;
  seekTrackWidth.value = bounds.width;
  seekPointerOffset.value = Math.max(
    0,
    Math.min(bounds.width, event.clientX - bounds.left),
  );
  hoveredTime.value =
    (seekPointerOffset.value / bounds.width) * totalSeconds.value;
}
function dragSeek(event: Event): void {
  if (!canControl.value) return;
  dragging.value = true;
  seekSeconds.value = Number((event.target as HTMLInputElement).value);
}
function seek(event: Event): void {
  dragging.value = false;
  if (!canControl.value) return;
  seekSeconds.value = Number((event.target as HTMLInputElement).value);
  command('seek');
}
function seekKeyboard(event: KeyboardEvent): void {
  if (
    !canControl.value &&
    [
      'ArrowLeft',
      'ArrowRight',
      'ArrowUp',
      'ArrowDown',
      'PageUp',
      'PageDown',
      'Home',
      'End',
    ].includes(event.key)
  )
    event.preventDefault();
}
function keyboard(event: KeyboardEvent): void {
  if (
    event.defaultPrevented ||
    hasKeyboardOverlay() ||
    document.visibilityState !== 'visible' ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return;
  windowFocusTarget = null;
  const key = event.key.toLowerCase();
  if (
    key === 'tab' &&
    event.target instanceof Node &&
    stage.value?.contains(event.target)
  )
    wake();
  if (
    (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) &&
    (event.target === stage.value || event.target === video.value)
  ) {
    event.preventDefault();
    const bounds = stage.value?.getBoundingClientRect();
    if (bounds) showContextMenu(bounds.width / 2, bounds.height / 2);
    return;
  }
  if (key === 'escape' && statisticsOpen.value) {
    event.preventDefault();
    if (!event.repeat) closeStatistics();
    return;
  }
  if (key === 'escape' && document.fullscreenElement) {
    event.preventDefault();
    if (!event.repeat) void fullscreen();
    return;
  }
  if (key === 'escape' && windowFullscreen.value) {
    event.preventDefault();
    if (!event.repeat) windowFullscreen.value = false;
    return;
  }
  if (
    event.target instanceof Element &&
    event.target.closest(
      'input, select, textarea, [contenteditable], [role="menu"], [role="tablist"], dialog, [role="dialog"]',
    )
  )
    return;
  if (key === ' ' || key === 'k') {
    // Keep the focused control in place while suppressing native Space clicks.
    event.preventDefault();
    togglePlayback();
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    seekSeconds.value = Math.min(
      totalSeconds.value,
      Math.max(0, position.value + (event.key === 'ArrowLeft' ? -5 : 5)),
    );
    command('seek');
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    volume.value = Math.max(
      0,
      Math.min(
        1,
        Math.round(volume.value * 100 + (event.key === 'ArrowUp' ? 10 : -10)) /
          100,
      ),
    );
    muted.value = false;
    showVolumeFeedback();
  } else if (key === 'm') {
    event.preventDefault();
    muted.value = !muted.value;
  } else if (key === 'd' && current.value.media?.kind === 'bilibili') {
    event.preventDefault();
    toggleDanmaku();
  } else if (key === 'f') {
    event.preventDefault();
    void fullscreen();
  } else if (key === 's') {
    event.preventDefault();
    if (!event.repeat) void toggleWindowFullscreen();
  } else return;
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
    else if (
      !['unsupported', 'error', 'access_denied'].includes(mediaStatus.value)
    )
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
  const rateSupported = supportsPlaybackRate(local, snapshot.playback.rate);
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
        active.value && transport.connected && matched,
      );
      const barrier = snapshot.barrier;
      if (
        matched &&
        active.value &&
        transport.connected &&
        rateSupported &&
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
        showError(message('player.applyFailed'));
    }
    if (adapter !== local || disposed) return;
    mediaStatus.value = rateSupported ? local.getState().status : 'unsupported';
  }
  if (adapter !== local || disposed) return;
  if (
    snapshot.epoch !== current.value.epoch ||
    snapshot.mediaGeneration !== current.value.mediaGeneration
  )
    return;
  const observation = local.getState();
  // Failed/disposed players can lose native metadata. Unknown timing must stay null on the wire.
  const timed =
    matched &&
    Number.isSafeInteger(observation.durationMs) &&
    observation.durationMs >= 1 &&
    observation.durationMs <= 604800000;
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
    positionMs:
      timed &&
      Number.isSafeInteger(observation.positionMs) &&
      observation.positionMs >= 0 &&
      observation.positionMs <= (snapshot.media?.durationMs ?? 0)
        ? observation.positionMs
        : null,
    durationMs: timed ? observation.durationMs : null,
    capabilities: local.capabilities,
  };
  publish(report, now);
}
function publish(report: Readiness, now: number): void {
  const key = JSON.stringify([
    report.status,
    report.mediaGeneration,
    report.barrierId,
  ]);
  if (
    key !== lastReport ||
    (report.barrierId !== null && now - lastReportAt >= 1000)
  ) {
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
    action === 'seek'
      ? { action, positionMs: Math.round(seekSeconds.value * 1000) }
      : { action },
  );
}
function changePlaybackRate(rate: number): void {
  if (!canControl.value || rate === current.value.playback.rate) return;
  showError('');
  roomError.value = '';
  transport.command({ action: 'rate', rate });
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
      if (local.getState().status !== 'gesture_required')
        heading.value?.focus();
      return;
    }
    showError(
      local.getState().status === 'gesture_required'
        ? message('player.blocked')
        : message('player.decodeFailed'),
    );
  }
}
function reload(): void {
  location.reload();
}
function visibility(): void {
  if (document.visibilityState !== 'visible') return;
  // Refresh calibration without discarding a usable estimate or interrupting playback.
  transport.calibrate();
  void sample();
}
onMounted(() => {
  measureDetails();
  if (typeof ResizeObserver !== 'undefined' && details.value) {
    detailsObserver = new ResizeObserver(scheduleDetails);
    detailsObserver.observe(details.value);
  }
  wake();
  transport.start();
  timer = setInterval(() => {
    void sample();
  }, 250);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('blur', rememberWindowFocus);
  document.addEventListener('keydown', keyboard);
  document.addEventListener('fullscreenchange', fullscreenChanged);
  document.addEventListener('pointerdown', outsideContextMenu, true);
  document.addEventListener('pointerup', endSeek);
  document.addEventListener('pointercancel', endSeek);
});
onUnmounted(() => {
  detailsObserver?.disconnect();
  if (detailsFrame !== undefined) cancelAnimationFrame(detailsFrame);
  disposed = true;
  finishImport({ status: 'outcome_unknown' });
  importHandoff.dispose();
  clearInterval(timer);
  clearTimeout(idleTimer);
  clearTimeout(volumeFeedbackTimer);
  clearTimeout(commandDelayTimer);
  handoff = undefined;
  document.removeEventListener('visibilitychange', visibility);
  window.removeEventListener('blur', rememberWindowFocus);
  document.removeEventListener('keydown', keyboard);
  document.removeEventListener('fullscreenchange', fullscreenChanged);
  releaseFullscreenKeyboard();
  document.removeEventListener('pointerdown', outsideContextMenu, true);
  document.removeEventListener('pointerup', endSeek);
  document.removeEventListener('pointercancel', endSeek);
  transport.dispose();
  clearMedia();
});
</script>

<template>
  <section
    class="player-panel"
    :class="{ 'command-pending': pendingCommand }"
    :style="{ '--video-aspect-ratio': videoAspectRatio }"
    aria-labelledby="player-title"
  >
    <h3 id="player-title" ref="heading" class="visually-hidden" tabindex="-1">
      {{ t('common.watchTogether') }}
    </h3>
    <div class="player-viewport">
      <div
        ref="stage"
        class="video-stage"
        :class="{
          'controls-idle': idle,
          'window-fullscreen': windowFullscreen,
        }"
        tabindex="0"
        :aria-label="t('player.shortcuts')"
        @click="clickSurface"
        @contextmenu="contextMenu"
        @pointerenter="pointerActivity"
        @pointermove="pointerActivity"
        @pointerdown="pointerActivity"
        @focusin="focusStage"
        @pointerleave="leaveStage"
      >
        <video
          ref="video"
          preload="auto"
          playsinline
          :muted="muted"
          :volume="volume"
          :aria-label="t('player.roomVideo')"
          @loadedmetadata="updateVideoAspectRatio"
          @resize="updateVideoAspectRatio"
        />
        <div ref="overlay" class="danmaku-overlay" aria-hidden="true" />
        <PlayerStatistics
          v-if="statisticsOpen"
          :key="statisticsVersion"
          :read="readStatistics"
          @close="closeStatistics"
        />
        <PlayerShortcuts
          v-if="shortcutsOpen"
          :bilibili="current.media?.kind === 'bilibili'"
          @close="closeShortcuts"
        />
        <PlayerContextMenu
          v-if="contextPosition"
          :items="contextItems"
          :position="contextPosition"
          :stage="stage"
          @select="selectContextItem"
          @close="closeContextMenu"
        />
        <div
          v-if="volumeFeedback"
          class="volume-feedback"
          role="status"
          :aria-label="t('player.localVolume')"
          aria-atomic="true"
        >
          <Icon :name="muted || !volume ? 'mute' : 'volume'" :size="22" />
          <span>{{ Math.round(volume * 100) }}</span>
        </div>
        <div v-if="replaced" class="player-state">
          <Icon name="screen" :size="36" />
          <h3>{{ t('player.moved') }}</h3>
          <p>{{ t('player.movedHint') }}</p>
          <button @click="reload">{{ t('player.usePage') }}</button>
        </div>
        <div v-else-if="error && !loading" class="player-state" role="alert">
          <Icon name="screen" :size="32" />
          <p>{{ translate(error) }}</p>
          <button v-if="errorReload" @click="reload">
            {{ t('common.reload') }}</button
          ><button
            v-else-if="current.media?.kind === 'bilibili'"
            @click="retryMedia"
          >
            {{ t('player.retryVideo') }}</button
          ><button v-else type="button" class="file-button" @click="chooseFile">
            {{ t('common.chooseAnother') }}
          </button>
        </div>
        <div
          v-else-if="mediaStatus === 'gesture_required'"
          class="player-state"
        >
          <Icon name="play" :size="36" />
          <h3>{{ t('player.joinMoment') }}</h3>
          <p>{{ t('player.permission') }}</p>
          <button @click="enable">{{ t('player.enable') }}</button>
        </div>
        <div
          v-else-if="!descriptor && !loading && current.media?.kind === 'local'"
          class="player-state"
        >
          <span class="state-symbol"><Icon name="file" :size="34" /></span>
          <h3>{{ t('player.seatReady') }}</h3>
          <p>{{ t('player.selectCopy') }}</p>
          <label class="file-button" for="local-video"
            ><Icon name="plus" />{{ t('player.matchingVideo') }}</label
          ><small>{{ t('player.filePrivate') }}</small>
        </div>
        <div v-else-if="mediaStatus === 'mismatch'" class="player-state">
          <h3>{{ t('player.differentVideo') }}</h3>
          <p>{{ t('player.mismatchHint') }}</p>
          <button type="button" class="file-button" @click="chooseFile">
            {{ t('player.matchingVideo') }}
          </button>
        </div>
        <div
          v-else-if="playbackIndicator"
          class="playback-indicator"
          :data-state="playbackIndicator"
          role="img"
          :aria-label="
            playbackIndicator === 'paused'
              ? t(phaseText.paused)
              : t(readinessText[playbackIndicator])
          "
        >
          <Icon
            :name="playbackIndicator === 'paused' ? 'play' : 'loader'"
            :size="32"
            :class="{ 'playback-spinner': playbackIndicator !== 'paused' }"
          />
        </div>
        <div
          v-else-if="!descriptor && current.media?.kind === 'bilibili'"
          class="player-state"
        >
          <Icon name="screen" :size="36" />
          <h3>{{ t('player.connectHelper') }}</h3>
          <p>{{ t('player.helperHint') }}</p>
          <button class="quiet" @click="retryMedia">
            {{ t('player.retryVideo') }}
          </button>
        </div>
        <div
          v-else-if="current.playback.phase === 'ended'"
          class="player-state"
        >
          <h3>{{ t('player.again') }}</h3>
          <button
            :disabled="!canControl && !pendingCommand"
            :aria-disabled="!canControl"
            @click="command('replay')"
          >
            <Icon name="replay" />{{ t('player.replay') }}
          </button>
        </div>
        <div
          v-if="
            current.barrier && descriptor && mediaStatus !== 'gesture_required'
          "
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
          :disabled="!active || !connected || !!pendingCommand"
          :aria-label="t('player.selectMatching')"
          @change="choose"
        />
        <div
          v-if="commandDelayed"
          class="notice command-recovery"
          role="status"
        >
          <span>{{ t('player.commandDelayed') }}</span
          ><button
            ref="commandRecovery"
            :disabled="!connected"
            @click="transport.resolveUncertain()"
          >
            {{ t('player.checkOriginal') }}
          </button>
        </div>
        <div
          class="player-controls"
          @pointerenter="hoverControls($event, true)"
          @pointerleave="hoverControls($event, false)"
        >
          <div
            class="seek-track"
            @pointermove="hoverSeek"
            @pointerleave="clearSeekPreview"
          >
            <div
              class="buffered-track"
              :style="{
                width: `${totalSeconds ? (buffered / totalSeconds) * 100 : 0}%`,
              }"
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
              :aria-label="t('player.seek')"
              :aria-valuetext="
                t('player.seekValue', {
                  position: formatTime(dragging ? seekSeconds : position),
                  duration: formatTime(totalSeconds),
                })
              "
              :disabled="!canControl && !pendingCommand"
              :aria-disabled="!canControl"
              @keydown="seekKeyboard"
              @pointerdown="startSeek"
              @click="stage?.focus({ preventScroll: true })"
              @input="dragSeek"
              @change="seek"
            />
            <div
              v-if="hoveredTime !== undefined"
              class="seek-preview"
              :class="{ 'has-thumbnail': thumbnailVisible }"
              aria-hidden="true"
              :style="{
                '--seek-pointer-offset': `${seekPointerOffset}px`,
                '--seek-track-width': `${seekTrackWidth}px`,
              }"
            >
              <canvas
                ref="previewCanvas"
                v-show="thumbnailVisible"
                width="160"
                height="90"
              />
              <span>{{ formatTime(hoveredTime) }}</span>
            </div>
          </div>
          <div class="control-bar">
            <div class="control-start">
              <button
                class="icon-button"
                :aria-label="
                  isPlaying
                    ? t('player.pauseTogether')
                    : current.playback.phase === 'ended'
                      ? t('player.replay')
                      : t('player.playTogether')
                "
                :title="
                  controlNote ||
                  (isPlaying
                    ? t('player.pauseShortcut')
                    : t('player.playShortcut'))
                "
                :disabled="
                  (isPlaying ? !canControl : !canPlay) && !pendingCommand
                "
                :aria-disabled="isPlaying ? !canControl : !canPlay"
                :aria-describedby="controlNote ? 'control-note' : undefined"
                @click="togglePlayback"
              >
                <Icon
                  :name="
                    isPlaying
                      ? 'pause'
                      : current.playback.phase === 'ended'
                        ? 'replay'
                        : 'play'
                  "
                />
              </button>
              <button
                class="icon-button"
                :aria-label="muted ? t('player.unmute') : t('player.mute')"
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
                step="0.1"
                @input="muted = false"
                :aria-label="t('player.localVolume')"
                :aria-valuetext="
                  t(muted ? 'player.mutedVolume' : 'player.volumeValue', {
                    volume: Math.round(volume * 100),
                  })
                "
              />
              <span class="player-time"
                >{{ formatTime(dragging ? seekSeconds : position)
                }}<span>/ {{ formatTime(totalSeconds) }}</span></span
              >
            </div>
            <div class="control-end">
              <DanmakuControl
                v-if="current.media?.kind === 'bilibili'"
                :open="danmakuMenu"
                :visible="showDanmaku"
                :density="density"
                :font-size="danmakuSize"
                :speed="danmakuSpeed"
                :area="danmakuArea"
                :stage="stage"
                @update:open="
                  (value) => {
                    danmakuMenu = value;
                    if (value) {
                      qualityMenu = false;
                      rateMenu = false;
                    }
                  }
                "
                @toggle="toggleDanmaku"
                @update:area="
                  (value) => {
                    danmakuArea = value;
                    danmakuPreferences();
                  }
                "
                @update:density="
                  (value) => {
                    density = value;
                    danmakuPreferences();
                  }
                "
                @update:font-size="
                  (value) => {
                    danmakuSize = value;
                    danmakuPreferences();
                  }
                "
                @update:speed="
                  (value) => {
                    danmakuSpeed = value;
                    danmakuPreferences();
                  }
                "
              />
              <PlayerChoiceMenu
                :open="rateMenu"
                trigger-class="playback-rate"
                :label="t('player.playbackSpeed')"
                :text="`${current.playback.rate}×`"
                :value="current.playback.rate"
                :options="
                  playbackRates.map((value) => ({ value, label: `${value}×` }))
                "
                :stage="stage"
                :title="controlNote || t('player.playbackSpeedShared')"
                :disabled="!canControl && !pendingCommand"
                :unavailable="!canControl"
                :describedby="controlNote ? 'control-note' : undefined"
                @update:open="
                  (value) => {
                    rateMenu = value;
                    if (value) {
                      danmakuMenu = false;
                      qualityMenu = false;
                    }
                  }
                "
                @select="changePlaybackRate"
              />
              <PlayerChoiceMenu
                v-if="current.media?.kind === 'bilibili'"
                :open="qualityMenu"
                trigger-class="quality-trigger"
                :label="t('player.videoQuality')"
                :text="
                  streamInfo
                    ? qualityName(streamInfo.quality)
                    : t('player.quality')
                "
                :value="streamInfo?.quality ?? 0"
                :options="
                  [...(streamInfo?.qualities ?? [])]
                    .sort((a, b) => b - a)
                    .map((value) => ({ value, label: qualityName(value) }))
                "
                :stage="stage"
                :disabled="!streamInfo || loading"
                @update:open="
                  (value) => {
                    qualityMenu = value;
                    if (value) {
                      danmakuMenu = false;
                      rateMenu = false;
                    }
                  }
                "
                @select="changeQuality"
              />
              <div class="display-controls">
                <button
                  class="icon-button"
                  :aria-label="
                    t(
                      windowFullscreen
                        ? 'player.exitWindowFullscreen'
                        : 'player.windowFullscreen',
                    )
                  "
                  :title="`${t(windowFullscreen ? 'player.exitWindowFullscreen' : 'player.windowFullscreen')} (S)`"
                  :aria-pressed="windowFullscreen"
                  aria-keyshortcuts="s"
                  @click="toggleWindowFullscreen"
                >
                  <Icon
                    :name="
                      windowFullscreen ? 'window-restore' : 'window-fullscreen'
                    "
                  />
                </button>
                <button
                  class="icon-button"
                  :aria-label="t('player.fullscreen')"
                  @click="fullscreen"
                >
                  <Icon name="fullscreen" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div ref="details" class="player-details">
      <div class="video-information">
        <div class="video-description">
          <span class="source-label">{{
            current.media?.kind === 'local'
              ? t('common.localFileLabel')
              : t('media.bilibiliLabel')
          }}</span>
          <span
            v-if="videoCodec"
            class="codec-label"
            :title="t('player.videoCodec', { codec: videoCodec })"
          >
            <span class="visually-hidden">{{
              t('player.videoCodec', { codec: videoCodec })
            }}</span
            ><span aria-hidden="true">{{ videoCodec }}</span>
          </span>
          <h3
            :title="
              videoTitle ||
              (current.media?.kind === 'local'
                ? current.media.label || t('common.watchingTogether')
                : current.media?.bvid)
            "
          >
            {{
              videoTitle ||
              (current.media?.kind === 'local'
                ? current.media.label || t('common.watchingTogether')
                : current.media?.bvid)
            }}<span v-if="current.media?.kind === 'bilibili'" class="hint">
              · {{ t('player.part', { part: current.media.part }) }}</span
            >
          </h3>
          <p
            v-if="controlNote"
            id="control-note"
            :class="pendingCommand ? 'visually-hidden' : 'hint'"
          >
            {{ controlNote }}
          </p>
        </div>
        <button
          v-if="host"
          class="quiet change-media"
          :disabled="!canReplace && !pendingCommand"
          :aria-disabled="!canReplace"
          @click="openMedia()"
        >
          <Icon name="plus" :size="16" />{{ t('player.changeVideo') }}
        </button>
      </div>
      <div class="playback-status">
        <div role="status">
          <span class="status-dot" />{{ translate(status)
          }}<span class="separator">·</span>{{ translate(calibration) }}
        </div>
        <span
          class="media-status"
          data-testid="media-status"
          :data-state="shownStatus"
          >{{ t(readinessText[shownStatus]) }}</span
        ><span
          data-testid="playback-phase"
          :data-state="current.playback.phase"
          >{{ t(phaseText[current.playback.phase]) }}</span
        >
      </div>
      <div v-if="roomError" class="notice error" role="alert">
        <span>{{ translate(roomError) }}</span
        ><button v-if="roomErrorReload" class="quiet" @click="reload">
          {{ t('common.reload') }}
        </button>
      </div>
      <p v-if="hostNotice" class="notice" role="status">
        {{ t('player.hostLeft') }}
      </p>
      <p v-if="waitTimedOut" class="notice" role="status">
        {{ t('player.waitTimeout') }}
        {{ permitted ? t('player.retryPlay') : t('player.hostRetry') }}
      </p>
    </div>
    <Modal
      v-if="replaceOpen"
      :title="t('player.changeTitle')"
      @close="replaceOpen = false"
      @keydown.enter="confirmMedia"
      ><form autocomplete="off" @submit.prevent="replaceMedia">
        <MediaPicker
          ref="mediaPicker"
          :room-id="current.roomId"
          :disabled="loading"
        />
        <p class="hint">{{ t('player.changeHint') }}</p>
        <button :disabled="loading">
          {{ t('player.useVideo') }}
        </button>
      </form></Modal
    >
  </section>
</template>
