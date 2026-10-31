<script setup lang="ts">
import {
  t,
  message,
  translate,
  errorMessage,
  i18n,
  type Message,
} from '../../i18n';

import {
  computed,
  nextTick,
  onMounted,
  onUnmounted,
  ref,
  shallowRef,
  watch,
} from 'vue';
import type { QuickCommand, VideoSelection } from '../commands/search';
import { APIError, request, type Snapshot } from '../../transport/api';
import type { MediaDescriptor } from '../../transport/contracts';
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
import { BilibiliAdapter } from '../../player/bilibili/adapter';
import { HelperError } from '../../player/bilibili/bridge';
import type { Episode, MediaInfo, Playlist } from '../../player/bilibili/media';
import Icon from '../../components/Icon.vue';
import Modal from '../../components/Modal.vue';
import MediaPicker from '../media/MediaPicker.vue';
import DanmakuControl from './DanmakuControl.vue';
import { LocalAdapter, type PlayerAdapter } from '../../player/adapters/local';
import { localFingerprint } from '../../player/fingerprint';
import { reportedReadiness, SyncController } from '../../sync/controller';
import { nextSyncQuality, type SyncQualityState } from '../../sync/clock';
import { phaseText, readinessText } from '../status-text';
import {
  readPlayerPreferences,
  savePlayerPreferences,
} from '../../player/preferences';

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
const danmakuStatus = ref<Message | ''>(''),
  showDanmaku = ref(true),
  density = ref(20),
  danmakuSize = ref(20);
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
const preferences = readPlayerPreferences();
const active = ref(false),
  connected = ref(false),
  loading = ref(false),
  uncertain = ref<Command>(),
  seekSeconds = ref(0),
  muted = ref(preferences.muted),
  volume = ref(preferences.volume);
const preferredQuality = ref(preferences.quality);
watch([volume, muted, preferredQuality], () =>
  savePlayerPreferences({
    volume: volume.value,
    muted: muted.value,
    ...(preferredQuality.value ? { quality: preferredQuality.value } : {}),
  })
);
const position = ref(0),
  buffered = ref(0),
  dragging = ref(false),
  danmakuMenu = ref(false),
  qualityMenu = ref(false),
  replaceOpen = ref(false),
  hoveredTime = ref<number>(),
  idle = ref(false),
  controlsHovered = ref(false);
const mediaPicker = ref<InstanceType<typeof MediaPicker>>();
const qualityTrigger = ref<HTMLButtonElement>(),
  qualityOptions = ref<HTMLElement>();
const streamInfo = shallowRef<MediaInfo>();
const playlist = shallowRef<Playlist>();
const videoTitle = ref('');
const totalSeconds = computed(
  () => (current.value.media?.durationMs ?? 0) / 1000
);
const isPlaying = computed(() => current.value.playback.phase === 'playing');
let idleTimer: ReturnType<typeof setTimeout> | undefined;
function wake(): void {
  idle.value = false;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (
      !controlsHovered.value &&
      isPlaying.value &&
      !danmakuMenu.value &&
      !qualityMenu.value &&
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
    126: t('player.dolby'),
    127: '8K',
  })[value] ?? t('player.qualityNumber', { value });
const waitTimedOut = ref(false),
  replaced = ref(false);
