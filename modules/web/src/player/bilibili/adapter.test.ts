import { Buffer } from 'node:buffer';
import { afterEach, expect, test, vi } from 'vite-plus/test';

import { BilibiliAdapter } from './adapter';
import { HelperBridge, HelperError } from './bridge';

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
  reordered = false,
  indexOffsetMs = 0,
) {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('atob', (text: string) =>
    Buffer.from(text, 'base64').toString('binary'),
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
    index.writeUInt32BE(indexOffsetMs, 20);
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
          (s) => offset >= s.offset && offset < s.offset + s.length,
        )!;
        expect(offset).toBe(this.next ?? segment.offset);
        expect(
          bytes.subarray(4).equals(Buffer.alloc(data.length - 4, offset % 251)),
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
          : 'audio/mp4; codecs="mp4a.40.2"',
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
  const opening: { deferred: boolean; source?: FakeSource } = {
    deferred: false,
  };
  const nativeURL = URL;
  vi.stubGlobal(
    'URL',
    class extends nativeURL {
      static createObjectURL(source: unknown): string {
        if (!(source instanceof FakeSource))
          throw new Error('Unexpected source');
        opening.source = source;
        if (!opening.deferred)
          queueMicrotask(() => source.dispatchEvent(new Event('sourceopen')));
        return 'blob:synthetic-dash';
      }
      static revokeObjectURL(): void {}
    },
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
    },
  );
  const onError = vi.fn();
  const overlay = document.createElement('div');
  const adapter = new BilibiliAdapter(video, overlay, () => {}, onError);
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
    overlay,
    buffers,
    ranges,
    segments,
    onError,
    opening,
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

test('paused seeks reuse the current danmaku segment and reject replies from an abandoned segment', async () => {
  const f = fixture(Array<number>(73).fill(1024));
  Object.defineProperties(f.overlay, {
    clientWidth: { value: 800 },
    clientHeight: { value: 304 },
  });
  const comments = [1, 4, 5].map((mode) => ({
    time: 0,
    mode,
    color: 0xffffff,
    text: `Mode ${mode}`,
  }));
  const calls: number[] = [];
  let busy = true;
  let release: ((value: unknown) => void) | undefined;
  const bridge = vi.spyOn(HelperBridge.prototype, 'call'),
    original = bridge.getMockImplementation()!;
  bridge.mockImplementation((op, args) => {
    if (op !== 'danmaku') return original(op, args);
    const segment = Number(args?.segment);
    calls.push(segment);
    if (busy) {
      busy = false;
      return Promise.reject(new HelperError('busy'));
    }
    if (segment === 1) return Promise.resolve({ comments });
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const seek = async (time: number) => {
    const seeking = f.adapter.seek(time * 1000);
    f.video.dispatchEvent(new Event('seeking'));
    f.video.dispatchEvent(new Event('seeked'));
    await seeking;
    await vi.advanceTimersByTimeAsync(16);
  };
  try {
    await f.load();
    f.video.currentTime = 1;
    await vi.advanceTimersByTimeAsync(300);
    expect(f.overlay.children).toHaveLength(3);
    await f.adapter.pause();
    // A pause can correct the native position to the room's frozen timeline.
    for (const time of [1.15, 0.95]) {
      await seek(time);
      expect(f.overlay.textContent).toBe('Mode 1Mode 4Mode 5');
    }
    const paused = f.overlay.innerHTML;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.overlay.innerHTML).toBe(paused);
    expect(calls).toEqual([1, 1]);

    await seek(361);
    expect(f.overlay.children).toHaveLength(0);
    await seek(361.2);
    release!({
      comments: [{ ...comments[0], time: 360, text: 'Second segment' }],
    });
    await vi.advanceTimersByTimeAsync(16);
    expect(f.overlay.textContent).toBe('Second segment');
    expect(calls).toEqual([1, 1, 2]);

    await seek(1);
    await seek(361);
    await seek(1);
    release!({
      comments: [{ ...comments[0], time: 1, text: 'Stale segment' }],
    });
    await vi.advanceTimersByTimeAsync(16);
    expect(f.overlay.textContent).toBe('Mode 1Mode 4Mode 5');
    f.adapter.reloadDanmaku();
    await vi.advanceTimersByTimeAsync(16);
    expect(calls).toEqual([1, 1, 2, 1, 2, 1, 1]);
    expect(f.overlay.textContent).toBe('Mode 1Mode 4Mode 5');
    expect(f.onError).not.toHaveBeenCalled();
  } finally {
    f.adapter.dispose();
  }
});

test.each(['hidden at start', 'hidden during opening', 'opens while hidden'])(
  '%s does not fail deferred media initialization and resumes on return',
  async (mode) => {
    const f = fixture([1024]);
    f.opening.deferred = true;
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue(mode === 'hidden during opening' ? 'visible' : 'hidden');
    const loading = f.load();
    void loading.catch(() => {});
    try {
      await vi.advanceTimersByTimeAsync(2000);
      visibility.mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(30000);
      expect(f.adapter.getState().status).toBe('loading');
      expect(f.onError).not.toHaveBeenCalled();
      if (mode !== 'opens while hidden') {
        visibility.mockReturnValue('visible');
        document.dispatchEvent(new Event('visibilitychange'));
      }
      await vi.advanceTimersByTimeAsync(1000);
      f.opening.source!.dispatchEvent(new Event('sourceopen'));
      await expect(loading).resolves.toMatchObject({ kind: 'bilibili' });
      expect(f.adapter.getState().status).toBe('ready');
      visibility.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(6000);
      expect(f.onError).not.toHaveBeenCalled();
    } finally {
      f.adapter.dispose();
      await loading.catch(() => {});
    }
  },
);

test.each(['timeout', 'error', 'dispose'] as const)(
  '%s still ends a pending media initialization',
  async (action) => {
    const f = fixture([1024]);
    f.opening.deferred = true;
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('visible');
    const failed = expect(f.load()).rejects.toMatchObject(
      action === 'dispose'
        ? { name: 'AbortError' }
        : { code: 'source-buffer-failed' },
    );
    try {
      await vi.advanceTimersByTimeAsync(2000);
      visibility.mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(1000);
      if (action === 'timeout') {
        visibility.mockReturnValue('visible');
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(2999);
        expect(f.onError).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      } else if (action === 'error')
        f.opening.source!.dispatchEvent(new Event('error'));
      else f.adapter.dispose();
      await failed;
      expect(f.onError).toHaveBeenCalledTimes(action === 'dispose' ? 0 : 1);
      const reads = f.ranges.length;
      visibility.mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      f.opening.source!.dispatchEvent(new Event('sourceopen'));
      await vi.advanceTimersByTimeAsync(6000);
      expect(f.ranges).toHaveLength(reads);
    } finally {
      f.adapter.dispose();
      await failed;
    }
  },
);

test('high-bitrate AVC streams beyond 64 MiB in order without blocking audio or assembling fragments', async () => {
  const f = fixture();
  let release: (() => void) | undefined;
  try {
    let started: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.read((range) => {
      if (
        range.track === 0 &&
        range.offset === f.segments[0]![0]!.offset + chunkSize
      )
        return new Promise<void>((resolve) => {
          release = resolve;
          started!();
        });
      return Promise.resolve();
    });
    const loading = f.load();
    await reading;
    await vi.advanceTimersByTimeAsync(0);
    // An outstanding read must not hold the current append or starve audio.
    expect(f.buffers[0]!.appends).toHaveLength(1);
    expect(f.buffers[1]!.appends).toHaveLength(1);
    release!();
    await expect(loading).resolves.toMatchObject({
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
        f.ranges.filter((r) => r.track === track && r.offset > 32),
      );
      expect(buffer.appends.reduce((sum, r) => sum + r.length, 0)).toBe(
        f.segments[track]![0]!.length,
      );
    }
    expect(f.ranges.every((r) => r.length > 0 && r.length <= chunkSize)).toBe(
      true,
    );
  } finally {
    release?.();
    f.adapter.dispose();
  }
});

test.each(['network-or-permission-denied', 'request-timeout', 'http-503'])(
  'a transient %s during read-ahead resumes the same byte cursor',
  async (code) => {
    const f = fixture(Array<number>(5).fill(12 * chunkSize));
    let failed: Range | undefined;
    try {
      await f.load();
      await f.until(() => f.buffers[0]!.times.at(-1)?.[1] === 15);
      const source = f.video.src;
      f.read(async (range) => {
        if (
          !failed &&
          range.track === 0 &&
          range.offset === f.segments[0]![3]!.offset + chunkSize
        ) {
          failed = range;
          throw new HelperError(code);
        }
      });
      f.video.currentTime = 12;
      await f.until(() =>
        f.buffers.every((buffer) => buffer.times.at(-1)?.[1] === 25),
      );
      expect(failed).toBeDefined();
      expect(f.video.src).toBe(source);
      expect(
        f.buffers[0]!.appends.reduce((total, range) => total + range.length, 0),
      ).toBe(5 * 12 * chunkSize);
      expect(
        f.buffers[0]!.appends.filter(
          (range) => range.offset === failed!.offset,
        ),
      ).toHaveLength(1);
      expect(f.onError).not.toHaveBeenCalled();
    } finally {
      f.adapter.dispose();
    }
  },
);

test.each([
  ['request-timeout', 4],
  ['http-429', 1],
  ['destination-denied', 1],
] as const)(
  'persistent %s stops after bounded attempts',
  async (code, attempts) => {
    const f = fixture([12 * chunkSize]);
    f.read(async () => {
      throw new HelperError(code);
    });
    try {
      const loading = expect(f.load()).rejects.toMatchObject({ code });
      await vi.advanceTimersByTimeAsync(10000);
      await loading;
      expect(f.ranges.filter((range) => range.offset > 32)).toHaveLength(
        attempts,
      );
      expect(f.onError).toHaveBeenCalledTimes(1);
    } finally {
      f.adapter.dispose();
    }
  },
);

test('seeks preserve playable frames when SIDX boundaries round past keyframes', async () => {
  const f = fixture(
    Array<number>(8).fill(2 * chunkSize),
    false,
    'avc1.640033',
    false,
    1,
  );
  try {
    await f.load();
    await f.until(() => f.buffers[0]!.times.at(-1)?.[1] === 15);
    for (const time of [7.9, 8.25, 9.75]) {
      f.video.currentTime = time;
      if (time === 7.9) f.video.dispatchEvent(new Event('seeking'));
      await vi.advanceTimersByTimeAsync(2000);
      expect(
        f.buffers.every((buffer) =>
          buffer.times.some(
            ([start, end]) => start <= time && end > time + 0.1,
          ),
        ),
      ).toBe(true);
    }
    expect(f.onError).not.toHaveBeenCalled();
  } finally {
    f.adapter.dispose();
  }
});

test.each(['seek', 'dispose'] as const)(
  '%s invalidates a delayed network retry before another request or append',
  async (action) => {
    const f = fixture(Array<number>(8).fill(1024));
    try {
      await f.load();
      await f.until(() => f.buffers[0]!.times.at(-1)?.[1] === 15);
      f.read(async (range) => {
        if (range.track === 0) throw new HelperError('request-timeout');
      });
      f.video.currentTime = 12;
      await vi.advanceTimersByTimeAsync(250);
      const before = f.ranges.length;
      const appends = f.buffers[0]!.appends.length;
      if (action === 'seek') {
        f.video.currentTime = 32;
        f.video.dispatchEvent(new Event('seeking'));
      } else f.adapter.dispose();
      f.read(undefined);
      await vi.advanceTimersByTimeAsync(2000);
      if (action === 'seek') {
        expect(
          f.ranges
            .slice(before)
            .filter((range) => range.track === 0)
            .every((range) => range.offset >= f.segments[0]![6]!.offset),
        ).toBe(true);
        expect(f.buffers[0]!.times.at(-1)?.[1]).toBe(40);
      } else {
        expect(f.ranges).toHaveLength(before);
        expect(f.buffers[0]!.appends).toHaveLength(appends);
      }
      expect(f.onError).not.toHaveBeenCalled();
    } finally {
      f.adapter.dispose();
    }
  },
);

test('a paused high-bitrate fragment stops prefetch at the byte budget and resumes from its cursor', async () => {
  for (const [latency, ahead] of [
    [0, 15],
    [4000, 20],
  ]) {
    const sample = fixture(Array<number>(12).fill(1024));
    sample.read((range) =>
      range.track === 0
        ? new Promise((resolve) => setTimeout(resolve, latency))
        : Promise.resolve(),
    );
    try {
      const loading = sample.load();
      await vi.advanceTimersByTimeAsync(25000);
      await loading;
      expect(sample.buffers[0]!.times).toEqual([[0, ahead]]);
      expect(sample.onError).not.toHaveBeenCalled();
    } finally {
      sample.adapter.dispose();
    }
  }
  const f = fixture([128 * 1024 * 1024], true);
  try {
    await f.load();
    await f.until(() => f.buffers[0]!.times[0]![1] >= 1);
    const before = f.ranges.length;
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.ranges).toHaveLength(before);
    expect(
      f.buffers[0]!.appends.reduce((sum, r) => sum + r.length, 0),
    ).toBeLessThanOrEqual(64 * 1024 * 1024);
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
      await f.until(() =>
        f.buffers.every((buffer) => buffer.times.at(-1)?.[1] === 10),
      );
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
          b.times.some(([start, end]) => start <= 1 && end > 1),
        ),
      );
      expect(f.ranges.length).toBeGreaterThan(reads);
      expect(f.onError).not.toHaveBeenCalled();
    } finally {
      f.adapter.dispose();
    }
  },
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
          }),
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
      if (action === 'dispose')
        expect(f.buffers[0]!.appends).toHaveLength(before);
      else
        expect(
          f.buffers[0]!.appends.slice(before).every(
            (range) => range.offset >= f.segments[0]![1]!.offset,
          ),
        ).toBe(true);
      if (action === 'seek') {
        await f.until(() => f.buffers[0]!.appends.length > before);
        expect(f.buffers[0]!.aborts).toBe(1);
        expect(f.buffers[0]!.appends[before]!.offset).toBe(
          f.segments[0]![1]!.offset,
        );
        await vi.advanceTimersByTimeAsync(2000);
        expect(f.onError).not.toHaveBeenCalled();
        expect(
          f.buffers[0]!.times.some(([start, end]) => start <= 9 && end > 9),
        ).toBe(true);
        expect(
          f.ranges.filter(
            (r) => r.track === 0 && r.offset === f.segments[0]![1]!.offset,
          ),
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
  },
);

test('full buffers retain one chunk, then evict played data and retry without downloading it again', async () => {
  const f = fixture([chunkSize, chunkSize, chunkSize, chunkSize]);
  try {
    await f.load();
    await f.until(() => f.buffers[0]!.times.at(-1)![1] >= 10);
    f.video.currentTime = 4;
    f.full(true);
    const before = f.buffers[0]!.appends.length;
    await vi.advanceTimersByTimeAsync(250);
    const reads = f.ranges.filter((r) => r.track === 0 && r.offset > 32).length;
    await vi.advanceTimersByTimeAsync(750);
    expect(f.buffers[0]!.appends).toHaveLength(before);
    expect(f.ranges.filter((r) => r.track === 0 && r.offset > 32)).toHaveLength(
      reads,
    );
    f.video.currentTime = 6;
    f.full(true, true);
    await f.until(() => f.buffers[0]!.appends.length > before);
    expect(f.buffers[0]!.times[0]![0]).toBe(5);
    expect(f.ranges.filter((r) => r.track === 0 && r.offset > 32)).toHaveLength(
      reads,
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
