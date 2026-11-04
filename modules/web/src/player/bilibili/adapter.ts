import { message, type Message } from '../../i18n';
import type { MediaDescriptor } from '../../transport/contracts';
import {
  LocalAdapter,
  type PlayerAdapter,
  type PlayerObservation,
} from '../adapters/local';
import type { PlayerStatistics } from '../statistics';
import { exact, HelperBridge, HelperError, object } from './bridge';
import { DanmakuRenderer, decodeComments } from './danmaku';
import { decodeInfo, parseIndex, type MediaInfo, type Segment } from './media';
import { BilibiliThumbnails } from './thumbnails';

const CHUNK_BYTES = 256 * 1024;
interface Track {
  index: number;
  buffer: SourceBuffer;
  segments: Segment[];
  delay: number;
  measuredAt: number;
  read?:
    | {
        offset: number;
        seek: number;
        result: Promise<{ data: Uint8Array<ArrayBuffer> } | { error: unknown }>;
      }
    | undefined;
  appended?: { seek: number; end: number };
  pending?:
    | {
        segment: Segment;
        at: number;
        seek: number;
        data?: Uint8Array<ArrayBuffer> | undefined;
      }
    | undefined;
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
  private timer?: ReturnType<typeof setTimeout>;
  private pumping = false;
  private seekGeneration = 0;
  private dmSegment = 0;
  private dmRequest = 0;
  private disposed = false;
  private loading = true;
  private failure: HelperError | undefined;
  private readonly generation = 1;
  private networkSample: { bytes: number; at: number } | undefined;
  private readonly thumbnails = new BilibiliThumbnails(
    this.bridge,
    this.generation,
    () => this.onThumbnail(),
  );
  constructor(
    private video: HTMLVideoElement,
    overlay: HTMLElement,
    private onDanmaku: (status: Message) => void,
    private onError: (failure: HelperError) => void,
    private onThumbnail: () => void = () => {},
  ) {
    this.native = new LocalAdapter(video);
    this.capabilities = { ...this.native.capabilities, canShowDanmaku: true };
    this.danmaku = new DanmakuRenderer(video, overlay);
    video.addEventListener(
      'seeking',
      () => {
        this.seekGeneration++;
        for (const track of this.tracks) track.read = undefined;
        if (this.info)
          this.bridge.seek(
            this.info.handle,
            this.generation,
            this.seekGeneration,
          );
        this.danmaku.reset();
        void this.loadDanmaku(true);
      },
      { signal: this.lifetime.signal },
    );
  }
  async load(
    bvid: string,
    part: number,
    signal: AbortSignal,
    quality?: number,
    episodeId?: string,
  ): Promise<MediaDescriptor> {
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
        await this.bridge.call('open', {
          bvid,
          part,
          ...(episodeId ? { episodeId } : {}),
          generation: this.generation,
          ...(quality ? { quality } : {}),
        }),
        bvid,
        part,
        episodeId,
      );
      this.assertOwned();
      if (typeof MediaSource === 'undefined')
        throw new HelperError('unsupported-codec');
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
        if (!MediaSource.isTypeSupported(mime))
          throw new HelperError('unsupported-codec');
        return source.addSourceBuffer(mime);
      });
      const initialization: {
        buffer: SourceBuffer;
        data: Uint8Array<ArrayBuffer>;
      }[] = [];
      for (const [index, track] of this.info.tracks.entries()) {
        const buffer = buffers[index]!;
        const data = await this.bytes(
          index,
          track.init[0],
          track.init[1] - track.init[0] + 1,
        );
        const indexData = await this.bytes(
          index,
          track.index[0],
          track.index[1] - track.index[0] + 1,
        );
        this.assertOwned();
        this.tracks.push({
          index,
          buffer,
          segments: parseIndex(indexData, track.index[0]),
          delay: 0,
          measuredAt: performance.now(),
        });
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
      this.schedule(0);
      this.thumbnails.start(this.info.handle);
      return {
        kind: 'bilibili',
        bvid,
        ...(this.info.episodeId ? { episodeId: this.info.episodeId } : {}),
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
  get mediaInfo(): MediaInfo | undefined {
    return this.info;
  }
  async getStatistics(): Promise<PlayerStatistics> {
    this.assertOwned();
    const info = this.info;
    const snapshot = this.native.getStatistics();
    if (!info) return snapshot;
    const videoTrack = info.tracks[0]!,
      audioTrack = info.tracks[1]!;
    snapshot.videoCodec = videoTrack.codec;
    snapshot.audioCodec = audioTrack.codec;
    if (videoTrack.bitrate !== undefined)
      snapshot.videoBitrate = videoTrack.bitrate;
    if (audioTrack.bitrate !== undefined)
      snapshot.audioBitrate = audioTrack.bitrate;
    if (videoTrack.frameRate !== undefined) {
      snapshot.frameRate = videoTrack.frameRate;
      snapshot.frameRateEstimated = false;
    }
    for (const track of this.tracks) {
      const segments = track.segments;
      if (!segments.length) continue;
      const current = segments.findIndex(
        (segment) => this.video.currentTime < segment.end,
      );
      const progress = {
        current: current < 0 ? segments.length : current + 1,
        total: segments.length,
      };
      if (track.index === 0) snapshot.videoSegment = progress;
      else snapshot.audioSegment = progress;
    }
    try {
      const reply = object(
        await this.bridge.call('statistics', {
          handle: info.handle,
          generation: this.generation,
        }),
      );
      this.assertOwned();
      exact(reply, ['downloadedBytes', 'sampledAtMs']);
      const bytes =
        typeof reply.downloadedBytes === 'number' &&
        Number.isSafeInteger(reply.downloadedBytes) &&
        reply.downloadedBytes >= 0
          ? reply.downloadedBytes
          : undefined;
      const at =
        typeof reply.sampledAtMs === 'number' &&
        Number.isFinite(reply.sampledAtMs) &&
        reply.sampledAtMs <= Number.MAX_SAFE_INTEGER &&
        reply.sampledAtMs >= 0
          ? reply.sampledAtMs
          : undefined;
      if (bytes === undefined || at === undefined)
        throw new HelperError('invalid-reply');
      const previous = this.networkSample;
      this.networkSample = { bytes, at };
      if (
        previous &&
        at > previous.at &&
        at - previous.at <= 3000 &&
        bytes >= previous.bytes
      )
        snapshot.downloadBytesPerSecond =
          ((bytes - previous.bytes) * 1000) / (at - previous.at);
    } catch {
      this.assertOwned();
      this.networkSample = undefined;
    }
    return snapshot;
  }
  async drawThumbnail(
    positionMs: number,
    canvas: HTMLCanvasElement,
    signal: AbortSignal,
  ): Promise<boolean> {
    return (
      !!this.info &&
      !this.disposed &&
      this.thumbnails.draw(positionMs, canvas, signal)
    );
  }
  private assertOwned(): void {
    if (this.disposed) throw new DOMException('Cancelled', 'AbortError');
  }
  private assertSeek(seek: number): void {
    this.assertOwned();
    if (seek !== this.seekGeneration)
      throw new DOMException('Seek cancelled', 'AbortError');
  }
  private fail(error: unknown): void {
    if (
      this.disposed ||
      (error instanceof DOMException && error.name === 'AbortError')
    )
      return;
    this.failure =
      error instanceof HelperError ? error : new HelperError('invalid-media');
    this.loading = false;
    this.video.pause();
    clearTimeout(this.timer);
    this.onError(this.failure);
    this.dispose();
  }
  private async bytes(
    track: number,
    offset: number,
    length: number,
    seek = this.seekGeneration,
    segment?: Segment,
  ): Promise<Uint8Array<ArrayBuffer>> {
    if (length < 1 || length > CHUNK_BYTES)
      throw new HelperError('segment-limit');
    let reply: Record<string, unknown>;
    const started = performance.now();
    for (let attempt = 0; ; attempt++) {
      this.assertSeek(seek);
      try {
        reply = object(
          await this.bridge.call('bytes', {
            handle: this.info!.handle,
            track,
            offset,
            length,
            generation: this.generation,
            seek,
            ...(segment
              ? {
                  end: segment.offset + segment.length - 1,
                  rate: Math.min(
                    128 * 1024 * 1024,
                    Math.max(
                      1,
                      Math.ceil(segment.length / (segment.end - segment.time)),
                    ),
                  ),
                }
              : {}),
          }),
        );
        break;
      } catch (error) {
        this.assertSeek(seek);
        if (
          !(error instanceof HelperError) ||
          (![
            'busy',
            'rate-limited',
            'network-or-permission-denied',
            'request-timeout',
            'http-408',
          ].includes(error.code) &&
            !/^http-5[0-9]{2}$/.test(error.code)) ||
          attempt >= 3
        )
          throw error;
        await this.delay(250 * 2 ** attempt);
      }
    }
    this.assertSeek(seek);
    const trackState = this.tracks.find((state) => state.index === track);
    if (trackState && segment) {
      const now = performance.now();
      trackState.delay = Math.max(
        (now - started) / 1000,
        trackState.delay * Math.exp(-(now - trackState.measuredAt) / 30000),
      );
      trackState.measuredAt = now;
    }
    exact(reply, ['base64']);
    if (
      typeof reply.base64 !== 'string' ||
      reply.base64.length > 349528 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(reply.base64)
    )
      throw new HelperError('invalid-bytes');
    const chunk = atob(reply.base64);
    if (chunk.length !== length) throw new HelperError('invalid-bytes');
    const output = new Uint8Array(length);
    for (let i = 0; i < length; i++) output[i] = chunk.charCodeAt(i);
    return output;
  }
  private wait(
    target: EventTarget,
    event: string,
    operation?: () => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let started: number | undefined;
      let remaining = 5000;
      // Browsers can defer opening a new media source until the tab is visible.
      // Keep accepting sourceopen in the background, but count only visible time.
      const deferWhileHidden = event === 'sourceopen';
      const cleanup = () => {
        clearTimeout(timer);
        target.removeEventListener(event, done);
        target.removeEventListener('error', fail);
        this.lifetime.signal.removeEventListener('abort', abort);
        if (deferWhileHidden)
          document.removeEventListener('visibilitychange', visibility);
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
      const visibility = () => {
        if (started !== undefined) {
          remaining = Math.max(0, remaining - (performance.now() - started));
          clearTimeout(timer);
          started = undefined;
        }
        if (!deferWhileHidden || document.visibilityState === 'visible') {
          started = performance.now();
          timer = setTimeout(fail, remaining);
        }
      };
      target.addEventListener(event, done, { once: true });
      target.addEventListener('error', fail, { once: true });
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      if (this.disposed) {
        abort();
        return;
      }
      if (deferWhileHidden)
        document.addEventListener('visibilitychange', visibility);
      visibility();
      try {
        operation?.();
      } catch (error) {
        cleanup();
        reject(error);
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
      if (
        buffer.buffered.start(i) <= time + 0.05 &&
        buffer.buffered.end(i) > time + 0.1
      )
        return true;
    return false;
  }
  private window(track: Track, target: number): number {
    // SIDX gives an estimate, not the browser's actual allocation. Split the
    // byte budget between history and prefetch, and also cap both by time.
    let rate = 1;
    for (const segment of track.segments)
      if (segment.end > target - 4 && segment.time < target + 30)
        rate = Math.max(rate, segment.length / (segment.end - segment.time));
    const budget = (track.index === 0 ? 64 : 8) * 1024 * 1024;
    const history = Math.min(4, budget / 8 / rate);
    const desired = this.loading
      ? Math.max(3, 2 + track.delay * 2)
      : Math.max(12, 6 + track.delay * 3);
    return Math.max(1, Math.min(30, desired, budget / rate - history));
  }
  private async trim(
    track: Track,
    seek: number,
    pressure = false,
  ): Promise<void> {
    this.assertSeek(seek);
    const target = this.video.currentTime;
    const ahead = this.window(track, target);
    const behind = pressure ? 1 : Math.min(4, ahead / 7);
    const currentIndex = track.segments.findIndex(
      (s) => s.time <= target && s.end > target,
    );
    const current = track.segments[currentIndex];
    const previous = track.segments[currentIndex - 1];
    // remove() also drops dependent frames up to the next random access point.
    // SIDX timestamps can round past the current keyframe. Cut within the
    // preceding fragment so removal stops before that keyframe, not after it.
    const dependencyStart = current
      ? previous
        ? (previous.time + previous.end) / 2
        : 0
      : target;
    const before = Math.min(target - behind, dependencyStart);
    const ranges = track.buffer.buffered;
    if (ranges.length && ranges.start(0) < before)
      await this.update(track.buffer, () => track.buffer.remove(0, before));
    this.assertSeek(seek);
    const remaining = track.buffer.buffered;
    const end = remaining.length ? remaining.end(remaining.length - 1) : 0;
    const after = Math.max(target + 30, current?.end ?? target);
    if (end > after)
      await this.update(track.buffer, () => track.buffer.remove(after, end));
  }
  private async append(
    track: Track,
    data: Uint8Array<ArrayBuffer>,
    seek: number,
  ): Promise<boolean> {
    for (let attempt = 0; ; attempt++) {
      this.assertSeek(seek);
      try {
        await this.update(track.buffer, () => track.buffer.appendBuffer(data));
        return true;
      } catch (error) {
        this.assertSeek(seek);
        if (!(
          error instanceof DOMException && error.name === 'QuotaExceededError'
        ))
          throw error;
        if (attempt === 0) {
          await this.trim(track, seek, true);
          continue;
        }
        // Retain this one chunk until playback frees space. If playback cannot
        // advance, report failure rather than retrying a full buffer forever.
        if (this.contains(track.buffer, this.video.currentTime + 1))
          return false;
        throw new HelperError('source-buffer-failed');
      }
    }
  }
  private async step(track: Track, seek: number): Promise<boolean> {
    this.assertSeek(seek);
    const target = this.video.currentTime;
    if (
      track.pending &&
      (track.pending.seek !== seek || track.pending.segment.end <= target)
    ) {
      // Reset an incomplete MP4 parser even when no append is in progress.
      track.buffer.abort();
      track.pending = undefined;
    }
    await this.trim(track, seek);
    this.assertSeek(seek);
    const ahead = this.window(track, target);
    for (let i = 0; i < track.buffer.buffered.length; i++)
      if (
        track.buffer.buffered.start(i) <= target + 0.05 &&
        track.buffer.buffered.end(i) >=
          Math.min(this.info!.duration, target + ahead)
      )
        return false;
    if (!track.pending) {
      const segment = track.segments.find((s) => {
        if (s.end <= target || s.time > target + ahead) return false;
        if (track.appended?.seek === seek && s.end <= track.appended.end)
          return false;
        for (let i = 0; i < track.buffer.buffered.length; i++)
          if (
            track.buffer.buffered.start(i) <= Math.max(s.time, target) + 0.05 &&
            track.buffer.buffered.end(i) >= s.end - 0.05
          )
            return false;
        return true;
      });
      if (!segment) return false;
      track.pending = { segment, at: 0, seek };
    }
    const pending = track.pending;
    if (!pending.data) {
      const offset = pending.segment.offset + pending.at;
      if (track.read?.offset === offset && track.read.seek === seek) {
        const read = track.read;
        const result = await read.result;
        if (track.read === read) track.read = undefined;
        if ('error' in result) throw result.error;
        pending.data = result.data;
      } else
        pending.data = await this.bytes(
          track.index,
          offset,
          Math.min(CHUNK_BYTES, pending.segment.length - pending.at),
          seek,
          pending.segment,
        );
    }
    this.assertSeek(seek);
    const next = pending.at + pending.data.length;
    if (!track.read && next < pending.segment.length) {
      const offset = pending.segment.offset + next;
      track.read = {
        offset,
        seek,
        result: this.bytes(
          track.index,
          offset,
          Math.min(CHUNK_BYTES, pending.segment.length - next),
          seek,
          pending.segment,
        ).then(
          (data) => ({ data }),
          (error: unknown) => ({ error }),
        ),
      };
    }
    if (!(await this.append(track, pending.data, seek))) return false;
    this.assertSeek(seek);
    pending.at += pending.data.length;
    pending.data = undefined;
    if (pending.at === pending.segment.length) {
      // Reordered frames can need the next fragment to complete this time range.
      // Do not download a completed fragment again within the same seek.
      track.appended = { seek, end: pending.segment.end };
      track.pending = undefined;
    }
    return true;
  }
  private async pump(): Promise<void> {
    if (this.pumping || this.disposed || this.failure || !this.tracks.length)
      return;
    this.pumping = true;
    let progressed = false;
    try {
      const seek = this.seekGeneration;
      const blocked = new Set<Track>();
      // Alternate tracks and bound work per tick. A long video fragment must
      // not block audio, readiness, cancellation, or the next buffering pass.
      let steps = 0;
      for (let round = 0; round < 8 && steps < 8; round++)
        for (const track of this.tracks) {
          if (steps === 8) break;
          if (blocked.has(track)) continue;
          if (await this.step(track, seek)) {
            steps++;
            progressed = true;
          } else blocked.add(track);
        }
      if (
        this.info &&
        this.video.currentTime > this.info.duration - 15 &&
        this.tracks.every(
          (t) =>
            !t.pending && this.contains(t.buffer, this.info!.duration - 0.3),
        ) &&
        this.source?.readyState === 'open'
      )
        this.source.endOfStream();
      void this.loadDanmaku();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        throw error;
    } finally {
      this.pumping = false;
      this.schedule(progressed ? 0 : 250);
    }
  }
  private schedule(delay: number): void {
    if (this.loading || this.disposed || this.failure) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.pump().catch((error: unknown) => this.fail(error));
    }, delay);
  }
  private async loadDanmaku(seeking = false): Promise<void> {
    if (!this.info || this.disposed) return;
    const segment = Math.min(
      Math.ceil(this.info.duration / 360),
      Math.floor(this.video.currentTime / 360) + 1,
    );
    // A same-segment seek reuses both loaded comments and an in-flight reply.
    if (segment === this.dmSegment) return;
    if (seeking) this.danmaku.clear();
    this.dmSegment = segment;
    const request = ++this.dmRequest;
    this.onDanmaku(message('player.danmakuLoading'));
    try {
      let reply: unknown;
      for (let attempt = 0; ; attempt++) {
        this.assertOwned();
        if (request !== this.dmRequest) return;
        try {
          reply = await this.bridge.call('danmaku', {
            handle: this.info.handle,
            segment,
            generation: this.generation,
          });
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
      if (this.disposed || request !== this.dmRequest) return;
      this.danmaku.comments = decodeComments(reply, this.info.duration);
      this.onDanmaku(
        this.danmaku.comments.length
          ? message('player.danmakuLoaded')
          : message('player.danmakuEmpty'),
      );
    } catch {
      if (!this.disposed && request === this.dmRequest) {
        this.danmaku.clear();
        this.onDanmaku(message('player.danmakuUnavailable'));
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
    const observed = this.native.getState();
    return {
      ...observed,
      ...(this.loading || (!this.failure && observed.status === 'no_media')
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
    this.thumbnails.dispose();
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    clearTimeout(this.timer);
    this.dmRequest++;
    this.bridge.close(this.generation + 1);
    this.danmaku.dispose();
    for (const track of this.tracks) {
      track.read = undefined;
      track.pending = undefined;
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
