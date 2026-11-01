import { Buffer } from 'node:buffer';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { BilibiliAdapter } from './adapter';
import { HelperBridge } from './bridge';

const chunkSize = 256 * 1024;
type Range = { track: number; offset: number; length: number };
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture(
  lengths = [65 * 1024 * 1024 + 17],
  progressive = false,
  codec = 'avc1.640033',
  reordered = false
) {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('atob', (text: string) =>
    Buffer.from(text, 'base64').toString('binary')
  );
  const video = document.createElement('video');
  Object.defineProperties(video, {
    duration: { value: lengths.length * 5 },
    readyState: { value: 4 },
  });
  video.pause = () => {};
  video.load = () => {};
  const indexes = [lengths, lengths.map(() => 1024)].map((sizes) => {
    const index = Buffer.alloc(32 + sizes.length * 12);
    index.writeUInt32BE(index.length, 0);
    index.write('sidx', 4);
    index.writeUInt32BE(1000, 16);
    index.writeUInt16BE(sizes.length, 30);
    sizes.forEach((length, i) => {
      index.writeUInt32BE(length, 32 + i * 12);
      index.writeUInt32BE(5000, 36 + i * 12);
    });
    return index;
  });
  const segments = [lengths, lengths.map(() => 1024)].map((sizes, track) => {
    let offset = 32 + indexes[track]!.length;
    return sizes.map((length, i) => {
      const segment = { offset, length, time: i * 5, end: (i + 1) * 5 };
      offset += length;
      return segment;
    });
  });
  const ranges: Range[] = [];
  let onRead: ((range: Range) => Promise<void>) | undefined;
  let quota = false;
  let freeOnRemove = false;
  const buffers: FakeBuffer[] = [];
  class FakeBuffer extends EventTarget {
    updating = false;
    initialized = false;
    appends: Range[] = [];
    removals: [number, number][] = [];
    aborts = 0;
    times: [number, number][] = [];
    next: number | undefined;
    constructor(readonly track: number) {
      super();
    }
    get buffered() {
      return {
        length: this.times.length,
        start: (i: number) => this.times[i]![0],
        end: (i: number) => this.times[i]![1],
      };
    }
    appendBuffer(data: Uint8Array): void {
      if (this.initialized) {
        if (quota && this.track === 0)
          throw new DOMException('Synthetic full buffer', 'QuotaExceededError');
        const bytes = Buffer.from(data);
        const offset = bytes.readUInt32BE();
        const segment = segments[this.track]!.find(
          (s) => offset >= s.offset && offset < s.offset + s.length
        )!;
        expect(offset).toBe(this.next ?? segment.offset);
        expect(
          bytes.subarray(4).equals(Buffer.alloc(data.length - 4, offset % 251))
        ).toBe(true);
        const end = offset + data.length;
        this.appends.push({ track: this.track, offset, length: data.length });
        this.next = end === segment.offset + segment.length ? undefined : end;
        if (progressive || this.next === undefined) {
          let time =
            segment.time + ((end - segment.offset) / segment.length) * 5;
          const start = Math.max(0, segment.time - (reordered ? 0.2 : 0));
          if (reordered && segment.end < lengths.length * 5) time -= 0.2;
          const last = this.times.at(-1);
          if (last && last[1] >= start) last[1] = Math.max(last[1], time);
          else this.times.push([start, time]);
        }
      } else this.initialized = true;
      this.updating = true;
      queueMicrotask(() => {
        this.updating = false;
        this.dispatchEvent(new Event('updateend'));
        if (buffers.every((b) => b.times.length))
          video.dispatchEvent(new Event('canplay'));
      });
    }
    remove(start: number, end: number): void {
      this.removals.push([start, end]);
      // Native MSE also removes dependent frames through the next keyframe.
      end =
        segments[this.track]!.find((s) => s.time >= end)?.time ??
        lengths.length * 5;
      this.times = this.times.flatMap(([a, b]) => {
        if (b <= start || a >= end) return [[a, b]];
        return [
          ...(a < start ? [[a, start]] : []),
          ...(b > end ? [[end, b]] : []),
        ] as [number, number][];
      });
      if (freeOnRemove) quota = false;
      this.updating = true;
      queueMicrotask(() => {
        this.updating = false;
        this.dispatchEvent(new Event('updateend'));
      });
    }
    abort(): void {
      this.aborts++;
      this.next = undefined;
    }
  }
  class FakeSource extends EventTarget {
    duration = 0;
    readyState = 'open';
    static isTypeSupported(): boolean {
      return true;
    }
    addSourceBuffer(mime: string): FakeBuffer {
      expect(mime).toBe(
        buffers.length === 0
          ? `video/mp4; codecs="${codec}"`
          : 'audio/mp4; codecs="mp4a.40.2"'
      );
      const buffer = new FakeBuffer(buffers.length);
      buffers.push(buffer);
      return buffer;
    }
    endOfStream(): void {
      this.readyState = 'ended';
    }
  }
  vi.stubGlobal('MediaSource', FakeSource);
  const nativeURL = URL;
  vi.stubGlobal(
    'URL',
    class extends nativeURL {
      static createObjectURL(source: unknown): string {
        if (!(source instanceof FakeSource))
          throw new Error('Unexpected source');
        queueMicrotask(() => source.dispatchEvent(new Event('sourceopen')));
        return 'blob:synthetic-dash';
      }
      static revokeObjectURL(): void {}
    }
  );
  vi.spyOn(HelperBridge.prototype, 'hello').mockResolvedValue();
  vi.spyOn(HelperBridge.prototype, 'call').mockImplementation(
    async (op, args = {}) => {
      if (op === 'open')
        return {
          bvid: 'BV1hf4y1N75G',
          cid: '1',
          part: 1,
          duration: lengths.length * 5,
          title: 'Synthetic premium AVC',
          parts: 1,
          handle: 'h1-1234',
          quality: 120,
          qualities: [120, 112, 32],
          tracks: indexes.map((index, i) => ({
            id: i === 0 ? 120 : 30216,
            codec: i === 0 ? codec : 'mp4a.40.2',
            mime: i === 0 ? 'video/mp4' : 'audio/mp4',
            init: [0, 31],
            index: [32, 31 + index.length],
          })),
        };
      if (op === 'danmaku') return { comments: [] };
      if (op !== 'bytes') throw new Error('Unexpected operation');
      const range = {
        track: Number(args.track),
        offset: Number(args.offset),
        length: Number(args.length),
      };
      ranges.push(range);
      if (range.offset > 32) await onRead?.(range);
      const data =
        range.offset === 0
          ? Buffer.alloc(32)
          : range.offset === 32
            ? indexes[range.track]!
            : Buffer.alloc(range.length, range.offset % 251);
      if (range.offset > 32) data.writeUInt32BE(range.offset);
      return { base64: data.toString('base64') };
    }
  );
  const onError = vi.fn();
  const adapter = new BilibiliAdapter(
    video,
    document.createElement('div'),
    () => {},
    onError
  );
  const load = () =>
    adapter.load('BV1hf4y1N75G', 1, new AbortController().signal, 120);
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++)
      await vi.advanceTimersByTimeAsync(250);
    expect(done()).toBe(true);
  };
  return {
    adapter,
    video,
    buffers,
    ranges,
    segments,
    onError,
    load,
    until,
    read: (fn: typeof onRead) => {
      onRead = fn;
    },
    full: (value: boolean, recover = false) => {
      quota = value;
      freeOnRemove = recover;
    },
  };
}