const current = ref(props.room);
watch(
  () => current.value.media,
  (media) => {
    if (
      media?.kind !== 'bilibili' ||
      !playlist.value?.episodes.some(
        (episode) => episode.bvid === media.bvid && episode.part === media.part
      )
    )
      playlist.value = undefined;
  }
);
// Rendered state must be reactive; the adapter itself stays outside reactivity.
const descriptor = shallowRef<MediaDescriptor>();
const host = computed(
  () => current.value.selfMemberId === current.value.hostMemberId
);
const permitted = computed(
  () => host.value || current.value.settings.controllers === 'everyone'
);
const controls = computed(
  () => connected.value && active.value && permitted.value && !uncertain.value
);
const matched = computed(() =>
  mediaMatches(current.value.media, descriptor.value)
);
// One reason, in priority order, explains why room controls are unavailable.
const controlNote = computed(() => {
  if (replaced.value) return t('player.controlReplaced');
  if (!connected.value || !active.value) return t('player.controlReconnecting');
  if (uncertain.value) return t('player.controlUncertain');
  if (!permitted.value) return t('player.controlHost');
  if (!current.value.media)
    return host.value ? t('player.controlSelect') : t('player.controlWait');
  return '';
});
const canPlay = computed(
  () =>
    controls.value && !!current.value.media && matched.value && !loading.value
);
const canControl = computed(() => controls.value && !!current.value.media);
const canReplace = computed(
  () =>
    host.value &&
    !loading.value &&
    connected.value &&
    active.value &&
    !uncertain.value
);
const shownStatus = computed<ReadinessStatus>(() =>
  loading.value ? 'loading' : mediaStatus.value
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
  const seconds = (barrier.targetPositionMs / 1000).toFixed(1);
  const names = blockers.value.map((m) =>
    m.memberId === current.value.selfMemberId
      ? t('common.youLower')
      : m.displayName
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
    uncertain(value) {
      uncertain.value = value;
    },
    ended(reason) {
      if (reason === 'replaced') replaced.value = true;
      else emit('ended', reason);
    },
  },
  probe
);
function clearMedia(): void {
  danmakuMenu.value = false;
  if (qualityOptions.value?.contains(document.activeElement))
    stage.value?.focus({ preventScroll: true });
  qualityMenu.value = false;
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
  local: MediaDescriptor | undefined
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
        : 'play'
  );
}
function clickSurface(event: MouseEvent): void {
  if (event.target !== video.value && event.target !== stage.value) return;
  stage.value?.focus({ preventScroll: true });
  if (danmakuMenu.value || qualityMenu.value) {
    danmakuMenu.value = false;
    qualityMenu.value = false;
    return;
  }
  togglePlayback();
}
async function openQuality(): Promise<void> {
  qualityMenu.value = !qualityMenu.value;
  danmakuMenu.value = false;
  if (qualityMenu.value) {
    await nextTick();
    qualityOptions.value
      ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?.focus();
  }
}
function closeQuality(restoreFocus = false): void {
  qualityMenu.value = false;
  if (restoreFocus) qualityTrigger.value?.focus();
}
function qualityKeyboard(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeQuality(true);
    return;
  }
  const items = Array.from(
    qualityOptions.value?.querySelectorAll<HTMLButtonElement>('button') ?? []
  );
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  let next: number;
  switch (event.key) {
    case 'ArrowDown':
      next = (index + 1) % items.length;
      break;
    case 'ArrowUp':
      next = (index + items.length - 1) % items.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = items.length - 1;
      break;
    case 'Tab':
      closeQuality(true);
      return;
    default:
      return;
  }
  event.preventDefault();
  items[next]?.focus();
}
function outsideQuality(event: PointerEvent): void {
  if (event.target === video.value || event.target === stage.value) return;
  if (
    event.target instanceof Node &&
    !qualityOptions.value?.contains(event.target) &&
    !qualityTrigger.value?.contains(event.target)
  )
    closeQuality();
}
async function fullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await stage.value?.requestFullscreen();
  } catch {
    showError(message('player.fullscreenUnavailable'));
  }
}
function reloadDanmaku(): void {
  if (adapter instanceof BilibiliAdapter) adapter.reloadDanmaku();
}
function showError(value: Message | '', reload = false): void {
  error.value = value;
  errorReload.value = reload;
}
async function chooseBilibili(
  selected: Pick<Episode, 'bvid' | 'part'>,
  publishMedia = false,
  quality?: number
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
      if (adapter === local) showError(failure.text, failure.reload);
    }
  );
  adapter = local;
  danmakuPreferences();
  void sample();
  try {
    const media = await local.load(
      selected.bvid,
      selected.part,
      signal,
      quality ?? preferredQuality.value
    );
    if (signal.aborted || generation !== selectionGeneration) return;
    streamInfo.value = local.mediaInfo;
    playlist.value = local.mediaInfo?.playlist;
    videoTitle.value = local.mediaInfo?.title ?? selected.bvid;
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
  publishMedia = false
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
  }
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
    !playlist.value?.episodes.some(
      (entry) => entry.bvid === episode.bvid && entry.part === episode.part
    )
  )
    return;
  const media = current.value.media;
  if (
    media?.kind === 'bilibili' &&
    media.bvid === episode.bvid &&
    media.part === episode.part
  )
    return;
  await chooseBilibili(episode, true);
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
          : 'player.replay'
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
      wake();
    },
  },
  ...(current.value.media?.kind === 'bilibili'
    ? [
        {
          id: 'danmaku',
          label: t(
            showDanmaku.value ? 'commands.hideDanmaku' : 'player.showDanmaku'
          ),
          group: 'watch' as const,
          icon: showDanmaku.value ? 'chat' : 'chat-off',
          shortcut: '/danmaku',
          aliases: 'comments danmaku 弹幕 显示 隐藏',
          run: toggleDanmaku,
        },
      ]
    : []),
]);
defineExpose({ commands, playlist, canReplace, selectEpisode });
async function changeQuality(quality: number): Promise<void> {
  const selected = current.value.media;
  if (
    selected?.kind !== 'bilibili' ||
    !streamInfo.value?.qualities.includes(quality) ||
    loading.value
  )
    return;
  closeQuality(true);
  preferredQuality.value = quality;
  if (streamInfo.value.quality === quality) return;
  await chooseBilibili(selected, false, quality);
}
function hoverSeek(event: PointerEvent): void {
  const box = event.currentTarget as HTMLElement;
  hoveredTime.value = Math.max(
    0,
    Math.min(
      totalSeconds.value,
      ((event.clientX - box.getBoundingClientRect().left) / box.clientWidth) *
        totalSeconds.value
    )
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
  if (
    event.defaultPrevented ||
    document.visibilityState !== 'visible' ||
    event.isComposing ||
    event.keyCode === 229 ||
    (event.target instanceof Element &&
      event.target.closest(
        'input, select, textarea, [contenteditable], [role="menu"], [role="tablist"], dialog, [role="dialog"]'
      )) ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return;
  const key = event.key.toLowerCase();
  if (
    key === ' ' &&
    event.target instanceof Element &&
    event.target.closest('button, a')
  )
    return;
  if (key === ' ' || key === 'k') {
    event.preventDefault();
    togglePlayback();
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault();
    seekSeconds.value = Math.min(
      totalSeconds.value,
      Math.max(0, position.value + (event.key === 'ArrowLeft' ? -5 : 5))
    );
    command('seek');
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    volume.value = Math.max(
      0,
      Math.min(
        1,
        Math.round(volume.value * 100 + (event.key === 'ArrowUp' ? 10 : -10)) /
          100
      )
    );
    muted.value = false;
  } else if (key === 'm') {
    event.preventDefault();
    muted.value = !muted.value;
  } else if (key === 'd' && current.value.media?.kind === 'bilibili') {
    event.preventDefault();
    toggleDanmaku();
  } else if (key === 'f') {
    event.preventDefault();
    void fullscreen();
  } else return;
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
      now
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
        active.value && transport.connected && matched
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
        showError(message('player.applyFailed'));
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
      : { action }
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
      if (local.getState().status !== 'gesture_required')
        heading.value?.focus();
      return;
    }
    showError(
      local.getState().status === 'gesture_required'
        ? message('player.blocked')
        : message('player.decodeFailed')
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
  transport.start();
  timer = setInterval(() => {
    void sample();
  }, 250);
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('keydown', keyboard);
  document.addEventListener('pointerdown', outsideQuality);
});
onUnmounted(() => {
  disposed = true;
  clearInterval(timer);
  clearTimeout(idleTimer);
  handoff = undefined;
  document.removeEventListener('visibilitychange', visibility);
  document.removeEventListener('keydown', keyboard);
  document.removeEventListener('pointerdown', outsideQuality);
  transport.dispose();
  clearMedia();
});
</script>

<template>
  <section class="player-panel" aria-labelledby="player-title">
    <h3 id="player-title" ref="heading" class="visually-hidden" tabindex="-1">
      {{ t('common.watchTogether') }}
    </h3>
    <div
      ref="stage"
      class="video-stage"
      :class="{
        'controls-idle': idle && isPlaying && !danmakuMenu && !qualityMenu,
      }"
      tabindex="0"
      :aria-label="t('player.shortcuts')"
      @click="clickSurface"
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
        :aria-label="t('player.roomVideo')"
      />
      <div ref="overlay" class="danmaku-overlay" aria-hidden="true" />
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
      <div v-else-if="mediaStatus === 'gesture_required'" class="player-state">
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
        v-else-if="
          loading || (!descriptor && current.media?.kind === 'bilibili')
        "
        class="player-state"
      >
        <Icon name="screen" :size="36" />
        <h3>
          {{ loading ? t('common.preparingVideo') : t('player.connectHelper') }}
        </h3>
        <p>
          {{ loading ? t('player.preparingHint') : t('player.helperHint') }}
        </p>
        <button v-if="!loading" class="quiet" @click="retryMedia">
          {{ t('player.retryVideo') }}
        </button>
      </div>
      <div v-else-if="current.playback.phase === 'ended'" class="player-state">
        <h3>{{ t('player.again') }}</h3>
        <button :disabled="!canControl" @click="command('replay')">
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
        :disabled="!active || !connected || !!uncertain"
        :aria-label="t('player.selectMatching')"
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
        <div
          class="seek-track"
          @pointermove="hoverSeek"
          @pointerleave="hoveredTime = undefined"
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
              :disabled="isPlaying ? !canControl : !canPlay"
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
                :size="22"
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
              :status="translate(danmakuStatus)"
              :stage="stage"
              @update:open="
                (value) => {
                  danmakuMenu = value;
                  if (value) closeQuality();
                }
              "
              @toggle="toggleDanmaku"
              @reload="reloadDanmaku"
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
            />
            <button
              v-if="current.media?.kind === 'bilibili'"
              ref="qualityTrigger"
              class="quality-trigger quiet"
              :aria-label="t('player.videoQuality')"
              aria-haspopup="menu"
              aria-controls="video-quality"
              :disabled="!streamInfo || loading"
              :aria-expanded="qualityMenu"
              @click="openQuality"
              @keydown.down.prevent="!qualityMenu && openQuality()"
            >
              {{
                streamInfo
                  ? qualityName(streamInfo.quality)
                  : t('player.quality')
              }}<Icon name="chevron" :size="14" />
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
      <div
        v-if="qualityMenu && streamInfo"
        id="video-quality"
        ref="qualityOptions"
        class="player-menu quality-menu"
        role="menu"
        :aria-label="t('player.videoQuality')"
        @keydown.stop="qualityKeyboard"
      >
        <button
          v-for="q in [...streamInfo.qualities].sort((a, b) => b - a)"
          :key="q"
          type="button"
          role="menuitemradio"
          class="quiet"
          tabindex="-1"
          :aria-checked="streamInfo.quality === q"
          @click="changeQuality(q)"
        >
          <span>{{ qualityName(q) }}</span
          ><Icon v-if="streamInfo.quality === q" name="check" :size="16" />
        </button>
      </div>
    </div>
    <div class="video-information">
      <div class="video-description">
        <span class="source-label">{{
          current.media?.kind === 'local'
            ? t('common.localFileLabel')
            : t('media.bilibiliLabel')
        }}</span>
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
        <p v-if="controlNote" id="control-note" class="hint">
          {{ controlNote }}
        </p>
      </div>
      <button
        v-if="host"
        class="quiet change-media"
        :disabled="!canReplace"
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
    <div v-if="uncertain" class="notice" role="status">
      <span>{{ t('player.checkingCommand') }}</span
      ><button :disabled="!connected" @click="transport.resolveUncertain()">
        {{ t('player.checkOriginal') }}
      </button>
    </div>
    <p v-if="waitTimedOut" class="notice" role="status">
      {{ t('player.waitTimeout') }}
      {{ permitted ? t('player.retryPlay') : t('player.hostRetry') }}
    </p>
    <Modal
      v-if="replaceOpen"
      :title="t('player.changeTitle')"
      @close="replaceOpen = false"
      @keydown.enter="confirmMedia"
      ><form @submit.prevent="replaceMedia">
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
