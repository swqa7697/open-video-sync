import { chromium, type Browser, type Page } from '../../web/playwright-fixtures';

function ebml(id: number, data: Uint8Array): Buffer {
  const size = data.length;
  let width = 1;
  while (size >= 2 ** (7 * width) - 1) width++;
  const length = Buffer.alloc(width);
  let remaining = size;
  for (let i = width - 1; i >= 0; i--) {
    length[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  length[0]! |= 1 << (8 - width);
  const hex = id.toString(16);
  return Buffer.concat([Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex'), length, data]);
}
const uint = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  let i = 0;
  while (i < 3 && b[i] === 0) i++;
  return b.subarray(i);
};
// Encode a deterministic 30-fps synthetic source, with a calibrated frame number in pixels.
export async function generatedVideo(
  browser: Browser,
  seconds = 30,
  audio = false,
): Promise<Buffer> {
  // The source encoder is Chromium for every project. Firefox must decode the same bytes;
  // its WebCodecs encoder availability must not determine playback coverage.
  if (browser.browserType().name() !== 'chromium') {
    const encoder = await chromium.launch();
    try {
      return await generatedVideo(encoder, seconds, audio);
    } finally {
      await encoder.close();
    }
  }
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.route('http://localhost/ovs-fixture', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Generated OVS fixture</title>',
      }),
    );
    await page.goto('http://localhost/ovs-fixture');
    const chunks = await page.evaluate(
      async ({ count, audio }) => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas unavailable.');
        const frames: { timestamp: number; bytes: number[]; key: boolean }[] = [];
        const encoder = new VideoEncoder({
          output(chunk) {
            const bytes = new Uint8Array(chunk.byteLength);
            chunk.copyTo(bytes);
            frames.push({
              timestamp: chunk.timestamp,
              bytes: Array.from(bytes),
              key: chunk.type === 'key',
            });
          },
          error(error) {
            throw error;
          },
        });
        encoder.configure({
          codec: 'vp8',
          width: 640,
          height: 360,
          bitrate: 600000,
          framerate: 30,
        });
        for (let frame = 0; frame < count; frame++) {
          ctx.fillStyle = '#101820';
          ctx.fillRect(0, 0, 640, 360);
          ctx.fillStyle = '#ffffff';
          ctx.font = '32px monospace';
          ctx.fillText('OVS synthetic video / CC0', 20, 80);
          ctx.fillText(`${frame} / ${(frame / 30).toFixed(3)} s`, 20, 140);
          // 16 bright/dark bit cells permit independent canvas readback of the displayed frame.
          for (let bit = 0; bit < 16; bit++) {
            ctx.fillStyle = (frame >> bit) & 1 ? '#ffffff' : '#000000';
            ctx.fillRect(bit * 32, 240, 32, 64);
          }
          const source = new VideoFrame(canvas, {
            timestamp: Math.round((frame * 1000000) / 30),
            duration: Math.round(1000000 / 30),
          });
          encoder.encode(source, { keyFrame: frame % 30 === 0 });
          source.close();
          if (encoder.encodeQueueSize > 30) await encoder.flush();
        }
        await encoder.flush();
        encoder.close();
        const sound: { timestamp: number; bytes: number[]; key: boolean }[] = [];
        if (audio) {
          const encoder = new AudioEncoder({
            output(chunk) {
              const bytes = new Uint8Array(chunk.byteLength);
              chunk.copyTo(bytes);
              sound.push({ timestamp: chunk.timestamp, bytes: Array.from(bytes), key: true });
            },
            error(error) {
              throw error;
            },
          });
          encoder.configure({
            codec: 'opus',
            sampleRate: 48000,
            numberOfChannels: 1,
            bitrate: 32000,
          });
          for (let index = 0; index < (count * 50) / 30; index++) {
            const data = new AudioData({
              format: 'f32',
              sampleRate: 48000,
              numberOfFrames: 960,
              numberOfChannels: 1,
              timestamp: index * 20000,
              data: new Float32Array(960),
            });
            encoder.encode(data);
            data.close();
          }
          await encoder.flush();
          encoder.close();
        }
        return { frames, sound };
      },
      { count: seconds * 30, audio },
    );
    const duration = Buffer.alloc(8);
    duration.writeDoubleBE(seconds * 1000);
    const header = ebml(
      0x1a45dfa3,
      Buffer.concat([
        ebml(0x4286, uint(1)),
        ebml(0x42f7, uint(1)),
        ebml(0x42f2, uint(4)),
        ebml(0x42f3, uint(8)),
        ebml(0x4282, Buffer.from('webm')),
        ebml(0x4287, uint(2)),
        ebml(0x4285, uint(2)),
      ]),
    );
    const info = ebml(
      0x1549a966,
      Buffer.concat([
        ebml(0x2ad7b1, uint(1000000)),
        ebml(0x4489, duration),
        ebml(0x4d80, Buffer.from('ovs-test')),
        ebml(0x5741, Buffer.from('ovs-test')),
      ]),
    );
    let tracks = ebml(
      0x1654ae6b,
      ebml(
        0xae,
        Buffer.concat([
          ebml(0xd7, uint(1)),
          ebml(0x73c5, uint(1)),
          ebml(0x83, uint(1)),
          ebml(0x86, Buffer.from('V_VP8')),
          ebml(0x23e383, uint(33333333)),
          ebml(0xe0, Buffer.concat([ebml(0xb0, uint(640)), ebml(0xba, uint(360))])),
        ]),
      ),
    );
    if (audio) {
      const head = Buffer.alloc(19);
      head.write('OpusHead');
      head[8] = 1;
      head[9] = 1;
      head.writeUInt16LE(312, 10);
      head.writeUInt32LE(48000, 12);
      const frequency = Buffer.alloc(8);
      frequency.writeDoubleBE(48000);
      const track = ebml(
        0xae,
        Buffer.concat([
          ebml(0xd7, uint(2)),
          ebml(0x73c5, uint(2)),
          ebml(0x83, uint(2)),
          ebml(0x86, Buffer.from('A_OPUS')),
          ebml(0x63a2, head),
          ebml(0x56aa, uint(6500000)),
          ebml(0x56bb, uint(80000000)),
          ebml(0xe1, Buffer.concat([ebml(0xb5, frequency), ebml(0x9f, uint(1))])),
        ]),
      );
      let lengthWidth = 1;
      while (!(tracks[4]! & (1 << (8 - lengthWidth)))) lengthWidth++;
      tracks = ebml(0x1654ae6b, Buffer.concat([tracks.subarray(4 + lengthWidth), track]));
    }
    const frames = [
      ...chunks.frames.map((f) => ({ ...f, track: 1 })),
      ...chunks.sound.map((f) => ({ ...f, track: 2 })),
    ].sort((a, b) => a.timestamp - b.timestamp);
    const clusters: Buffer[] = [];
    for (let second = 0; second < seconds; second++) {
      const group = frames.filter((f) => Math.max(0, Math.floor(f.timestamp / 1000000)) === second),
        time = second * 1000;
      const blocks = group.map((frame) => {
        const h = Buffer.alloc(4);
        h[0] = 0x80 | frame.track;
        h.writeInt16BE(Math.round(frame.timestamp / 1000) - time, 1);
        h[3] = frame.key ? 0x80 : 0;
        return ebml(0xa3, Buffer.concat([h, Buffer.from(frame.bytes)]));
      });
      clusters.push(ebml(0x1f43b675, Buffer.concat([ebml(0xe7, uint(time)), ...blocks])));
    }
    return Buffer.concat([header, ebml(0x18538067, Buffer.concat([info, tracks, ...clusters]))]);
  } finally {
    await context.close();
  }
}

// Read the source-frame pixels, independently of currentTime and the room target.
export async function decodedFrame(page: Page): Promise<number> {
  return page.locator('video').evaluate((video: HTMLVideoElement) => {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return -1;
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas unavailable.');
    ctx.drawImage(video, 0, 0, 640, 360);
    let frame = 0;
    for (let bit = 0; bit < 16; bit++) {
      if (ctx.getImageData(bit * 32 + 16, 272, 1, 1).data[0]! > 128) frame |= 1 << bit;
    }
    return frame;
  });
}