test('high-bitrate AVC streams beyond 64 MiB in order without blocking audio or assembling fragments', async () => {
  const f = fixture();
  try {
    await expect(f.load()).resolves.toMatchObject({
      kind: 'bilibili',
      durationMs: 5000,
    });
    expect(f.adapter.getState().status).toBe('loading');
    expect(f.buffers[0]!.times).toEqual([]);
    // Audio completes before the long video reference, rather than waiting behind it.
    expect(f.buffers[1]!.appends).toHaveLength(1);
    await f.until(() => f.adapter.getState().status === 'ready');
    expect(f.adapter.mediaInfo?.quality).toBe(120);
    expect(f.onError).not.toHaveBeenCalled();
    for (const [track, buffer] of f.buffers.entries()) {
      expect(buffer.appends).toEqual(
        f.ranges.filter((r) => r.track === track && r.offset > 32)
      );
      expect(buffer.appends.reduce((sum, r) => sum + r.length, 0)).toBe(
        f.segments[track]![0]!.length
      );
    }
    expect(f.ranges.every((r) => r.length > 0 && r.length <= chunkSize)).toBe(
      true
    );
  } finally {
    f.adapter.dispose();
  }
});

test('a paused high-bitrate fragment stops prefetch at the byte budget and resumes from its cursor', async () => {
  const f = fixture([128 * 1024 * 1024], true);
  try {
    await f.load();
    await f.until(() => f.buffers[0]!.times[0]![1] >= 1);
    const before = f.ranges.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.ranges).toHaveLength(before);
    expect(
      f.buffers[0]!.appends.reduce((sum, r) => sum + r.length, 0)
    ).toBeLessThanOrEqual(32 * 1024 * 1024);
    f.video.currentTime = 0.75;
    await f.until(() => f.ranges.length > before);
    expect(f.onError).not.toHaveBeenCalled();
  } finally {
    f.adapter.dispose();
  }
});

