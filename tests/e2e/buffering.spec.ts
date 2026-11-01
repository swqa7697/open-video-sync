import { expect, test } from '../../modules/web/playwright-fixtures';
import { decodeSnapshot } from '../../modules/web/src/transport/api';
import {
  clickPlayerControl,
  closeRoom,
  createLocalRoom,
  seekTo,
} from './flows';
import { decodedFrame, generatedVideo } from './media';

test('a playing MediaSource seek waits for data and resumes without a manual pause', async ({
  page,
  browser,
}) => {
  const file = await generatedVideo(browser);
  // Keep only the first five one-second clusters available. Use native MSE to
  // exercise the same seeking/waiting events as the online adapter, offline.
  let split = file.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]));
  expect(split).toBeGreaterThan(0);
  for (let cluster = 0; cluster < 5; cluster++) {
    const start = split + 4;
    let width = 1;
    while (!(file[start]! & (1 << (8 - width)))) width++;
    let length = file[start]! & ((1 << (8 - width)) - 1);
    for (let byte = 1; byte < width; byte++)
      length = length * 256 + file[start + byte]!;
    split = start + width + length;
  }
  await page.goto('/');
  await createLocalRoom(
    page,
    { name: 'streamed.webm', mimeType: 'video/webm', buffer: file },
    'Streamed seek'
  );
  const roomPath = `/api/v2${new URL(page.url()).pathname}`;
  const snapshot = async () => {
    const response = await page.request.get(roomPath);
    expect(response.ok()).toBe(true);
    return decodeSnapshot(await response.json());
  };
  const stream = await page.evaluateHandle(
    async (initial) => {
      const video = document.querySelector('video')!;
      const source = new MediaSource();
      const url = URL.createObjectURL(source);
      const opened = new Promise<void>((resolve) =>
        source.addEventListener('sourceopen', () => resolve(), { once: true })
      );
      video.src = url;
      await opened;
      source.duration = 30;
      const buffer = source.addSourceBuffer('video/webm; codecs="vp8"');
      const appended = new Promise<void>((resolve) =>
        buffer.addEventListener('updateend', () => resolve(), { once: true })
      );
      buffer.appendBuffer(new Uint8Array(initial));
      await appended;
      return { source, buffer, url };
    },
    Array.from(file.subarray(0, split))
  );
  try {
    await expect(page.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready'
    );
    await clickPlayerControl(page, 'Play together');
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)
      )
      .toBeGreaterThan(0.2);
    await seekTo(page, 20);
    await expect
      .poll(async () => (await snapshot()).barrier?.reason)
      .toBe('buffering');
    const target = (await snapshot()).barrier!.targetPositionMs / 1000;
    await expect(page.locator('video')).toHaveJSProperty('paused', true);
    await stream.evaluate(
      async ({ source, buffer }, remaining) => {
        const appended = new Promise<void>((resolve) =>
          buffer.addEventListener('updateend', () => resolve(), { once: true })
        );
        buffer.appendBuffer(new Uint8Array(remaining));
        await appended;
        source.endOfStream();
      },
      Array.from(file.subarray(split))
    );
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)
      )
      .toBeGreaterThan(target + 0.5);
    await expect(page.locator('video')).toHaveJSProperty('paused', false);
    expect(await decodedFrame(page)).toBeGreaterThan(600);
    expect((await snapshot()).playback.phase).toBe('playing');
    // A paused seek remains usable with the same native media source.
    await clickPlayerControl(page, 'Pause together');
    await expect(page.locator('video')).toHaveJSProperty('paused', true);
    await seekTo(page, 10);
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)
      )
      .toBeCloseTo(10, 1);
    await clickPlayerControl(page, 'Play together');
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime)
      )
      .toBeGreaterThan(10.5);
    await closeRoom(page);
  } finally {
    await stream.evaluate(({ url }) => URL.revokeObjectURL(url));
    await stream.dispose();
  }
});
