import type { MediaDescriptor } from '../../transport/contracts';
import { LocalAdapter, type PlayerAdapter, type PlayerObservation } from '../adapters/local';
import { exact, HelperBridge, HelperError, object } from './bridge';
import { decodeInfo, parseIndex, type MediaInfo, type Segment } from './media';
import { DanmakuRenderer, decodeComments } from './danmaku';
interface Track {
  index: number;
  buffer: SourceBuffer;
  segments: Segment[];
}
export class BilibiliAdapter implements PlayerAdapter {
  readonly capabilities;
  readonly danmaku: DanmakuRenderer;
  private native: LocalAdapter;
  private bridge = new HelperBridge();
  private lifetime = new AbortController();
  private info: MediaInfo | undefined;
  private source: MediaSource | undefined;
  private url: string | undefined;
  private tracks: Track[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private pumping = false;
  private seekGeneration = 0;
  private dmSegment = 0;
  private dmRequest = 0;
  private disposed = false;
  private loading = true;
  private failure: HelperError | undefined;
  private readonly generation = 1;
  constructor(
    private video: HTMLVideoElement,
    overlay: HTMLElement,
    private onDanmaku: (status: string) => void,
    private onError: (failure: HelperError) => void,
  ) {
    this.native = new LocalAdapter(video);
    this.capabilities = { ...this.native.capabilities, canShowDanmaku: true };
    this.danmaku = new DanmakuRenderer(video, overlay);
    video.addEventListener(
      'seeking',
      () => {
        this.seekGeneration++;
        this.dmRequest++;
        this.dmSegment = 0;
        this.danmaku.clear();
      },
      { signal: this.lifetime.signal },
    );
  }
  async load(bvid: string, part: number, signal: AbortSignal): Promise<MediaDescriptor> {
    const abort = () => this.dispose();
    signal.addEventListener('abort', abort, { once: true });
    this.lifetime.signal.addEventListener(
      'abort',
      () => signal.removeEventListener('abort', abort),
      { once: true },
    );
    if (signal.aborted) this.dispose();
    try {
      await this.bridge.hello();
      this.assertOwned();
      this.info = decodeInfo(
        await this.bridge.call('open', { bvid, part, generation: this.generation }),
        bvid,
        part,
      );
      this.assertOwned();
      if (typeof MediaSource === 'undefined') throw new HelperError('unsupported-codec');
      const source = new MediaSource();
      this.source = source;
      const opened = this.wait(source, 'sourceopen');
      this.url = URL.createObjectURL(source);
      this.video.src = this.url;
      await opened;
      this.assertOwned();
      source.duration = this.info.duration;
      // Both buffers must exist before appending initialization data (Firefox).
      const buffers = this.info.tracks.map((t) => {
        const mime = `${t.mime}; codecs="${t.codec}"`;
        if (!MediaSource.isTypeSupported(mime)) throw new HelperError('unsupported-codec');
        return source.addSourceBuffer(mime);
      });
      const initialization: { buffer: SourceBuffer; data: Uint8Array<ArrayBuffer> }[] = [];
      for (const [index, track] of this.info.tracks.entries()) {
        const buffer = buffers[index]!;
        const data = await this.bytes(index, track.init[0], track.init[1] - track.init[0] + 1);
        const indexData = await this.bytes(
          index,
          track.index[0],
          track.index[1] - track.index[0] + 1,
        );
        this.assertOwned();
        this.tracks.push({ index, buffer, segments: parseIndex(indexData, track.index[0]) });
        initialization.push({ buffer, data });
      }
      await Promise.all(
        initialization.map(({ buffer, data }) =>
          this.update(buffer, () => buffer.appendBuffer(data)),
        ),
      );
      await this.pump();
      this.assertOwned();
      this.loading = false;
      this.timer = setInterval(() => {
        void this.pump().catch((e: unknown) => this.fail(e));
      }, 250);
      return {
        kind: 'bilibili',
        bvid,
        cid: this.info.cid,
        part,
        durationMs: Math.round(this.info.duration * 1000),
      };
    } catch (error) {
      this.fail(error);
      throw error instanceof HelperError || error instanceof DOMException
        ? error
        : new HelperError('invalid-media');
    }
  }
  private assertOwned(): void {
    if (this.disposed) throw new DOMException('Cancelled', 'AbortError');
  }
  private fail(error: unknown): void {
    if (this.disposed || (error instanceof DOMException && error.name === 'AbortError')) return;
    this.failure = error instanceof HelperError ? error : new HelperError('invalid-media');
    this.loading = false;
    this.video.pause();
    clearInterval(this.timer);
    this.onError(this.failure);
    this.dispose();
  }
  private async bytes(
    track: number,
    offset: number,
    length: number,
    seek = this.seekGeneration,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (length < 1 || length > 4 * 1024 * 1024) throw new HelperError('segment-limit');
    const output = new Uint8Array(length);
    for (let at = 0; at < length; at += 256 * 1024) {
      this.assertOwned();
      if (seek !== this.seekGeneration) throw new DOMException('Seek cancelled', 'AbortError');
      const count = Math.min(256 * 1024, length - at);
      let reply: Record<string, unknown>;
      for (let attempt = 0; ; attempt++) {
        try {
          reply = object(
            await this.bridge.call('bytes', {
              handle: this.info!.handle,
              track,
              offset: offset + at,
              length: count,
              generation: this.generation,
            }),
          );
          break;
        } catch (error) {
          if (
            !(error instanceof HelperError) ||
            !['busy', 'rate-limited'].includes(error.code) ||
            attempt >= 3
          )
            throw error;
          await this.delay(250 * 2 ** attempt);
        }
      }
      this.assertOwned();
      if (seek !== this.seekGeneration) throw new DOMException('Seek cancelled', 'AbortError');
      exact(reply, ['base64']);
      if (
        typeof reply.base64 !== 'string' ||
        reply.base64.length > 349528 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(reply.base64)
      )
        throw new HelperError('invalid-bytes');
      const chunk = atob(reply.base64);
      if (chunk.length !== count) throw new HelperError('invalid-bytes');
      for (let i = 0; i < count; i++) output[at + i] = chunk.charCodeAt(i);
    }
    return output;
  }
  private wait(target: EventTarget, event: string, operation?: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        target.removeEventListener(event, done);
        target.removeEventListener('error', fail);
        this.lifetime.signal.removeEventListener('abort', abort);
      };
      const done = () => {
          cleanup();
          resolve();
        },
        fail = () => {
          cleanup();
          reject(new HelperError('source-buffer-failed'));
        },
        abort = () => {
          cleanup();
          reject(new DOMException('Cancelled', 'AbortError'));
        };
      const timer = setTimeout(fail, 5000);
      target.addEventListener(event, done, { once: true });
      target.addEventListener('error', fail, { once: true });
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      if (this.disposed) {
        abort();
        return;
      }
      try {
        operation?.();
      } catch {
        fail();
      }
    });
  }
  private update(buffer: SourceBuffer, operation: () => void): Promise<void> {
    return this.wait(buffer, 'updateend', operation);
  }
  private delay(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      const timer = setTimeout(() => {
        this.lifetime.signal.removeEventListener('abort', abort);
        resolve();
      }, ms);
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      if (this.disposed) abort();
    });
  }
  private contains(buffer: SourceBuffer, time: number): boolean {
    for (let i = 0; i < buffer.buffered.length; i++)
      if (buffer.buffered.start(i) <= time + 0.05 && buffer.buffered.end(i) > time + 0.1)
        return true;
    return false;
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.disposed || this.failure || !this.tracks.length) return;
    this.pumping = true;
    try {
      const target = this.video.currentTime,
        seek = this.seekGeneration;
      for (const horizon of [1, 12])
        for (const track of this.tracks) {
          this.assertOwned();
          if (!track.buffer.updating && track.buffer.buffered.length) {
            const end = track.buffer.buffered.end(track.buffer.buffered.length - 1);
            if (target > 20 && track.buffer.buffered.start(0) < target - 20)
              await this.update(track.buffer, () => track.buffer.remove(0, target - 15));
            if (end > target + 40)
              await this.update(track.buffer, () => track.buffer.remove(target + 30, end));
          }
          for (const segment of track.segments) {
            if (
              segment.end <= target ||
              segment.time > target + horizon ||
              this.contains(
                track.buffer,
                Math.min(segment.end - 0.3, Math.max(segment.time + 0.5, target)),
              )
            )
              continue;
            const data = await this.bytes(track.index, segment.offset, segment.length, seek);
            this.assertOwned();
            if (seek !== this.seekGeneration) return;
            await this.update(track.buffer, () => track.buffer.appendBuffer(data));
          }
        }
      if (
        this.info &&
        this.video.currentTime > this.info.duration - 15 &&
        this.tracks.every((t) => this.contains(t.buffer, this.info!.duration - 0.3)) &&
        this.source?.readyState === 'open'
      )
        this.source.endOfStream();
      void this.loadDanmaku();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
    } finally {
      this.pumping = false;
    }
  }
  private async loadDanmaku(): Promise<void> {
    if (!this.info || this.disposed) return;
    const segment = Math.min(
      Math.ceil(this.info.duration / 360),
      Math.floor(this.video.currentTime / 360) + 1,
    );
    if (segment === this.dmSegment) return;
    this.dmSegment = segment;
    const request = ++this.dmRequest;
    this.onDanmaku('Loading danmaku…');
    try {
      const reply = await this.bridge.call('danmaku', {
        handle: this.info.handle,
        segment,
        generation: this.generation,
      });
      if (this.disposed || request !== this.dmRequest) return;
      this.danmaku.comments = decodeComments(reply, this.info.duration);
      this.onDanmaku(
        this.danmaku.comments.length ? 'Danmaku loaded' : 'No danmaku in this segment',
      );
    } catch {
      if (!this.disposed && request === this.dmRequest) {
        this.danmaku.clear();
        this.onDanmaku('Danmaku unavailable. Reload danmaku to retry.');
      }
    }
  }
  reloadDanmaku(): void {
    this.dmSegment = 0;
    void this.loadDanmaku();
  }
  play(): Promise<void> {
    return this.native.play();
  }
  pause(): Promise<void> {
    return this.native.pause();
  }
  seek(positionMs: number): Promise<void> {
    return this.native.seek(positionMs);
  }
  setPlaybackRate(rate: number): Promise<void> {
    return this.native.setPlaybackRate(rate);
  }
  getState(): PlayerObservation {
    return {
      ...this.native.getState(),
      ...(this.loading
        ? { status: 'loading' as const }
        : this.failure
          ? { status: this.failure.status }
          : {}),
    };
  }
  subscribe(listener: () => void): () => void {
    return this.native.subscribe(listener);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    clearInterval(this.timer);
    this.dmRequest++;
    this.bridge.close(this.generation + 1);
    this.danmaku.dispose();
    for (const track of this.tracks) {
      try {
        if (track.buffer.updating) track.buffer.abort();
      } catch {
        /* The source can already be closed. */
      }
    }
    this.native.dispose();
    if (this.url) URL.revokeObjectURL(this.url);
    this.tracks = [];
    this.info = undefined;
    this.source = undefined;
    this.url = undefined;
  }
}
