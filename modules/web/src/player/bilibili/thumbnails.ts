import { drawThumbnail } from '../thumbnails';
import { exact, HelperBridge, HelperError, integer, object } from './bridge';

interface ThumbnailInfo {
  columns: number;
  rows: number;
  width: number;
  height: number;
  times: number[];
  sheets: number;
  sources: number[];
}

// Fetch sheets independently by CDN. Hovering never does I/O.
export class BilibiliThumbnails {
  private info: ThumbnailInfo | undefined;
  private sources = new Map<number, Blob>();
  private bitmap: ImageBitmap | undefined;
  private frame = -1;
  private wantedMs: number | undefined;
  private started = false;
  private lifetime = new AbortController();
  constructor(
    private readonly bridge: HelperBridge,
    private readonly generation: number,
    private readonly onReady: () => void,
  ) {}

  start(handle: string): void {
    if (this.started || this.lifetime.signal.aborted) return;
    this.started = true;
    // Yield to load completion, media pumping, and the caller's readiness report.
    void this.run(handle);
  }

  private async run(handle: string): Promise<void> {
    let backoff = 1000;
    while (!this.lifetime.signal.aborted) {
      try {
        await this.prefetch(handle);
        return;
      } catch (error) {
        if (this.lifetime.signal.aborted || !this.retryable(error)) return;
        try {
          await this.delay(backoff);
        } catch {
          return;
        }
        backoff = Math.min(30000, backoff * 2);
      }
    }
  }

  private async prefetch(handle: string): Promise<void> {
    await this.delay(0);
    const value = object(await this.call('thumbnails', { handle }));
    exact(value, [
      'columns',
      'rows',
      'width',
      'height',
      'times',
      'sheets',
      'sources',
    ]);
    const info: ThumbnailInfo = {
      columns: integer(value.columns, 1, Number.MAX_SAFE_INTEGER),
      rows: integer(value.rows, 1, Number.MAX_SAFE_INTEGER),
      width: integer(value.width, 1, Number.MAX_SAFE_INTEGER),
      height: integer(value.height, 1, Number.MAX_SAFE_INTEGER),
      sheets: integer(value.sheets, 1, Number.MAX_SAFE_INTEGER),
      times: [],
      sources: [],
    };
    if (
      !Array.isArray(value.times) ||
      value.times.length < 1 ||
      value.times.length > info.columns * info.rows * info.sheets ||
      !Number.isSafeInteger(info.columns * info.rows * info.sheets) ||
      !Number.isSafeInteger(info.columns * info.width) ||
      !Number.isSafeInteger(info.rows * info.height)
    )
      throw new HelperError('invalid-reply');
    info.times = value.times.map((time) => {
      if (
        typeof time !== 'number' ||
        !Number.isFinite(time) ||
        time < 0 ||
        time > 604800
      )
        throw new HelperError('invalid-reply');
      return time;
    });
    if (info.times.some((time, i) => i > 0 && time < info.times[i - 1]!))
      throw new HelperError('invalid-reply');
    if (!Array.isArray(value.sources) || value.sources.length !== info.sheets)
      throw new HelperError('invalid-reply');
    info.sources = value.sources.map((source) =>
      integer(source, 0, info.sheets - 1),
    );
    if (this.lifetime.signal.aborted) return;
    this.info = info;
    this.onReady();
    const groups = new Map<number, Set<number>>();
    for (const [sheet, source] of info.sources.entries()) {
      if (!groups.has(source)) groups.set(source, new Set());
      groups.get(source)!.add(sheet);
    }
    await Promise.all(
      [...groups.entries()].flatMap(([source, sheets]) => [
        this.prefetchSource(handle, source, sheets),
        this.prefetchSource(handle, source, sheets),
      ]),
    );
  }

  private async prefetchSource(
    handle: string,
    source: number,
    pending: Set<number>,
  ): Promise<void> {
    let backoff = 1000;
    const info = this.info!;
    while (!this.lifetime.signal.aborted) {
      const wanted =
        this.wantedMs === undefined
          ? -1
          : Math.floor(
              this.frameAt(this.wantedMs) / (info.columns * info.rows),
            );
      let sheet = -1;
      if (pending.has(wanted)) sheet = wanted;
      else sheet = pending.values().next().value ?? -1;
      if (sheet < 0) return;
      pending.delete(sheet);
      try {
        const blob = await this.loadSheet(handle, sheet, source);
        if (this.lifetime.signal.aborted) return;
        this.sources.set(sheet, blob);
        backoff = 1000;
        this.onReady();
      } catch (error) {
        if (this.lifetime.signal.aborted) return;
        if (this.retryable(error)) {
          try {
            await this.delay(backoff);
          } catch {
            return;
          }
          backoff = Math.min(30000, backoff * 2);
          pending.add(sheet);
        }
      }
    }
  }

