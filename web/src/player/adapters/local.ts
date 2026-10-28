import type { PlayerCapabilities, ReadinessStatus } from '../../transport/protocol-values';
export interface PlayerObservation {
  positionMs: number;
  durationMs: number;
  paused: boolean;
  seeking: boolean;
  status: ReadinessStatus;
}
export interface PlayerAdapter {
  readonly capabilities: PlayerCapabilities;
  load(file: File, signal: AbortSignal): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(positionMs: number): Promise<void>;
  setPlaybackRate?(rate: number): Promise<void>;
  getState(): PlayerObservation;
  subscribe(listener: () => void): () => void;
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
  private disposed = false;
  private lifetime = new AbortController();
  private status: ReadinessStatus = 'no_media';
  private listeners = new Set<() => void>();
  constructor(private video: HTMLVideoElement) {
    for (const event of [
      'loadeddata',
      'canplay',
      'playing',
      'waiting',
      'stalled',
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
          if (event === 'error') this.status = 'unsupported';
          else if (event === 'waiting' || event === 'stalled') this.status = 'buffering';
          else if (['canplay', 'playing', 'seeked', 'loadeddata'].includes(event))
            this.status = 'ready';
          for (const listener of this.listeners) listener();
        },
        { signal: this.lifetime.signal },
      );
  }
  async load(file: File, signal: AbortSignal): Promise<void> {
    this.status = 'loading';
    this.url = URL.createObjectURL(file);
    this.video.src = this.url;
    await this.wait('loadeddata', signal);
    if (this.disposed || signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const duration = this.video.duration * 1000;
    if (
      !Number.isFinite(duration) ||
      duration < 1 ||
      duration > 604800000 ||
      this.video.videoWidth === 0
    ) {
      this.status = 'unsupported';
      throw new Error(
        'This browser cannot decode this file or determine its duration. Select a supported video.',
      );
    }
    this.status = 'ready';
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
      if (!this.disposed)
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
    if (Math.abs(this.video.currentTime * 1000 - positionMs) < 20 && !this.video.seeking) return;
    const completed = this.wait('seeked', this.lifetime.signal);
    this.video.currentTime = positionMs / 1000;
    await completed;
  }
  async setPlaybackRate(rate: number): Promise<void> {
    if (!this.disposed) this.video.playbackRate = rate;
  }
  getState(): PlayerObservation {
    return {
      positionMs: Math.max(0, Math.round(this.video.currentTime * 1000)),
      durationMs: Number.isFinite(this.video.duration) ? Math.round(this.video.duration * 1000) : 0,
      paused: this.video.paused,
      seeking: this.video.seeking,
      status:
        this.status === 'ready' && this.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA
          ? 'buffering'
          : this.status,
    };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.listeners.clear();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = undefined;
  }
  private wait(event: string, signal: AbortSignal): Promise<void> {
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
          reject(new Error('This browser cannot decode this video.'));
        },
        abort = () => {
          cleanup();
          reject(new DOMException('Cancelled', 'AbortError'));
        };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('The local video did not become ready. Select the file again.'));
      }, 15000);
      this.video.addEventListener(event, done, { once: true });
      this.video.addEventListener('error', fail, { once: true });
      signal.addEventListener('abort', abort, { once: true });
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted || this.lifetime.signal.aborted) abort();
    });
  }
}
