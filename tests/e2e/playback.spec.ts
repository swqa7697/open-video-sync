import { writeFile } from 'node:fs/promises';

import {
  appContext,
  expect,
  test,
} from '../../modules/web/playwright-fixtures';
import {
  clickPlayerControl,
  createLocalRoom,
  dismissHelper,
  invitationLink,
  openPlayerMenu,
  openQuickActions,
  seekTo,
  setPlaybackSpeed,
  settings,
} from './flows';
import { decodedFrame, generatedVideo } from './media';

test('two independent local players match, play, change speed, seek, pause, reconnect, and transfer tab ownership', async ({
  page,
  browser,
  guestBrowser,
  baseURL,
}, testInfo) => {
  test.setTimeout(60000);
  const fixture = await generatedVideo(browser),
    guest = await appContext(guestBrowser);
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
    await guest.routeWebSocket('**/ws/v2/rooms/*', async (socket) => {
      if (!socketAvailable) {
        await socket.close({
          code: 1013,
          reason: 'Synthetic transport outage',
        });
        return;
      }
      const server = socket.connectToServer();
      interruptSocket = async () => {
        await socket.close({
          code: 1013,
          reason: 'Synthetic transport outage',
        });
        await server.close();
      };
    });
    const other = await guest.newPage();
    other.on('pageerror', (e) => failures.push(e.message));
    await page.goto('/');
    await createLocalRoom(
      page,
      { name: 'synthetic.webm', mimeType: 'video/webm', buffer: fixture },
      'Local synchronized viewing',
    );
    await expect(
      page.getByRole('status').filter({ hasText: 'Clock calibrated' }),
    ).toBeVisible();
    const roomURL = page.url(),
      invitation = await invitationLink(page);
    await other.goto(invitation);
    await dismissHelper(other);
    await expect(
      other.getByRole('status').filter({ hasText: 'Clock calibrated' }),
    ).toBeVisible();
    await expect(
      other.getByRole('button', { name: 'Playback speed', exact: true }),
    ).toBeDisabled();
    await settings(page, true);
    await expect(
      page.getByRole('status').filter({ hasText: 'Preferences saved.' }),
    ).toBeVisible();
    await page.locator('#local-video').setInputFiles(file);
    await expect(page.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    const changed = Buffer.from(fixture);
    changed[changed.length - 1]! ^= 1;
    await other
      .locator('#local-video')
      .setInputFiles({ ...file, buffer: changed });
    await expect(other.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'mismatch',
    );
    await expect(other.getByTestId('media-status')).toHaveText(
      'Different video from the room',
    );
    await expect(other.locator('.playback-indicator')).toHaveCount(0);
    await other.locator('#local-video').setInputFiles({
      name: 'unsupported-codec.webm',
      mimeType: 'video/webm',
      buffer: Buffer.from('not a video'),
    });
    await expect(other.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'unsupported',
    );
    await expect(other.getByRole('alert')).toContainText('cannot decode');
    await other
      .locator('#local-video')
      .setInputFiles({ ...file, buffer: changed });
    await other.locator('#local-video').setInputFiles(file);
    await expect(other.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    const speed = (player: typeof page) =>
      player.getByRole('button', { name: 'Playback speed', exact: true });
    await page.locator('.video-stage').hover({ position: { x: 16, y: 8 } });
    await setPlaybackSpeed(page, 1.5);
    for (const player of [page, other]) {
      await expect(speed(player)).toHaveText('1.5×');
      await expect(player.locator('video')).toHaveJSProperty('paused', true);
      await expect(player.locator('video')).toHaveJSProperty(
        'playbackRate',
        1.5,
      );
    }
    await page.setViewportSize({ width: 375, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.locator('.video-stage').hover({ position: { x: 16, y: 8 } });
    await page.screenshot({
      path: testInfo.outputPath('playback-speed-narrow.png'),
    });
    // Narrow screens reach the room heading and navigation before the player.
    expect(
      await page.evaluate(() => {
        const heading = document.getElementById('room-title'),
          video = document.querySelector('video');
        return (
          !!heading && !!video && !!(heading.compareDocumentPosition(video) & 4)
        );
      }),
    ).toBe(true);
    await page.setViewportSize({ width: 1280, height: 1000 });
    const stage = page.locator('.video-stage');
    // The player menu provides local tools without sending a playback command.
    await openPlayerMenu(page, 'keyboard');
    const playerMenu = page.getByRole('menu', { name: 'Player menu' });
    await expect(playerMenu).toBeVisible();
    await expect(playerMenu.getByRole('menuitem')).toHaveCount(2);
    await expect(
      playerMenu.getByRole('menuitem', { name: 'Open on Bilibili' }),
    ).toHaveCount(0);
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    const shortcuts = page.getByRole('dialog', {
      name: 'Keyboard shortcuts',
      exact: true,
    });
    await expect(shortcuts).toBeVisible();
    const volumeBeforeHelp = await page.locator('#local-volume').inputValue();
    await page.keyboard.press('k');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('m');
    await expect(shortcuts).toBeVisible();
    await expect(page.locator('#local-volume')).toHaveValue(volumeBeforeHelp);
    await expect(page.locator('video')).toHaveJSProperty('paused', true);
    await page.keyboard.press('Escape');
    await expect(shortcuts).toHaveCount(0);
    await expect(stage).toBeFocused();
    await openPlayerMenu(page);
    await playerMenu
      .getByRole('menuitem', { name: 'Video statistics', exact: true })
      .click();
    const statistics = page.getByRole('region', {
      name: 'Video statistics',
      exact: true,
    });
    await expect(statistics).toBeVisible();
    await expect(statistics).toContainText(/640\s*[×x]\s*360/);
    await expect(statistics).toContainText('Buffered ahead');
    await expect(statistics).not.toContainText('Network activity');
    await expect(statistics).not.toContainText('Video segments');
    await expect(page.locator('video')).toHaveJSProperty('paused', true);
    await page.keyboard.press('Escape');
    await expect(statistics).toHaveCount(0);
    // Quick actions is the searchable path to the same local tool.
    await openQuickActions(page, 'Video statistics');
    await page.locator('.command-palette').getByRole('combobox').press('Enter');
    await expect(statistics).toBeVisible();
    await statistics
      .getByRole('button', { name: 'Close video statistics', exact: true })
      .click();
    await expect(statistics).toHaveCount(0);
    // Open from the exposed video surface, above the controls on a short player.
    await page.setViewportSize({ width: 390, height: 360 });
    // Hover waits for the fitted player to settle before sampling edge coordinates.
    await stage.hover({ position: { x: 16, y: 8 } });
    const clippedStage = (await stage.boundingBox())!;
    await page.mouse.click(
      clippedStage.x + clippedStage.width - 20,
      clippedStage.y + 8,
      { button: 'right' },
    );
    await expect(playerMenu).toBeVisible();
    const clippedMenu = (await playerMenu.boundingBox())!;
    expect(clippedMenu.x + clippedMenu.width).toBeLessThanOrEqual(390);
    expect(clippedMenu.y + clippedMenu.height).toBeLessThanOrEqual(360);
    expect(clippedMenu.y).toBeGreaterThanOrEqual(clippedStage.y);
    expect(clippedMenu.y + clippedMenu.height).toBeLessThanOrEqual(
      clippedStage.y + clippedStage.height,
    );
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 1000 });
    await stage.hover({ position: { x: 16, y: 8 } });
    const pausedIndicator = page.getByRole('img', {
      name: 'Paused',
      exact: true,
    });
    await expect(pausedIndicator).toBeVisible();
    const indicatorBox = await pausedIndicator.boundingBox();
    if (!indicatorBox) throw new Error('The paused indicator must be visible.');
    // The visual indicator must let clicks reach the playback surface beneath it.
    await page.mouse.click(
      indicatorBox.x + indicatorBox.width / 2,
      indicatorBox.y + indicatorBox.height / 2,
    );
    for (const player of [page, other])
      await expect
        .poll(() =>
          player
            .locator('video')
            .evaluate(
              (v) =>
                !(v as HTMLVideoElement).paused &&
                (v as HTMLVideoElement).currentTime > 0.5,
            ),
        )
        .toBe(true);
    await expect(page.locator('.playback-indicator')).toHaveCount(0);
    // Everyone controls changes both actual players without pausing playback.
    await other.locator('.video-stage').hover({ position: { x: 16, y: 8 } });
    await setPlaybackSpeed(other, 2);
    for (const player of [page, other]) {
      await expect(speed(player)).toHaveText('2×');
      await expect(player.locator('video')).toHaveJSProperty('paused', false);
      await expect
        .poll(() =>
          player
            .locator('video')
            .evaluate((video: HTMLVideoElement) =>
              Math.abs(video.playbackRate - 2),
            ),
        )
        .toBeLessThanOrEqual(0.101);
    }
    await openPlayerMenu(page);
    await playerMenu
      .getByRole('menuitem', { name: 'Video statistics', exact: true })
      .click();
    await expect(statistics).toBeVisible();
    const observedPosition = await page
      .locator('video')
      .evaluate((video: HTMLVideoElement) => video.currentTime);
    await expect
      .poll(() =>
        page
          .locator('video')
          .evaluate((video: HTMLVideoElement) => video.currentTime),
      )
      .toBeGreaterThan(observedPosition + 0.25);
    await expect(page.locator('video')).toHaveJSProperty('paused', false);
    await page.keyboard.press('Escape');
    await expect(statistics).toHaveCount(0);
    // Headless windows stay visible. Exercise visibility events on actual playing media;
    // both the event and later sampling must preserve playback, including on return.
    const background = await page.evaluateHandle(() => {
      const video = document.querySelector('video')!;
      const state = { pauses: 0, position: video.currentTime };
      video.addEventListener('pause', () => state.pauses++);
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value: 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
      return state;
    });
    await page.keyboard.press('m');
    expect(
      await page.locator('video').evaluate((v: HTMLVideoElement) => v.muted),
    ).toBe(false);
    const backgroundPosition = await background.evaluate(
      (state) => state.position,
    );
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeGreaterThan(backgroundPosition + 0.5);
    expect(await background.evaluate((state) => state.pauses)).toBe(0);
    await page.evaluate(() => {
      Reflect.deleteProperty(document, 'visibilityState');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(
      page.getByRole('status').filter({ hasText: 'Clock calibrated' }),
    ).toBeVisible();
    expect(await background.evaluate((state) => state.pauses)).toBe(0);
    await background.dispose();
    await seekTo(page, Number('10'));
    await setPlaybackSpeed(page, 0.75);
    for (const player of [page, other]) {
      await expect(speed(player)).toHaveText('0.75×');
      await expect(player.locator('video')).toHaveJSProperty(
        'playbackRate',
        0.75,
      );
      await expect(player.locator('video')).toHaveJSProperty('paused', true);
      await expect
        .poll(() =>
          player
            .locator('video')
            .evaluate((v) => (v as HTMLVideoElement).currentTime),
        )
        .toBeCloseTo(10, 1);
      await expect.poll(() => decodedFrame(player)).toBe(300);
    }
    await page.screenshot({
      path: testInfo.outputPath('playback-speed-desktop.png'),
    });
    // Seeking again while paused keeps both players at the new target.
    await seekTo(page, 12);
    for (const player of [page, other])
      await expect
        .poll(() =>
          player
            .locator('video')
            .evaluate((v) => (v as HTMLVideoElement).paused),
        )
        .toBe(true);
    for (const player of [page, other])
      await expect
        .poll(() =>
          player
            .locator('video')
            .evaluate((v: HTMLVideoElement) => v.currentTime),
        )
        .toBeCloseTo(12, 1);
    const positions = await Promise.all(
      [page, other].map((p) =>
        p.locator('video').evaluate((v) => (v as HTMLVideoElement).currentTime),
      ),
    );
    expect(Math.abs(positions[0]! - positions[1]!)).toBeLessThan(0.15);
    const seekFrames = await Promise.all([
      decodedFrame(page),
      decodedFrame(other),
    ]);
    expect(Math.min(...seekFrames)).toBeGreaterThanOrEqual(359);
    expect(Math.abs(seekFrames[0]! - seekFrames[1]!)).toBeLessThanOrEqual(3);
    // A connection drop keeps files in memory, recalibrates, and reconciles without replaying controls.
    socketAvailable = false;
    await guest.setOffline(true);
    if (!interruptSocket)
      throw new Error('The guest must have a real room socket before outage.');
    await interruptSocket();
    await expect(
      other.getByRole('status').filter({ hasText: /Disconnected|uncertain/ }),
    ).toBeVisible({ timeout: 10000 });
    socketAvailable = true;
    await guest.setOffline(false);
    await expect(
      other.getByRole('status').filter({ hasText: 'Clock calibrated' }),
    ).toBeVisible({
      timeout: 20000,
    });
    await clickPlayerControl(page, 'Play together');
    await expect(speed(other)).toHaveText('0.75×');
    await expect
      .poll(() =>
        other.locator('video').evaluate((v) => !(v as HTMLVideoElement).paused),
      )
      .toBe(true);
    // Both browser roles must control actual decoded playback after reconnect.
    await seekTo(other, Number('15'));
    for (const player of [page, other])
      await expect.poll(() => decodedFrame(player)).toBeGreaterThanOrEqual(450);
    for (const player of [page, other])
      await expect
        .poll(() =>
          player
            .locator('video')
            .evaluate((v) => (v as HTMLVideoElement).paused),
        )
        .toBe(true);
    for (const player of [page, other])
      await expect(
        player.getByRole('img', { name: 'Paused', exact: true }),
      ).toBeVisible();
    const recoveredFrames = await Promise.all([
      decodedFrame(page),
      decodedFrame(other),
    ]);
    expect(
      Math.abs(recoveredFrames[0]! - recoveredFrames[1]!),
    ).toBeLessThanOrEqual(3);
    await clickPlayerControl(other, 'Play together');
    for (const player of [page, other])
      await expect
        .poll(() => decodedFrame(player))
        .toBeGreaterThan(Math.max(...recoveredFrames));
    await writeFile(
      testInfo.outputPath('playback-convergence.json'),
      JSON.stringify(
        {
          origin: baseURL,
          host: {
            name: browser.browserType().name(),
            version: browser.version(),
          },
          guest: {
            name: guestBrowser.browserType().name(),
            version: guestBrowser.version(),
          },
          hostSeekFrames: seekFrames,
          guestSeekAfterReconnectFrames: recoveredFrames,
          framesPerSecond: 30,
          controlsFromBothParticipants: true,
          reconnectFault:
            'Offline HTTP plus explicit closure of the forwarded real room socket',
          observation:
            'Decoded source-frame pixels; no physical display timing.',
        },
        null,
        2,
      ) + '\n',
    );
    const tab = await page.context().newPage();
    await tab.goto(roomURL);
    await dismissHelper(tab);
    await expect(
      tab.getByRole('status').filter({ hasText: 'Clock calibrated' }),
    ).toBeVisible();
    await expect(
      page.getByText('This room is open elsewhere.', { exact: false }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator('video')
          .evaluate(
            (v) => (v as HTMLVideoElement).paused && !v.getAttribute('src'),
          ),
      )
      .toBe(true);
    await tab
      .getByRole('slider', { name: 'Seek', exact: true })
      .evaluate((input) =>
        input.dispatchEvent(new Event('change', { bubbles: true })),
      );
    await expect(other.locator('video')).toHaveJSProperty('paused', true);
    await other.reload();
    await dismissHelper(other);
    await expect(other.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'no_media',
    );
    expect(await other.locator('video').getAttribute('src')).toBeNull();
    expect(frames.join('')).not.toContain(file.name);
    expect(frames.join('')).not.toContain('blob:');
    for (const p of [other, tab])
      expect(
        await p.evaluate(() => ({
          local: localStorage.length,
          session: sessionStorage.length,
        })),
      ).toEqual({ local: 0, session: 0 });
    if (
      baseURL &&
      !['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)
    )
      expect(
        await page.evaluate(() => ({
          secure: isSecureContext,
          subtle: !!crypto.subtle,
        })),
      ).toEqual({ secure: false, subtle: false });
    await tab.close();
    expect(failures).toEqual([]);
  } finally {
    await guest.close();
  }
});