  private async loadSheet(
    handle: string,
    sheet: number,
    source: number,
  ): Promise<Blob> {
    let bytes: Uint8Array<ArrayBuffer> | undefined;
    for (
      let offset = 0;
      !bytes || offset < bytes.length;
      offset += 256 * 1024
    ) {
      const reply = object(
        await this.call('thumbnail', { handle, sheet, offset }, source),
      );
      exact(reply, ['base64', 'total']);
      const total = integer(reply.total, 1, 4 * 1024 * 1024);
      if (
        typeof reply.base64 !== 'string' ||
        reply.base64.length > 349528 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(reply.base64)
      )
        throw new HelperError('invalid-reply');
      const chunk = atob(reply.base64);
      if (
        (bytes && bytes.length !== total) ||
        chunk.length !== Math.min(256 * 1024, total - offset)
      )
        throw new HelperError('invalid-reply');
      bytes ??= new Uint8Array(total);
      for (let i = 0; i < chunk.length; i++)
        bytes[offset + i] = chunk.charCodeAt(i);
    }
    return new Blob([bytes]);
  }

  async draw(
    positionMs: number,
    canvas: HTMLCanvasElement,
    signal: AbortSignal,
  ): Promise<boolean> {
    this.wantedMs = positionMs;
    const owned = () => !this.lifetime.signal.aborted && !signal.aborted;
    if (!owned() || !this.info) return false;
    const info = this.info;
    const frame = this.frameAt(positionMs);
    const source = this.sources.get(
      Math.floor(frame / (info.columns * info.rows)),
    );
    if (!source) return false;
    const cell = frame % (info.columns * info.rows);
    if (this.frame !== frame) {
      const scale = Math.min(
        1,
        canvas.width / info.width,
        canvas.height / info.height,
      );
      const bitmap = await createImageBitmap(
        source,
        (cell % info.columns) * info.width,
        Math.floor(cell / info.columns) * info.height,
        info.width,
        info.height,
        {
          resizeWidth: Math.max(1, Math.round(info.width * scale)),
          resizeHeight: Math.max(1, Math.round(info.height * scale)),
        },
      );
      if (!owned()) {
        bitmap.close();
        return false;
      }
      this.bitmap?.close();
      this.bitmap = bitmap;
      this.frame = frame;
    }
    if (!owned() || !this.bitmap) return false;
    return drawThumbnail(
      canvas,
      this.bitmap,
      0,
      0,
      this.bitmap.width,
      this.bitmap.height,
    );
  }

  private frameAt(positionMs: number): number {
    const times = this.info!.times;
    let low = 0,
      high = times.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (times[middle]! * 1000 <= positionMs) low = middle;
      else high = middle;
    }
    return low;
  }

  dispose(): void {
    this.lifetime.abort();
    this.bitmap?.close();
    this.bitmap = undefined;
    this.sources.clear();
    this.info = undefined;
  }

  private async call(
    op: string,
    args: Record<string, unknown>,
    source = -1,
  ): Promise<unknown> {
    let retries = 0;
    while (!this.lifetime.signal.aborted) {
      try {
        return await this.bridge.call(
          op,
          {
            ...args,
            generation: this.generation,
          },
          undefined,
          source,
        );
      } catch (error) {
        if (
          error instanceof HelperError &&
          ['busy', 'cancelled', 'rate-limited'].includes(error.code)
        ) {
          await this.delay(250);
          continue;
        }
        if (
          !(error instanceof HelperError) ||
          (![
            'network-or-permission-denied',
            'request-timeout',
            'bridge-timeout',
            'http-408',
          ].includes(error.code) &&
            !/^http-5[0-9]{2}$/.test(error.code)) ||
          retries++ >= 2
        )
          throw error;
        await this.delay(250 * 2 ** retries);
      }
    }
    throw new DOMException('Cancelled', 'AbortError');
  }

  private retryable(error: unknown): boolean {
    return (
      error instanceof HelperError &&
      ([
        'busy',
        'cancelled',
        'rate-limited',
        'network-or-permission-denied',
        'request-timeout',
        'bridge-timeout',
        'access-expired',
        'http-404',
        'http-408',
        'http-429',
      ].includes(error.code) ||
        /^http-5[0-9]{2}$/.test(error.code))
    );
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = () => {
        this.lifetime.signal.removeEventListener('abort', abort);
        resolve();
      };
      const timer = setTimeout(done, ms);
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      this.lifetime.signal.addEventListener('abort', abort, { once: true });
      if (this.lifetime.signal.aborted) abort();
    });
  }
}
