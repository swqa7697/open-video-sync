import { expect, test } from '../../modules/web/playwright-fixtures';
import { decodeSnapshot } from '../../modules/web/src/transport/api';
import {
  clickPlayerControl,
  closeRoom,
  createLocalRoom,
  seekTo,
} from './flows';
import { decodedFrame, generatedVideo } from './media';

test('a playing MediaSource seek pauses at the target and stays paused when data arrives', async ({
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
    'Streamed seek',
  );
  const roomPath = `/api/v2${new URL(page.url()).pathname}`;
  const snapshot = async () => {
    const response = await page.request.get(roomPath);
    expect(response.ok()).toBe(true);
    return decodeSnapshot(await response.json());
  };
  const stream = await page.evaluateHandle(async (initial) => {
    const video = document.querySelector('video')!;
    const source = new MediaSource();
    const url = URL.createObjectURL(source);
    const opened = new Promise<void>((resolve) =>
      source.addEventListener('sourceopen', () => resolve(), { once: true }),
    );
    video.src = url;
    await opened;
    source.duration = 30;
    const buffer = source.addSourceBuffer('video/webm; codecs="vp8"');
    const appended = new Promise<void>((resolve) =>
      buffer.addEventListener('updateend', () => resolve(), { once: true }),
    );
    // Compact transport avoids serializing each media byte as a Playwright value.
    buffer.appendBuffer(Uint8Array.from(atob(initial), (c) => c.charCodeAt(0)));
    await appended;
    return { source, buffer, url };
  }, file.subarray(0, split).toString('base64'));
  try {
    await expect(page.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    await clickPlayerControl(page, 'Play together');
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeGreaterThan(0.2);
    await seekTo(page, 20);
    await expect
      .poll(async () => (await snapshot()).playback.phase)
      .toBe('paused');
    expect((await snapshot()).barrier).toBeNull();
    expect((await snapshot()).playback.desiredPlaying).toBe(false);
    await expect(page.locator('video')).toHaveJSProperty('paused', true);
    await stream.evaluate(async ({ source, buffer }, remaining) => {
      const appended = new Promise<void>((resolve) =>
        buffer.addEventListener('updateend', () => resolve(), { once: true }),
      );
      buffer.appendBuffer(
        Uint8Array.from(atob(remaining), (c) => c.charCodeAt(0)),
      );
      await appended;
      source.endOfStream();
    }, file.subarray(split).toString('base64'));
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeCloseTo(20, 1);
    await expect.poll(() => decodedFrame(page)).toBeGreaterThanOrEqual(600);
    await expect(page.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    await expect(page.locator('video')).toHaveJSProperty('paused', true);
    expect((await snapshot()).playback.phase).toBe('paused');
    // A paused seek remains usable with the same native media source.
    await seekTo(page, 10);
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeCloseTo(10, 1);
    await expect(page.locator('video')).toHaveJSProperty('paused', true);
    await clickPlayerControl(page, 'Play together');
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeGreaterThan(10.5);
    await closeRoom(page);
  } finally {
    await stream.evaluate(({ url }) => URL.revokeObjectURL(url));
    await stream.dispose();
  }
});
