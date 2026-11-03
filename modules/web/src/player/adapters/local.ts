import { LocalizedError, message } from '../../i18n';
import type {
  PlayerCapabilities,
  ReadinessStatus,
} from '../../transport/protocol-values';
import { forwardBuffer, type PlayerStatistics } from '../statistics';
import { LocalThumbnails } from '../thumbnails';

export interface PlayerObservation {
  positionMs: number;
  durationMs: number;
  paused: boolean;
  seeking: boolean;
  status: ReadinessStatus;
}
export interface PlayerAdapter {
  readonly capabilities: PlayerCapabilities;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setPlaybackRate?(rate: number): Promise<void>;
  getState(): PlayerObservation;
  getStatistics?(): PlayerStatistics | Promise<PlayerStatistics>;
  subscribe(listener: () => void): () => void;
  drawThumbnail?(
    positionMs: number,
    canvas: HTMLCanvasElement,
    signal: AbortSignal,
  ): Promise<boolean>;
  dispose(): void;
}
export class LocalAdapter implements PlayerAdapter {
  readonly capabilities: PlayerCapabilities = {
    canPlay: true,
    canPause: true,
    canSeek: true,
    canReadPosition: true,
    canSetPlaybackRate: true,
    canDetectBuffering: true,
    canShowDanmaku: false,
    positionResolutionMs: 40,
  };
  private url: string | undefined;
  private thumbnails: LocalThumbnails | undefined;
  private disposed = false;
  private lifetime = new AbortController();
  private seekController: AbortController | undefined;
  private status: ReadinessStatus = 'no_media';
  private listeners = new Set<() => void>();
  private frameSample: { position: number; frames: number } | undefined;
  private estimatedFrameRate: number | undefined;
  constructor(private video: HTMLVideoElement) {
    for (const event of [
      'loadeddata',
      'canplay',
      'playing',
      'waiting',
      'error',
      'pause',
      'seeked',
      'seeking',
      'ended',
    ])
      video.addEventListener(
        event,
        () => {
          if (this.disposed) return;
          if (event === 'seeking') this.frameSample = undefined;
          if (event === 'error') this.status = 'unsupported';
          // Only waiting means playback lacks data. Firefox fires stalled for MediaSource when
          // appends pause with enough data buffered, and no event would clear that state.
          else if (event === 'waiting') this.status = 'buffering';
          else if (
            ['canplay', 'playing', 'seeked', 'loadeddata'].includes(event)
          )
            this.status = 'ready';
          for (const listener of this.listeners) listener();
        },
        { signal: this.lifetime.signal },
      );
  }
  async load(file: File, signal: AbortSignal): Promise<void> {
    this.frameSample = undefined;
    this.estimatedFrameRate = undefined;
    this.status = 'loading';
    this.url = URL.createObjectURL(file);
    this.thumbnails = new LocalThumbnails(this.url);
    this.video.src = this.url;
    await this.wait('loadeddata', signal);
    if (this.disposed || signal.aborted)
      throw new DOMException('Cancelled', 'AbortError');
    const duration = this.video.duration * 1000;
    if (
      !Number.isFinite(duration) ||
      duration < 1 ||
      duration > 604800000 ||
      this.video.videoWidth === 0
    ) {
      this.status = 'unsupported';
      throw new LocalizedError(message('local.unsupported'));
    }
    this.status = 'ready';
  }
  getStatistics(): PlayerStatistics {
    if (this.disposed) throw new DOMException('Disposed', 'AbortError');
    const snapshot: PlayerStatistics = {
      bufferAheadSeconds: forwardBuffer(this.video),
      ...(this.video.videoWidth > 0 && this.video.videoHeight > 0
        ? { width: this.video.videoWidth, height: this.video.videoHeight }
        : {}),
    };
    if (typeof this.video.getVideoPlaybackQuality === 'function') {
      const quality = this.video.getVideoPlaybackQuality(),
        frames = quality.totalVideoFrames - quality.droppedVideoFrames,
        position = this.video.currentTime,
        previous = this.frameSample;
      this.frameSample = { position, frames };
      if (
        previous &&
        !this.video.paused &&
        !this.video.seeking &&
        position > previous.position &&
        position - previous.position <= 3 &&
        frames > previous.frames
      ) {
        const rate =
          (frames - previous.frames) / (position - previous.position);
        if (Number.isFinite(rate) && rate > 0 && rate <= 1000)
          this.estimatedFrameRate = rate;
      }
    }
    if (this.estimatedFrameRate !== undefined) {
      snapshot.frameRate = this.estimatedFrameRate;
      snapshot.frameRateEstimated = true;
    }
    return snapshot;
  }
  async play(): Promise<void> {
    if (this.disposed) throw new DOMException('Disposed', 'AbortError');
    const ownedURL = this.url;
    try {
      await this.video.play();
      if (this.disposed) {
        if (this.video.getAttribute('src') === ownedURL) this.video.pause();
        throw new DOMException('Disposed', 'AbortError');
      }
      this.status = 'ready';
    } catch (error) {
      // A pause or a new source cancels a pending play with AbortError; the media stays usable.
      if (
        !this.disposed &&
        !(error instanceof DOMException && error.name === 'AbortError')
      )
        this.status =
          error instanceof DOMException && error.name === 'NotAllowedError'
            ? 'gesture_required'
            : 'error';
      throw error;
    }
  }
  async pause(): Promise<void> {
    if (!this.disposed) this.video.pause();
  }
  async seek(positionMs: number): Promise<void> {
    if (this.disposed) throw new DOMException('Disposed', 'AbortError');
    this.seekController?.abort();
    this.seekController = undefined;
    if (
      Math.abs(this.video.currentTime * 1000 - positionMs) < 20 &&
      !this.video.seeking
    )
      return;
    const controller = new AbortController();
    this.seekController = controller;
    try {
      await this.wait('seeked', controller.signal, () => {
        this.video.currentTime = positionMs / 1000;
      });
    } finally {
      if (this.seekController === controller) this.seekController = undefined;
    }
  }
  async setPlaybackRate(rate: number): Promise<void> {
    if (!this.disposed) this.video.playbackRate = rate;
  }
  getState(): PlayerObservation {
    return {
      positionMs: Math.max(0, Math.round(this.video.currentTime * 1000)),
      durationMs: Number.isFinite(this.video.duration)
        ? Math.round(this.video.duration * 1000)
        : 0,
      paused: this.video.paused,
      seeking: this.video.seeking,
      status:
        this.status === 'ready' &&
        this.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
          ? 'buffering'
          : this.status,
    };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async drawThumbnail(
    positionMs: number,
    canvas: HTMLCanvasElement,
    signal: AbortSignal,
  ): Promise<boolean> {
    return (
      !this.disposed &&
      ((await this.thumbnails?.draw(positionMs, canvas, signal)) ?? false)
    );
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.thumbnails?.dispose();
    this.thumbnails = undefined;
    this.listeners.clear();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
  }
  private wait(
    event: string,
    signal: AbortSignal,
    operation?: () => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.video.removeEventListener(event, done);
        this.video.removeEventListener('error', fail);
        signal.removeEventListener('abort', abort);
        this.lifetime.signal.removeEventListener('abort', abort);
      };
      const done = () => {
          cleanup();
          resolve();
        },
        fail = () => {
          cleanup();
          reject(new LocalizedError(message('local.decodeFailed')));
        },
        abort = () => {
          cleanup();
          reject(new DOMException('Cancelled', 'AbortError'));
        };
      // MediaSource seeks can need more data than an initial local-file load.
      // Wait for playable data; replacement, disposal, and media errors still cancel the wait.
      const timer =
        event === 'seeked'
          ? undefined
          : setTimeout(() => {
              cleanup();
              reject(new LocalizedError(message('local.notReady')));
            }, 15000);
      this.video.addEventListener(event, done, { once: true });
      this.video.addEventListener('error', fail, { once: true });
      signal.addEventListener('abort', abort, { once: true });
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted || this.lifetime.signal.aborted) {
        abort();
        return;
      }
      try {
        operation?.();
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }
}
