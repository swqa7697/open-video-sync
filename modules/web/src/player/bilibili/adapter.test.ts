import { Buffer } from 'node:buffer';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { BilibiliAdapter } from './adapter';
import { HelperBridge } from './bridge';

afterEach(() => vi.unstubAllGlobals());

test('high-bitrate AVC loads complete fragments through bounded helper ranges', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const video = document.createElement('video');
  Object.defineProperties(video, {
    duration: { value: 5 },
    readyState: { value: 4 },
  });
  video.pause = () => {};
  video.load = () => {};
  const media = [Buffer.alloc(8 * 1024 * 1024 + 17), Buffer.alloc(1024)];
  // Distinct chunk contents detect missing, repeated, or reordered byte ranges.
  for (const data of media)
    for (let at = 0; at < data.length; at += 256 * 1024)
      data.fill(
        (at / (256 * 1024)) % 251,
        at,
        Math.min(at + 256 * 1024, data.length)
      );
  const indexes = media.map((data) => {
    const index = Buffer.alloc(44);
    index.writeUInt32BE(44, 0);
    index.write('sidx', 4);
    index.writeUInt32BE(1000, 16);
    index.writeUInt16BE(1, 30);
    index.writeUInt32BE(data.length, 32);
    index.writeUInt32BE(5000, 36);
    return index;
  });
  const buffers: FakeBuffer[] = [];
  class FakeBuffer extends EventTarget {
    updating = false;
    appends: Uint8Array[] = [];
    buffered = {
      get length() {
        return buffers.every((b) => b.appends.length > 1) ? 1 : 0;
      },
      start: () => 0,
      end: () => 5,
    };
    appendBuffer(data: Uint8Array): void {
      this.appends.push(data);
      queueMicrotask(() => {
        this.dispatchEvent(new Event('updateend'));
        if (buffers.every((b) => b.appends.length > 1))
          video.dispatchEvent(new Event('canplay'));
      });
    }
  }
  class FakeSource extends EventTarget {
    duration = 0;
    readyState = 'open';
    static isTypeSupported(): boolean {
      return true;
    }
    addSourceBuffer(): FakeBuffer {
      const buffer = new FakeBuffer();
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
  const ranges: { track: number; offset: number; length: number }[] = [];
  vi.spyOn(HelperBridge.prototype, 'call').mockImplementation(
    async (op, args = {}) => {
      if (op === 'open')
        return {
          bvid: 'BV1hf4y1N75G',
          cid: '1',
          part: 1,
          duration: 5,
          title: 'Synthetic premium AVC',
          parts: 1,
          handle: 'h1-1234',
          quality: 120,
          qualities: [120, 112, 32],
          tracks: media.map((_, i) => ({
            id: i === 0 ? 120 : 30216,
            codec: i === 0 ? 'avc1.640033' : 'mp4a.40.2',
            mime: i === 0 ? 'video/mp4' : 'audio/mp4',
            init: [0, 31],
            index: [32, 75],
          })),
        };
      if (op === 'danmaku') return { comments: [] };
      if (op !== 'bytes') throw new Error('Unexpected operation');
      const track = Number(args.track),
        offset = Number(args.offset),
        length = Number(args.length);
      ranges.push({ track, offset, length });
      const data =
        offset === 0
          ? Buffer.alloc(32)
          : offset === 32
            ? indexes[track]!
            : media[track]!.subarray(offset - 76, offset - 76 + length);
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
  try {
    await expect(
      adapter.load('BV1hf4y1N75G', 1, new AbortController().signal, 120)
    ).resolves.toMatchObject({
      kind: 'bilibili',
      bvid: 'BV1hf4y1N75G',
      durationMs: 5000,
    });
    expect(adapter.mediaInfo?.quality).toBe(120);
    expect(adapter.getState().status).toBe('ready');
    expect(onError).not.toHaveBeenCalled();
    for (const [track, buffer] of buffers.entries()) {
      expect(buffer.appends).toHaveLength(2);
      expect(Buffer.from(buffer.appends[1]!).equals(media[track]!)).toBe(true);
    }
    expect(ranges.every((r) => r.length > 0 && r.length <= 256 * 1024)).toBe(
      true
    );
  } finally {
    adapter.dispose();
  }
});