test.each(['av01.0.08M.08', 'hvc1.1.6.L120.90', 'hev1.1.6.L120.90'])(
  '%s initializes both tracks and advances past reordered fragment boundaries',
  async (codec) => {
    const f = fixture([1024, 1024], false, codec, true);
    try {
      await f.load();
      await f.until(() => f.adapter.getState().status === 'ready');
      expect(f.adapter.mediaInfo?.tracks[0]?.codec).toBe(codec);
      expect(f.buffers.map((b) => b.initialized)).toEqual([true, true]);
      expect(f.buffers[0]!.times).toEqual([[0, 10]]);
      expect(f.buffers[1]!.times).toEqual([[0, 10]]);
      const reads = f.ranges.length;
      for (const buffer of f.buffers) buffer.times = [];
      f.video.currentTime = 1;
      f.video.dispatchEvent(new Event('seeking'));
      await f.until(() =>
        f.buffers.every((b) =>
          b.times.some(([start, end]) => start <= 1 && end > 1)
        )
      );
      expect(f.ranges.length).toBeGreaterThan(reads);
      expect(f.onError).not.toHaveBeenCalled();
    } finally {
      f.adapter.dispose();
    }
  }
);

test.each(['seek', 'dispose'] as const)(
  '%s discards a late chunk and does not append into a newer parser',
  async (action) => {
    const f = fixture([65 * 1024 * 1024, 8 * chunkSize, 8 * chunkSize]);
    let release: (() => void) | undefined;
    try {
      await f.load();
      let started: (() => void) | undefined;
      const reading = new Promise<void>((resolve) => {
        started = resolve;
      });
      f.read(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
            started!();
          })
      );
      const tick = vi.advanceTimersByTimeAsync(250);
      await reading;
      const before = f.buffers[0]!.appends.length;
      if (action === 'seek') {
        f.video.currentTime = 9;
        f.video.dispatchEvent(new Event('seeking'));
      } else f.adapter.dispose();
      f.read(undefined);
      release!();
      await tick;
      expect(f.buffers[0]!.appends).toHaveLength(before);
      if (action === 'seek') {
        await f.until(() => f.buffers[0]!.appends.length > before);
        expect(f.buffers[0]!.aborts).toBe(1);
        expect(f.buffers[0]!.appends[before]!.offset).toBe(
          f.segments[0]![1]!.offset
        );
        await vi.advanceTimersByTimeAsync(2000);
        expect(
          f.buffers[0]!.times.some(([start, end]) => start <= 9 && end > 9)
        ).toBe(true);
        expect(
          f.ranges.filter(
            (r) => r.track === 0 && r.offset === f.segments[0]![1]!.offset
          )
        ).toHaveLength(1);
      } else {
        const requests = f.ranges.length;
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.ranges).toHaveLength(requests);
      }
      expect(f.onError).not.toHaveBeenCalled();
    } finally {
      release?.();
      f.adapter.dispose();
    }
  }
);

test('full buffers retain one chunk, then evict played data and retry without downloading it again', async () => {
  const f = fixture([chunkSize, chunkSize, chunkSize, chunkSize]);
  try {
    await f.load();
    f.video.currentTime = 4;
    f.full(true);
    const before = f.buffers[0]!.appends.length;
    await vi.advanceTimersByTimeAsync(250);
    const reads = f.ranges.filter((r) => r.track === 0 && r.offset > 32).length;
    await vi.advanceTimersByTimeAsync(750);
    expect(f.buffers[0]!.appends).toHaveLength(before);
    expect(f.ranges.filter((r) => r.track === 0 && r.offset > 32)).toHaveLength(
      reads
    );
    f.video.currentTime = 6;
    f.full(true, true);
    await f.until(() => f.buffers[0]!.appends.length > before);
    expect(f.buffers[0]!.removals).toContainEqual([0, 5]);
    expect(f.ranges.filter((r) => r.track === 0 && r.offset > 32)).toHaveLength(
      reads
    );
    expect(f.onError).not.toHaveBeenCalled();
  } finally {
    f.adapter.dispose();
  }
});

test('unrecoverable quota failure ends loading without an endless retry', async () => {
  const f = fixture();
  try {
    f.full(true);
    await expect(f.load()).rejects.toMatchObject({
      code: 'source-buffer-failed',
    });
    expect(f.onError).toHaveBeenCalledTimes(1);
    const reads = f.ranges.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.ranges).toHaveLength(reads);
  } finally {
    f.adapter.dispose();
  }
});
