import { writeFile } from 'node:fs/promises';
import { expect, test } from '../../web/playwright-fixtures';
import { decodedFrame, generatedVideo } from './media';

test('two independent local players match, play, seek, pause, reconnect, and transfer tab ownership', async ({
  page,
  browser,
  guestBrowser,
  baseURL,
}, testInfo) => {
  test.setTimeout(60000);
  const fixture = await generatedVideo(browser),
    guest = await guestBrowser.newContext();
  const failures: string[] = [],
    frames: string[] = [];
  page.on('pageerror', (e) => failures.push(e.message));
  page.on('websocket', (socket) =>
    socket.on('framesent', (event) => {
      if (typeof event.payload === 'string') frames.push(event.payload);
    }),
  );
  const file = {
    name: 'synthetic-private-name-canary.webm',
    mimeType: 'video/webm',
    buffer: fixture,
  };
  try {
    // Offline emulation can leave Firefox's existing WebSocket alive. Forward to the
    // real server normally, then explicitly cut both sides and reject outage retries.
    let socketAvailable = true;
    let interruptSocket: (() => Promise<void>) | undefined;
    await guest.routeWebSocket('**/ws/v1/rooms/*', async (socket) => {
      if (!socketAvailable) {
        await socket.close({ code: 1013, reason: 'Synthetic transport outage' });
        return;
      }
      const server = socket.connectToServer();
      interruptSocket = async () => {
        await socket.close({ code: 1013, reason: 'Synthetic transport outage' });
        await server.close();
      };
    });
    const other = await guest.newPage();
    other.on('pageerror', (e) => failures.push(e.message));
    await page.goto('/');
    await page.getByLabel('Room title', { exact: true }).fill('Local synchronized viewing');
    await page.getByRole('button', { name: 'Create room', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Clock calibrated' })).toBeVisible();
    const roomURL = page.url(),
      invitation = await page.getByLabel('Invitation link').inputValue();
    await other.goto(invitation);
    await other.getByRole('button', { name: 'Join room', exact: true }).click();
    await expect(other.getByRole('status').filter({ hasText: 'Clock calibrated' })).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Playback controls', exact: true })
      .selectOption('everyone');
    await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Room updated.' })).toBeVisible();
    await page.getByLabel('Shared media label (optional)').fill('Synthetic video');
    await page.locator('#local-video').setInputFiles(file);
    await expect(page.getByTestId('media-status')).toHaveText('ready');
    const changed = Buffer.from(fixture);
    changed[changed.length - 1]! ^= 1;
    await other.locator('#local-video').setInputFiles({ ...file, buffer: changed });
    await expect(other.getByTestId('media-status')).toHaveText('mismatch');
    await other.locator('#local-video').setInputFiles({
      name: 'unsupported-codec.webm',
      mimeType: 'video/webm',
      buffer: Buffer.from('not a video'),
    });
    await expect(other.getByTestId('media-status')).toHaveText('unsupported');
    await expect(other.getByRole('alert')).toContainText('cannot decode');
    await other.locator('#local-video').setInputFiles({ ...file, buffer: changed });
    await other.locator('#local-video').setInputFiles(file);
    await expect(other.getByTestId('media-status')).toHaveText('ready');
    await page.setViewportSize({ width: 375, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('player-375.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.getByRole('button', { name: 'Play together', exact: true }).click();
    for (const player of [page, other])
      await expect
        .poll(() =>
          player
            .locator('video')
            .evaluate(
              (v) => !(v as HTMLVideoElement).paused && (v as HTMLVideoElement).currentTime > 0.5,
            ),
        )
        .toBe(true);
    await page.getByLabel('Seek to seconds').fill('10');
    await page.getByRole('button', { name: 'Seek together', exact: true }).click();
    for (const player of [page, other])
      await expect
        .poll(() => player.locator('video').evaluate((v) => (v as HTMLVideoElement).currentTime))
        .toBeGreaterThan(10);
    await page.getByRole('button', { name: 'Pause together', exact: true }).click();
    for (const player of [page, other])
      await expect
        .poll(() => player.locator('video').evaluate((v) => (v as HTMLVideoElement).paused))
        .toBe(true);
    const positions = await Promise.all(
      [page, other].map((p) =>
        p.locator('video').evaluate((v) => (v as HTMLVideoElement).currentTime),
      ),
    );
    expect(Math.abs(positions[0]! - positions[1]!)).toBeLessThan(0.15);
    const seekFrames = await Promise.all([decodedFrame(page), decodedFrame(other)]);
    expect(Math.min(...seekFrames)).toBeGreaterThanOrEqual(300);
    expect(Math.abs(seekFrames[0]! - seekFrames[1]!)).toBeLessThanOrEqual(3);
    // A connection drop keeps files in memory, recalibrates, and reconciles without replaying controls.
    socketAvailable = false;
    await guest.setOffline(true);
    if (!interruptSocket) throw new Error('The guest must have a real room socket before outage.');
    await interruptSocket();
    await expect(
      other.getByRole('status').filter({ hasText: /Disconnected|uncertain/ }),
    ).toBeVisible({ timeout: 10000 });
    socketAvailable = true;
    await guest.setOffline(false);
    await expect(other.getByRole('status').filter({ hasText: 'Clock calibrated' })).toBeVisible({
      timeout: 20000,
    });
    await page.getByRole('button', { name: 'Play together', exact: true }).click();
    await expect
      .poll(() => other.locator('video').evaluate((v) => !(v as HTMLVideoElement).paused))
      .toBe(true);
    // Both browser roles must control actual decoded playback after reconnect.
    await other.getByLabel('Seek to seconds').fill('15');
    await other.getByRole('button', { name: 'Seek together', exact: true }).click();
    for (const player of [page, other])
      await expect.poll(() => decodedFrame(player)).toBeGreaterThanOrEqual(450);
    await other.getByRole('button', { name: 'Pause together', exact: true }).click();
    for (const player of [page, other])
      await expect
        .poll(() => player.locator('video').evaluate((v) => (v as HTMLVideoElement).paused))
        .toBe(true);
    const recoveredFrames = await Promise.all([decodedFrame(page), decodedFrame(other)]);
    expect(Math.abs(recoveredFrames[0]! - recoveredFrames[1]!)).toBeLessThanOrEqual(3);
    await other.getByRole('button', { name: 'Play together', exact: true }).click();
    for (const player of [page, other])
      await expect.poll(() => decodedFrame(player)).toBeGreaterThan(Math.max(...recoveredFrames));
    await writeFile(
      testInfo.outputPath('playback-convergence.json'),
      JSON.stringify(
        {
          origin: baseURL,
          host: { name: browser.browserType().name(), version: browser.version() },
          guest: { name: guestBrowser.browserType().name(), version: guestBrowser.version() },
          hostSeekFrames: seekFrames,
          guestSeekAfterReconnectFrames: recoveredFrames,
          framesPerSecond: 30,
          controlsFromBothParticipants: true,
          reconnectFault: 'Offline HTTP plus explicit closure of the forwarded real room socket',
          observation: 'Decoded source-frame pixels; no physical display timing.',
        },
        null,
        2,
      ) + '\n',
    );
    const tab = await page.context().newPage();
    await tab.goto(roomURL);
    await expect(tab.getByRole('button', { name: 'Use this tab' })).toBeVisible();
    await tab.getByRole('button', { name: 'Use this tab' }).click();
    await expect(page.getByRole('button', { name: 'Use this tab' })).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator('video')
          .evaluate((v) => (v as HTMLVideoElement).paused && !v.getAttribute('src')),
      )
      .toBe(true);
    await tab.getByRole('button', { name: 'Pause together', exact: true }).click();
    await other.reload();
    await expect(other.getByTestId('media-status')).toHaveText('no_media');
    expect(await other.locator('video').getAttribute('src')).toBeNull();
    expect(frames.join('')).not.toContain(file.name);
    expect(frames.join('')).not.toContain('blob:');
    for (const p of [other, tab])
      expect(
        await p.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
      ).toEqual({ local: {}, session: {} });
    if (baseURL && !['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname))
      expect(
        await page.evaluate(() => ({ secure: isSecureContext, subtle: !!crypto.subtle })),
      ).toEqual({ secure: false, subtle: false });
    await tab.screenshot({ path: testInfo.outputPath('local-player.png'), fullPage: true });
    await tab.close();
    expect(failures).toEqual([]);
  } finally {
    await guest.close();
  }
});
