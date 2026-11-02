import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  appContext,
  expect,
  test,
  type Page,
} from '../../modules/web/playwright-fixtures';
import {
  closeRoom,
  createLocalRoom,
  dismissHelper,
  invitationLink,
  observePageKeyboard,
  openAppPanel,
  openQuickActions,
  runQuickAction,
  settings,
} from './flows';
import { generatedVideo } from './media';

async function expectHeaderFits(page: Page): Promise<void> {
  const header = page.getByRole('banner');
  const headerBounds = (await header.boundingBox())!;
  const actions = await header.locator('a, button').evaluateAll((nodes) =>
    nodes
      .map((node) => {
        const bounds = node.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          top: bounds.top,
          bottom: bounds.bottom,
          width: bounds.width,
        };
      })
      .filter((bounds) => bounds.width > 0),
  );
  for (const bounds of actions) {
    expect(bounds.left).toBeGreaterThanOrEqual(headerBounds.x);
    expect(bounds.right).toBeLessThanOrEqual(
      headerBounds.x + headerBounds.width,
    );
    expect(bounds.top).toBeGreaterThanOrEqual(headerBounds.y);
    expect(bounds.bottom).toBeLessThanOrEqual(
      headerBounds.y + headerBounds.height,
    );
  }
  for (const [index, bounds] of actions.entries()) {
    for (const previous of actions.slice(0, index)) {
      expect(
        bounds.left >= previous.right ||
          bounds.top >= previous.bottom ||
          previous.top >= bounds.bottom,
      ).toBe(true);
    }
  }
}

test('independent identities manage a private room over direct HTTP', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  test.setTimeout(60000);
  if (!baseURL) throw new Error('Browser base URL required.');
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  // Hold acknowledgements, rather than relying on a fast network to test pending focus.
  let holdResults = false;
  const heldResults: Array<() => void> = [];
  const releaseResults = () => {
    holdResults = false;
    for (const send of heldResults.splice(0)) send();
  };
  await page.routeWebSocket('**/ws/v2/rooms/*', (socket) => {
    const server = socket.connectToServer();
    server.onMessage((data) => {
      const frame =
        typeof data === 'string'
          ? (JSON.parse(data) as { type: string; eventSeq?: number })
          : undefined;
      if (
        holdResults &&
        frame?.eventSeq &&
        (heldResults.length > 0 || frame.type === 'command.result')
      )
        heldResults.push(() => socket.send(data));
      else socket.send(data);
    });
  });
  const guest = await appContext(browser),
    outsider = await appContext(browser);
  const file = {
    name: 'synthetic-private-name.webm',
    mimeType: 'video/webm',
    buffer: await generatedVideo(browser, 12),
  };
  try {
    const other = await guest.newPage(),
      outside = await outsider.newPage();
    other.on('pageerror', (error) => failures.push(error.message));
    await page.goto('/');
    await expect(page.locator('header [role="status"]')).toHaveText(
      'Server: ready',
    );
    await expect(page).toHaveTitle('Watch together · Open Video Sync');
    const favicon = await page.request.get(
      await page
        .locator('link[rel="icon"]')
        .evaluate((node: HTMLLinkElement) => node.href),
    );
    expect(favicon.ok()).toBe(true);
    expect(favicon.headers()['content-type']).toContain('image/svg+xml');
    await expect(
      page.getByRole('link', { name: 'Star Open Video Sync on GitHub' }),
    ).toHaveAttribute('href', 'https://github.com/swqa7697/open-video-sync');
    for (const landmark of ['banner', 'main', 'contentinfo'] as const)
      await expect(page.getByRole(landmark)).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('link', { name: 'Skip to main content' }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    await expect(page.getByRole('main')).toHaveCSS('outline-style', 'none');
    await dismissHelper(page);
    const firstIdentity = await (await page.request.get('/api/v2/me')).json();
    await page.locator('.profile-button').click();
    await page.getByLabel('Display name (optional)').fill('<b>Alice 😀</b>');
    await page.getByLabel('Display name (optional)').press('Enter');
    await expect(page.getByLabel('Display name (optional)')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.profile-button')).toBeFocused();
    // Local appearance must survive forgetting an identity later in this journey.
    await openAppPanel(page, 'Appearance');
    await page.getByRole('radio', { name: 'Light', exact: true }).check();
    await page.getByRole('radio', { name: 'Dark', exact: true }).check();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
    await createLocalRoom(page, file, 'Friday watch party');
    await expect(
      page.getByRole('heading', { name: 'Friday watch party' }),
    ).toBeFocused();
    await expect(
      page.getByRole('heading', { name: 'Friday watch party' }),
    ).toHaveCSS('outline-style', 'none');
    await expect(page).toHaveTitle('Room · Open Video Sync');
    expect(await page.locator('video').getAttribute('src')).toMatch(/^blob:/);
    await expect(page.locator('#local-volume')).toHaveValue('0.5');
    expect(
      await page.locator('video').evaluate((v: HTMLVideoElement) => v.muted),
    ).toBe(false);
    await page.locator('video').click({ position: { x: 150, y: 80 } });
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'playing',
    );
    await page.locator('video').click({ position: { x: 150, y: 80 } });
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'paused',
    );
    // Player shortcuts belong to the foreground page, including focus outside the player.
    await page.getByRole('heading', { name: 'Friday watch party' }).click();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'playing',
    );
    await page.keyboard.press('k');
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'paused',
    );
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('m');
    await expect(page.locator('#local-volume')).toHaveValue('0.6');
    expect(
      await page.locator('video').evaluate((v: HTMLVideoElement) => v.muted),
    ).toBe(true);
    await page.keyboard.press('f');
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement))
      .toBe(true);
    await openQuickActions(page);
    const paletteKeys = await observePageKeyboard(page);
    await page.getByRole('combobox').pressSequentially('m f k d ');
    await page.getByRole('combobox').press('Control+a');
    await page.getByRole('combobox').press('Backspace');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await page.screenshot({
      path: testInfo.outputPath('fullscreen-quick-actions-open.png'),
    });
    await page.keyboard.down('Escape');
    await expect(page.locator('.command-palette')).toHaveCount(0);
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    await page.screenshot({
      path: testInfo.outputPath('fullscreen-quick-actions-dismissed.png'),
    });
    await expect(page.locator('.command-palette')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement))
      .toBe(true);
    expect(await paletteKeys.evaluate((state) => state.events)).toEqual([]);
    await paletteKeys.evaluate((state) => state.stop());
    await paletteKeys.dispose();
    await expect(page.locator('#local-volume')).toHaveValue('0.6');
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'paused',
    );
    await runQuickAction(page, '/appearance');
    const appearance = page.getByRole('dialog', {
      name: 'Appearance',
      exact: true,
    });
    await expect(appearance).toBeVisible();
    const modalKeys = await observePageKeyboard(page);
    await appearance.getByRole('button', { name: 'Close dialog' }).focus();
    await page.keyboard.press('m');
    await page.keyboard.press('f');
    await page.keyboard.press('Control+k');
    await expect(appearance).toBeVisible();
    await expect(page.locator('.command-palette')).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('fullscreen-modal-open.png'),
    });
    await page.keyboard.down('Escape');
    await expect(appearance).toHaveCount(0);
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    expect(await modalKeys.evaluate((state) => state.events)).toEqual([]);
    await modalKeys.evaluate((state) => state.stop());
    await modalKeys.dispose();
    expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('fullscreen-modal-dismissed.png'),
    });
    await page.getByRole('slider', { name: 'Seek', exact: true }).focus();
    await page.keyboard.press('Escape');
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement))
      .toBe(false);
    // Restored button focus must not turn page-level Space into another button click.
    const changeVideo = page.getByRole('button', {
      name: 'Change video',
      exact: true,
    });
    await changeVideo.click();
    await page.keyboard.press('Escape');
    await expect(changeVideo).toBeFocused();
    await expect(changeVideo).toHaveCSS('outline-style', 'none');
    const playerLayout = await page.locator('.room-layout').boundingBox();
    const playerInformation = await page
      .locator('.video-information')
      .boundingBox();
    const playerStatus = await page.locator('.playback-status').textContent();
    holdResults = true;
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(changeVideo).toBeFocused();
    await expect.poll(() => heldResults.length).toBeGreaterThan(0);
    await expect(changeVideo).toBeDisabled();
    await expect(changeVideo).toHaveCSS('opacity', '1');
    await expect(page.locator('.command-recovery')).toHaveCount(0);
    expect(await page.locator('.room-layout').boundingBox()).toEqual(
      playerLayout,
    );
    expect(await page.locator('.video-information').boundingBox()).toEqual(
      playerInformation,
    );
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('command-pending.png') });
    await expect(page.locator('.command-recovery')).toBeVisible({
      timeout: 4500,
    });
    await expect(changeVideo).toBeFocused();
    await expect(changeVideo).toHaveCSS('opacity', '1');
    expect(await page.locator('.room-layout').boundingBox()).toEqual(
      playerLayout,
    );
    expect(await page.locator('.video-information').boundingBox()).toEqual(
      playerInformation,
    );
    expect(await page.locator('.playback-status').textContent()).toBe(
      playerStatus,
    );
    await page.screenshot({ path: testInfo.outputPath('command-delayed.png') });
    releaseResults();
    await expect(page.locator('.command-recovery')).toHaveCount(0);
    await expect(changeVideo).toBeEnabled();
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'playing',
    );
    await page.keyboard.press('Space');
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'paused',
    );
    // Enter still activates a deliberately focused button.
    await expect(changeVideo).toBeFocused();
    await expect(changeVideo).toBeEnabled();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('dialog', { name: 'Change the video', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    const fullscreen = page.getByRole('button', {
      name: 'Fullscreen locally',
      exact: true,
    });
    await page.locator('.video-stage').hover({ position: { x: 100, y: 100 } });
    await fullscreen.click();
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement))
      .toBe(true);
    await page.keyboard.press('f');
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement))
      .toBe(false);
    await expect(fullscreen).toBeFocused();
    await expect(fullscreen).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('Space');
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'playing',
    );
    expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await expect(fullscreen).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'paused',
    );
    // Inputs and dialog buttons retain their native keys and cannot control the room.
    await page.locator('.profile-button').click();
    const nameInput = page.getByLabel('Display name (optional)');
    await nameInput.fill('');
    await nameInput.pressSequentially('m d f k ');
    await nameInput.press('ArrowDown');
    await nameInput.press('ArrowUp');
    await expect(nameInput).toHaveValue('m d f k ');
    await expect(page.locator('#local-volume')).toHaveValue('0.6');
    expect(
      await page.locator('video').evaluate((v: HTMLVideoElement) => v.muted),
    ).toBe(true);
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'paused',
    );
    await page
      .getByRole('button', { name: 'Close dialog', exact: true })
      .focus();
    await page.keyboard.press('m');
    await page.keyboard.press('f');
    expect(
      await page.locator('video').evaluate((v: HTMLVideoElement) => v.muted),
    ).toBe(true);
    expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(false);
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'paused',
    );
    const profile = page.locator('.profile-button');
    await expect(profile).toBeFocused();
    await expect(profile).toHaveCSS('outline-style', 'none');
    await page.keyboard.press('Space');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'playing',
    );
    await expect(profile).toBeFocused();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'paused',
    );
    await page.reload();
    await dismissHelper(page);
    await expect(page.locator('#local-volume')).toHaveValue('0.6');
    expect(
      await page.locator('video').evaluate((v: HTMLVideoElement) => v.muted),
    ).toBe(true);
    await page.getByRole('heading', { name: 'Friday watch party' }).click();
    await page.keyboard.press('m');
    await page.locator('#local-video').setInputFiles(file);
    await expect(page.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    // Branding shares the Leave action, including confirmation and cancellation.
    const home = page.getByRole('button', { name: 'OVS home', exact: true });
    const pageCount = page.context().pages().length;
    const activeRoomURL = page.url();
    for (const input of ['pointer', 'keyboard']) {
      if (input === 'pointer') await home.click();
      else await home.press('Enter');
      await expect(
        page.getByRole('dialog', { name: 'Leave this room?' }),
      ).toBeVisible();
      expect(page.context().pages()).toHaveLength(pageCount);
      expect(page.url()).toBe(activeRoomURL);
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.locator('.room')).toBeVisible();
      await expect(home).toBeFocused();
    }
    const roomURL = page.url(),
      inviteURL = await invitationLink(page);
    // The quick video path only prefills the existing confirmation; it cannot publish early.
    const selectedMedia = await (
      await page.request.get(`/api/v2${new URL(roomURL).pathname}`)
    ).json();
    await openQuickActions(page);
    await page.screenshot({
      path: testInfo.outputPath('commands-room-desktop.png'),
    });
    await page
      .getByRole('combobox')
      .fill('$ https://www.bilibili.com/video/BV1hf4y1N75G/?p=2');
    await page.getByRole('combobox').press('Enter');
    await expect(
      page.getByRole('dialog', { name: 'Change the video', exact: true }),
    ).toBeVisible();
    await expect(page.locator('#bilibili-url')).toBeFocused();
    await expect(page.locator('#bilibili-url')).toHaveValue('BV1hf4y1N75G');
    await expect(page.locator('#bilibili-part')).toHaveValue('2');
    await page.keyboard.press('Escape');
    const unchangedMedia = await (
      await page.request.get(`/api/v2${new URL(roomURL).pathname}`)
    ).json();
    expect(unchangedMedia.mediaGeneration).toBe(selectedMedia.mediaGeneration);
    expect(unchangedMedia.media).toEqual(selectedMedia.media);
    await expect(page.locator('.roster')).toContainText('<b>Alice 😀</b>');
    expect(await page.locator('.roster b').count()).toBe(0);
    // Keep the host online while a lost join response and helper reload interrupt the guest.
    let interrupted = true;
    await other.route('**/api/v2/invitations/redeem', async (route) => {
      if (interrupted) {
        // Commit membership, then lose the reply before the guest can enter.
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await route.abort('failed');
      } else await route.continue();
    });
    await other.goto(inviteURL);
    await expect(other.locator('#app-alert')).toContainText(
      'Cannot reach the server',
    );
    expect(new URL(other.url()).hash).toBe('');
    expect(new URL(other.url()).pathname).toBe('/join');
    const duringJoin = await (
      await page.request.get(`/api/v2${new URL(roomURL).pathname}`)
    ).json();
    expect(
      duringJoin.members.find(
        (member: { role: string }) => member.role === 'host',
      ).presence,
    ).toBe('connected');
    expect(duringJoin.members).toHaveLength(2);
    expect(await invitationLink(page)).toBe(inviteURL);
    interrupted = false;
    await other
      .getByRole('dialog', { name: 'Set up Bilibili playback', exact: true })
      .getByRole('button', { name: 'Reload page', exact: true })
      .click();
    await dismissHelper(other);
    expect(new URL(other.url()).hash).toBe('');
    await expect(
      other.getByRole('button', { name: 'Join', exact: true }),
    ).toHaveCount(0);
    await expect(
      other.getByRole('heading', { name: 'Friday watch party' }),
    ).toBeVisible();
    const afterJoin = await (
      await page.request.get(`/api/v2${new URL(roomURL).pathname}`)
    ).json();
    expect(afterJoin.members).toHaveLength(2);
    expect(
      afterJoin.members.find(
        (member: { role: string }) => member.role === 'host',
      ).presence,
    ).toBe('connected');
    expect(await invitationLink(page)).toBe(inviteURL);
    await expect(other.locator('#control-note')).toContainText('Only the host');
    await other.locator('#local-video').setInputFiles(file);
    await expect(other.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    await openQuickActions(other, '/play');
    await expect(other.getByRole('option', { selected: true })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await expect(other.getByRole('option', { selected: true })).toContainText(
      'Only the host',
    );
    await other.getByRole('combobox').press('Enter');
    await expect(other.locator('.command-palette')).toBeVisible();
    await other.getByRole('combobox').fill('/video');
    await expect(
      other.getByRole('option').filter({ hasText: '/video' }),
    ).toHaveCount(0);
    await other.getByRole('combobox').fill('$ BV1hf4y1N75G');
    await expect(other.getByRole('option')).toHaveCount(0);
    await other.keyboard.press('Escape');
    await runQuickAction(page, '/play');
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'playing',
    );
    await expect
      .poll(() =>
        page
          .locator('video')
          .evaluate((video: HTMLVideoElement) => video.paused),
      )
      .toBe(false);
    await runQuickAction(page, '/pause');
    await expect(other.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'paused',
    );
    await runQuickAction(other, '/mute');
    expect(
      await other
        .locator('video')
        .evaluate((video: HTMLVideoElement) => video.muted),
    ).toBe(true);
    expect(
      await page
        .locator('video')
        .evaluate((video: HTMLVideoElement) => video.muted),
    ).toBe(false);
    await runQuickAction(page, '/seek');
    await expect(
      page.getByRole('slider', { name: 'Seek', exact: true }),
    ).toBeFocused();
    await runQuickAction(page, '/fullscreen');
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement))
      .toBe(true);
    // A native exit notification can arrive after the next palette has opened.
    const deferredExit = await page.evaluateHandle(() => {
      let pending: Event | undefined;
      function defer(event: Event): void {
        if (document.fullscreenElement) return;
        event.stopImmediatePropagation();
        pending = event;
      }
      document.addEventListener('fullscreenchange', defer, true);
      return {
        get pending() {
          return !!pending;
        },
        release() {
          document.removeEventListener('fullscreenchange', defer, true);
          if (pending) pending.target?.dispatchEvent(pending);
        },
      };
    });
    await runQuickAction(page, '/fullscreen');
    await expect
      .poll(() => page.evaluate(() => !!document.fullscreenElement))
      .toBe(false);
    await openQuickActions(page, '/local');
    await expect
      .poll(() => deferredExit.evaluate((state) => state.pending))
      .toBe(true);
    await deferredExit.evaluate((state) => state.release());
    await deferredExit.dispose();
    await expect(page.getByRole('combobox')).toBeFocused();
    const fileChooser = page.waitForEvent('filechooser');
    await page.getByRole('combobox').press('Enter');
    await expect(page.locator('.command-palette')).toHaveCount(0);
    await (await fileChooser).setFiles(file);
    await expect(page.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    const guestIdentity = await (
      await guest.request.get(`${baseURL}/api/v2/me`)
    ).json();
    expect(guestIdentity.identity.identityId).not.toBe(
      firstIdentity.identity.identityId,
    );
    await settings(page, 'everyone', false);
    // Real pointer seeking inside the custom player changes the observed media position.
    const player = page.locator('.video-stage');
    const playerControls = page.locator('.player-controls');
    await player.hover({ position: { x: 100, y: 100 } });
    const seek = page.getByRole('slider', { name: 'Seek', exact: true });
    const box = await seek.boundingBox();
    if (!box) throw new Error('Seek control required.');
    const tabToSeek = async () => {
      await page.keyboard.press('Tab');
      // Firefox includes the video itself in the native Tab order.
      if (
        await page
          .locator('video')
          .evaluate((v) => v === document.activeElement)
      )
        await page.keyboard.press('Tab');
      await expect(seek).toBeFocused();
    };
    holdResults = true;
    await seek.click({ position: { x: box.width / 3, y: box.height / 2 } });
    await expect(page.locator('.video-stage')).toBeFocused();
    await expect.poll(() => heldResults.length).toBeGreaterThan(0);
    await expect(seek).toBeDisabled();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.video-stage')).toBeFocused();
    await tabToSeek();
    await page.keyboard.press('Tab');
    await expect(
      page.getByRole('button', { name: 'Play together', exact: true }),
    ).toBeFocused();
    releaseResults();
    await expect(seek).toBeEnabled();
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeGreaterThan(3);
    await seek.focus();
    await page.keyboard.press('Home');
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeLessThan(0.2);
    await expect(seek).toBeFocused();
    // Pointer seeking must leave page shortcuts usable without another click.
    await seek.click({ position: { x: box.width / 3, y: box.height / 2 } });
    await expect(seek).toBeEnabled();
    await expect(page.locator('.video-stage')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.volume-feedback')).toHaveText('70');
    await page.screenshot({
      path: testInfo.outputPath('seek-keyboard.png'),
    });
    await expect(page.locator('#local-volume')).toHaveValue('0.7');
    await expect(page.locator('video')).toHaveJSProperty('volume', 0.7);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.volume-feedback')).toHaveText('60');
    await expect(page.locator('video')).toHaveJSProperty('volume', 0.6);
    await page.keyboard.press('m');
    await expect(page.locator('video')).toHaveJSProperty('muted', true);
    await page.keyboard.press('m');
    await expect(page.locator('video')).toHaveJSProperty('muted', false);
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeGreaterThan(8);
    await expect(seek).toBeEnabled();
    await page.keyboard.press('ArrowLeft');
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeLessThan(5);
    await expect(seek).toBeEnabled();
    // Leave enough of the short fixture for the idle interval before pausing again.
    await seek.press('Home');
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeLessThan(0.2);
    await expect(seek).toBeEnabled();
    await player.focus();
    await page.keyboard.press('Space');
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'playing',
    );
    // Passive stage focus must not pin controls; native pointer input owns visibility.
    await player.hover({ position: { x: 100, y: 100 } });
    await expect(playerControls).toHaveCSS('opacity', '0', { timeout: 4500 });
    await expect(player).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath('controls-playing-idle.png'),
    });
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('video')).toHaveJSProperty('volume', 0.7);
    await expect(page.locator('.volume-feedback')).toHaveText('70');
    await expect(playerControls).toHaveCSS('opacity', '0', { timeout: 500 });
    await page.screenshot({
      path: testInfo.outputPath('controls-shortcut-hidden.png'),
    });
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('video')).toHaveJSProperty('volume', 0.6);
    for (const muted of [true, false]) {
      await page.keyboard.press('m');
      await expect(page.locator('video')).toHaveJSProperty('muted', muted);
      await expect(playerControls).toHaveCSS('opacity', '0', { timeout: 500 });
    }
    // Applying a keyboard playback command must preserve the hidden state too.
    await page.keyboard.press('k');
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'paused',
    );
    await expect(playerControls).toHaveCSS('opacity', '0', { timeout: 500 });
    await page.keyboard.press('Space');
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'playing',
    );
    await expect(playerControls).toHaveCSS('opacity', '0', { timeout: 500 });
    await player.hover({ position: { x: 101, y: 100 } });
    await playerControls.hover({ position: { x: 100, y: 55 } });
    await expect(playerControls).toHaveCSS('opacity', '1');
    await page.mouse.move(0, 0);
    await expect(playerControls).toHaveCSS('opacity', '0', { timeout: 500 });
    await page.keyboard.press('k');
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'paused',
    );
    await player.hover({ position: { x: 100, y: 100 } });
    await page.waitForTimeout(3200);
    await expect(playerControls).toHaveCSS('opacity', '1');
    await page.screenshot({
      path: testInfo.outputPath('controls-paused-inside.png'),
    });
    await page.mouse.move(0, 0);
    await expect(playerControls).toHaveCSS('opacity', '0', { timeout: 500 });
    await player.hover({ position: { x: 100, y: 100 } });
    // Dragging out of the track also returns focus; Tab still enters the native slider.
    await seek.hover({ position: { x: box.width / 3, y: box.height / 2 } });
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x - 50, box.y - 20);
    await expect(playerControls).toHaveCSS('opacity', '1');
    await page.mouse.move(box.x + box.width / 2, box.y - 20);
    await page.mouse.up();
    await expect(page.locator('.video-stage')).toBeFocused();
    await expect(seek).toBeEnabled();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('video')).toHaveJSProperty('volume', 0.7);
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('video')).toHaveJSProperty('volume', 0.6);
    await tabToSeek();
    await page.keyboard.press('Home');
    await expect
      .poll(() =>
        page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeLessThan(0.2);
    await expect(seek).toBeFocused();
    await expect(
      page.getByRole('button', { name: 'Show danmaku locally', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    const firstCode = (
      await page.getByLabel('Invitation code', { exact: true }).inputValue()
    ).replaceAll(' ', '');
    await page
      .getByRole('button', { name: 'Replace invitation', exact: true })
      .click();
    await expect(
      page.getByLabel('Invitation link', { exact: true }),
    ).not.toHaveValue(inviteURL);
    await page.keyboard.press('Escape');
    await outside.goto('/');
    await dismissHelper(outside);
    expect(
      (
        await outsider.request.get(
          `${baseURL}/api/v2${new URL(roomURL).pathname}`,
        )
      ).status(),
    ).toBe(404);
    expect(
      (await (await outsider.request.get(`${baseURL}/api/v2/rooms`)).json())
        .rooms,
    ).toEqual([]);
    await outside.getByLabel('Invitation link or code').fill(firstCode);
    await outside.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(outside.getByRole('alert')).toContainText('unavailable');
    await page.getByRole('button', { name: /^Remove / }).click();
    await expect(page.locator('.roster li')).toHaveCount(1);
    await expect(
      page.getByRole('heading', { name: 'Participants', exact: true }),
    ).toBeFocused();
    // A disconnected guest may learn removal from an HTTP denial after reconnect.
    // Check revoked access and room exit independently of the notification wording.
    await expect(other).toHaveURL(`${baseURL}/`);
    await expect(
      other.getByRole('heading', { name: 'Start a watch party', exact: true }),
    ).toBeVisible();
    expect(
      (await other.request.get(`/api/v2${new URL(roomURL).pathname}`)).status(),
    ).toBe(404);
    await expect(
      other.getByRole('status').filter({ hasText: 'Friday watch party' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Leave', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Leave this room?' }),
    ).toBeVisible();
    await page
      .getByRole('dialog', { name: 'Leave this room?' })
      .evaluate((node) =>
        Promise.all(
          node.getAnimations().map((animation) => animation.finished),
        ),
      );
    await page.screenshot({
      path: testInfo.outputPath('leave-confirmation.png'),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator('.room')).toBeVisible();
    await home.click();
    await page
      .getByRole('button', { name: 'Confirm leave', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Start a watch party', exact: true }),
    ).toBeFocused();
    expect(
      (await page.request.get(`/api/v2${new URL(roomURL).pathname}`)).status(),
    ).toBe(404);
    await page.locator('.profile-button').click();
    await page
      .getByRole('button', { name: 'Forget this identity', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Confirm forget', exact: true })
      .click();
    await expect(page.locator('.app-message')).toContainText(
      'A new identity is active.',
    );
    const changed = await (await page.request.get('/api/v2/me')).json();
    expect(changed.identity.identityId).not.toBe(
      firstIdentity.identity.identityId,
    );
    await page.keyboard.press('Escape');
    const cookie = (await page.context().cookies()).find(
      (c) => c.name === 'ovs_session',
    );
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(cookie?.secure).toBe(false);
    expect(
      await page.evaluate(() => ({
        local: Object.keys(localStorage).sort(),
        session: sessionStorage.length,
      })),
    ).toEqual({ local: ['ovs.appearance', 'ovs.player'], session: 0 });
    expect(failures).toEqual([]);
  } finally {
    releaseResults();
    await Promise.all([guest.close(), outsider.close()]);
  }
});

// Layout/appearance have their own budget instead of sharing the identity journey's deadline.
test('responsive room layouts preserve controls and contrast at enlarged text sizes', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(60000);
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  const guest = await appContext(browser);
  const file = {
    name: 'synthetic-layout.webm',
    mimeType: 'video/webm',
    buffer: await generatedVideo(browser, 12),
  };
  try {
    await page.goto('/');
    await expect(page.locator('header [role="status"]')).toHaveText(
      'Server: ready',
    );
    await dismissHelper(page);
    await page.locator('.profile-button').click();
    await page.getByLabel('Display name (optional)').fill('<b>Alice 😀</b>');
    await page.getByRole('button', { name: 'Save name', exact: true }).click();
    await page.keyboard.press('Escape');
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
      [320, 844],
    ]) {
      await page.setViewportSize({ width: width!, height: height! });
      await expect(page.locator('.repo-star-count')).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width!);
      await expectHeaderFits(page);
      for (const colorScheme of ['light', 'dark'] as const) {
        await openAppPanel(page, 'Appearance');
        await page
          .getByRole('radio', {
            name: colorScheme === 'light' ? 'Light' : 'Dark',
            exact: true,
          })
          .check();
        await page.keyboard.press('Escape');
        await page.screenshot({
          path: testInfo.outputPath(`home-${colorScheme}-${width}.png`),
          fullPage: true,
        });
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await createLocalRoom(page, file, 'Responsive watch party');
    const other = await guest.newPage();
    other.on('pageerror', (error) => failures.push(error.message));
    await other.goto(await invitationLink(page));
    await dismissHelper(other);
    await expect(
      other.getByRole('heading', {
        name: 'Responsive watch party',
        exact: true,
      }),
    ).toBeVisible();
    await other.locator('#local-video').setInputFiles(file);
    await expect(other.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    await other.locator('.profile-button').click();
    await other.getByLabel('Display name (optional)').fill('W'.repeat(48));
    await other.getByRole('button', { name: 'Save name', exact: true }).click();
    await other.keyboard.press('Escape');
    await expect(page.locator('.roster')).toContainText('W'.repeat(48));
    const playerColors = () =>
      page.locator('.player-controls').evaluate((node) => ({
        text: getComputedStyle(node).color,
        button: getComputedStyle(node.querySelector('button')!).color,
      }));
    const darkPlayerColors = await playerColors();
    for (const [width, height] of [
      [3440, 1145],
      [1966, 654],
      [2560, 1080],
      [1440, 900],
      [1024, 768],
      [900, 500],
      [390, 844],
    ]) {
      await page.setViewportSize({ width: width!, height: height! });
      for (const colorScheme of ['light', 'dark'] as const) {
        await openAppPanel(page, 'Appearance');
        await page
          .getByRole('radio', {
            name: colorScheme === 'light' ? 'Light' : 'Dark',
            exact: true,
          })
          .check();
        await page.keyboard.press('Escape');
        expect(await playerColors()).toEqual(darkPlayerColors);
        expect(
          (await page.locator('.room').boundingBox())!.width,
        ).toBeLessThanOrEqual(1600);
        if (width! > 760) {
          const stage = (await page.locator('.video-stage').boundingBox())!;
          expect(Math.abs(stage.width - (stage.height * 16) / 9)).toBeLessThan(
            1,
          );
        }
        await page.screenshot({
          path: testInfo.outputPath(`room-${colorScheme}-${width}.png`),
          fullPage: true,
        });
      }
      if (width! > 760) {
        const members = page.locator('.room-actions button[aria-expanded]');
        for (const expanded of [false, true]) {
          await members.click();
          await expect(members).toHaveAttribute(
            'aria-expanded',
            String(expanded),
          );
          const stage = (await page.locator('.video-stage').boundingBox())!;
          expect(Math.abs(stage.width - (stage.height * 16) / 9)).toBeLessThan(
            1,
          );
          const toolbar = (await page.locator('.room-actions').boundingBox())!;
          const room = (await page.locator('.room').boundingBox())!;
          expect(toolbar.x).toBeGreaterThanOrEqual(room.x);
          expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(
            room.x + room.width,
          );
          if (width === 1966 && !expanded)
            await page.screenshot({
              path: testInfo.outputPath('room-short-without-sidebar.png'),
            });
        }
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      for (const control of [
        page.locator('.video-stage'),
        page.getByRole('button', { name: 'Fullscreen locally', exact: true }),
      ]) {
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width!);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(
      () => (document.documentElement.style.fontSize = '200%'),
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: testInfo.outputPath('room-200-percent.png'),
      fullPage: true,
    });
    await expectHeaderFits(page);
    await page.evaluate(() => (document.documentElement.style.fontSize = ''));
    await closeRoom(page);
    expect(failures).toEqual([]);
  } finally {
    await guest.close();
  }
});

// This distinct shell contract covers menu navigation and deployed release metadata.
test('settings groups local preferences and separates build identity from packaged versions', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await dismissHelper(page);
  const trigger = page.getByRole('button', { name: 'Settings', exact: true });
  const menu = page.getByRole('menu', { name: 'Settings', exact: true });
  const about = page.getByRole('dialog', { name: 'About', exact: true });
  await expect(
    page.getByRole('link', { name: 'Star Open Video Sync on GitHub' }),
  ).toBeVisible();
  await expect(page.locator('.repo-star-count')).toHaveText('1,234');
  await trigger.focus();
  await trigger.press('ArrowDown');
  await expect(
    menu.getByRole('menuitem', { name: 'Appearance' }),
  ).toBeFocused();
  const menuKeys = await observePageKeyboard(page);
  await page.keyboard.press('Control+k');
  await expect(page.locator('.command-palette')).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Language' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'About' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(
    menu.getByRole('menuitem', { name: 'Appearance' }),
  ).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(menu.getByRole('menuitem', { name: 'About' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await menuKeys.evaluate((state) => state.events)).toEqual([]);
  await menuKeys.evaluate((state) => state.stop());
  await menuKeys.dispose();
  await trigger.click();
  await page.getByRole('heading', { name: 'Start a watch party' }).click();
  await expect(menu).toBeHidden();
  await trigger.press('ArrowUp');
  await page.keyboard.press('Tab');
  await expect(menu).toBeHidden();
  await expect(page.locator('.profile-button')).toBeFocused();

  await openAppPanel(page, 'About');
  const release = Object.fromEntries(
    [
      ...readFileSync('../../versions.toml', 'utf8').matchAll(
        /^(sync|web|helper) = "([\d.]+)"$/gm,
      ),
    ].map(([, name, version]) => [name!, version!]),
  );
  const componentVersions = ['sync', 'web', 'helper'].map((name) => {
    const version = release[name];
    if (!version) throw new Error(`Missing ${name} release version.`);
    return version;
  });
  const componentValues = about.locator('.about-versions dd');
  await expect(componentValues).toHaveText(componentVersions);
  await about.evaluate((node) =>
    Promise.all(node.getAnimations().map((animation) => animation.finished)),
  );
  // The response is public, uncached metadata from the running artifact, not browser helper state.
  const response = await page.request.get('/api/v2/version');
  expect(response.headers()['cache-control']).toBe('no-store');
  const buildInfo = JSON.parse(
    execFileSync('node', ['../../scripts/versions.mjs', 'build-info'], {
      encoding: 'utf8',
    }),
  ) as {
    image: string;
    release: boolean;
    commit: string;
    dirty: boolean;
    tag: string;
  };
  const deployed = { ...release, ...buildInfo };
  expect(await response.json()).toEqual(deployed);
  const image = about.locator('header .about-image');
  const commit = about.locator('header .about-commit code');
  const dirty = about.locator('.about-dirty');
  const tag = about.locator('dt').filter({ hasText: /^Git tag$/ });
  await expect(image).toHaveText(buildInfo.image);
  if (!buildInfo.release && buildInfo.commit) {
    await expect(commit).toHaveText(buildInfo.commit.slice(0, 12));
    await expect(commit).toHaveAttribute('title', buildInfo.commit);
  } else await expect(commit).toHaveCount(0);
  await expect(dirty).toHaveCount(
    !buildInfo.release && buildInfo.dirty ? 1 : 0,
  );
  await expect(tag).toHaveCount(0);
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.screenshot({
      path: testInfo.outputPath(`about-${width}.png`),
      animations: 'disabled',
    });
    const bounds = await about.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width!);
    expect(
      await about.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.screenshot({ path: testInfo.outputPath('settings-mobile.png') });
  await page.keyboard.press('Escape');

  // Build-state visibility is separate from component versions and local helper state.
  for (const info of [
    {
      image: `registry.example.invalid:5000/${'long-project-name-'.repeat(8)}/ovs:dev`,
      release: false,
      commit: 'a'.repeat(40),
      dirty: true,
      tag: `v1.2.3-${'long-tag-'.repeat(24)}`,
    },
    {
      image: 'ovs:v2026-11-02',
      release: true,
      commit: 'b'.repeat(40),
      dirty: false,
      tag: 'v2026-11-02',
    },
    {
      image: 'ovs:dev',
      release: false,
      commit: 'c'.repeat(40),
      dirty: false,
      tag: 'v2026-11-02',
    },
    { image: 'ovs:dev', release: false, commit: '', dirty: false, tag: '' },
  ]) {
    await page.route('**/api/v2/version', (route) =>
      route.fulfill({ json: { ...release, ...info } }),
    );
    await openAppPanel(page, 'About');
    await expect(componentValues).toHaveText(componentVersions);
    await expect(image).toHaveText(info.image);
    await expect(about.locator('.about-build-label')).toHaveText(
      'Build information',
    );
    if (!info.release && info.commit) {
      await expect(commit).toHaveText(info.commit.slice(0, 12));
      await expect(commit).toHaveAttribute('title', info.commit);
    } else await expect(commit).toHaveCount(0);
    await expect(dirty).toHaveCount(!info.release && info.dirty ? 1 : 0);
    await expect(tag).toHaveCount(0);
    if (info.release || info.dirty) {
      await about.evaluate((node) =>
        Promise.all(
          node.getAnimations().map((animation) => animation.finished),
        ),
      );
      await page.screenshot({
        path: testInfo.outputPath(
          info.release ? 'about-release-390.png' : 'about-long-image-390.png',
        ),
        animations: 'disabled',
      });
    }
    expect(
      await about.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await page.keyboard.press('Escape');
    await page.unroute('**/api/v2/version');
  }

  // A failed or malformed metadata response offers recovery without showing raw errors.
  for (const body of [
    'unavailable',
    JSON.stringify({ ...deployed, helper: 'invalid' }),
    JSON.stringify({ ...deployed, commit: 'invalid' }),
    JSON.stringify({ ...deployed, dirty: 'false' }),
    JSON.stringify({ ...deployed, image: 'ovs:dev\nunsafe' }),
    JSON.stringify({ ...deployed, release: 'false' }),
  ]) {
    await page.route('**/api/v2/version', (route) =>
      route.fulfill({
        status: body === 'unavailable' ? 503 : 200,
        contentType: 'application/json',
        body,
      }),
    );
    await openAppPanel(page, 'About');
    await expect(about.getByRole('status')).toContainText(
      'Versions are unavailable',
    );
    await expect(about.locator('dd')).toHaveCount(0);
    await page.unroute('**/api/v2/version');
    await about.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(componentValues).toHaveText(componentVersions);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
  }
  await expect(page.locator('#toast-region')).toHaveAttribute(
    'data-position',
    'right',
  );
  const mainTop = (await page.getByRole('main').boundingBox())!.y;
  for (const position of ['Left', 'Center']) {
    await openAppPanel(page, 'Notifications');
    await page.getByRole('radio', { name: position, exact: true }).check();
    await page.keyboard.press('Escape');
    await expect(page.locator('#toast-region')).toHaveAttribute(
      'data-position',
      position.toLowerCase(),
    );
    expect((await page.getByRole('main').boundingBox())!.y).toBe(mainTop);
  }
  await page.reload();
  await dismissHelper(page);
  await expect(page.locator('#toast-region')).toHaveAttribute(
    'data-position',
    'center',
  );
  await page.screenshot({
    path: testInfo.outputPath('toast-mobile-center.png'),
  });
  await openAppPanel(page, 'Notifications');
  await expect(
    page.getByRole('radio', { name: 'Center', exact: true }),
  ).toBeChecked();
  await page.keyboard.press('Escape');
});

// Appearance is a browser preference, independent of identity and room lifecycle.
// This scenario covers manual modes, ignored system changes, persistence, and storage failure.
test('appearance defaults to dark and preserves manual local choices', async ({
  page,
}, testInfo) => {
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  const background = () =>
    page
      .locator('html')
      .evaluate((node) => getComputedStyle(node).backgroundColor);
  const accent = () =>
    page
      .locator('.create-submit')
      .evaluate((node) => getComputedStyle(node).backgroundColor);
  const appearance = page.locator('.app-settings-trigger');
  const openAppearance = () => openAppPanel(page, 'Appearance');
  const dialog = page.getByRole('dialog', { name: 'Appearance', exact: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await dismissHelper(page);
  await expect(
    page.getByRole('heading', { name: 'Start a watch party' }),
  ).toBeVisible();
  const dark = await background();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(background).toBe(dark);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(background).toBe(dark);
  await openAppearance();
  // Sample the rendered production animation: a seconds/ms conversion error makes this opaque.
  const enteringOpacity = await dialog.evaluate((node) => {
    const animation = node.getAnimations()[0]!;
    animation.pause();
    animation.currentTime = 50;
    const opacity = Number(getComputedStyle(node).opacity);
    animation.finish();
    return opacity;
  });
  expect(enteringOpacity).toBeGreaterThan(0);
  expect(enteringOpacity).toBeLessThan(1);
  await expect(
    page.getByRole('radio', { name: 'Dark', exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole('radio', { name: 'System', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('radio', { name: 'Light', exact: true }).check();
  await expect.poll(background).not.toBe(dark);
  const light = await background();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(background).toBe(light);
  const slate = await accent();
  await page.getByRole('radio', { name: 'Soft iris' }).check();
  await expect.poll(accent).not.toBe(slate);
  const iris = await accent();
  // Native radio arrow navigation changes the selected color without moving focus away.
  await page.getByRole('radio', { name: 'Soft iris' }).press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Graphite' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Graphite' })).toBeFocused();
  await expect(
    page
      .locator('.appearance-choice')
      .filter({ hasText: 'Graphite' })
      .locator('.appearance-tile'),
  ).toHaveCSS('outline-style', 'none');
  await expect.poll(accent).not.toBe(iris);
  await page.screenshot({ path: testInfo.outputPath('appearance-light.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(appearance).toBeFocused();
  await page.reload();
  await dismissHelper(page);
  await expect.poll(background).toBe(light);
  await openAppearance();
  await expect(
    page.getByRole('radio', { name: 'Light', exact: true }),
  ).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Graphite' })).toBeChecked();
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await expect.poll(background).toBe(dark);
  await page.getByRole('radio', { name: 'Slate blue' }).check();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath('appearance-dark-mobile.png'),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press('Escape');
  await expect(appearance).toBeFocused();
  await openAppearance();
  await page.getByRole('radio', { name: 'Quiet teal' }).check();
  const teal = await accent();
  await page.keyboard.press('Escape');
  await page.reload();
  await dismissHelper(page);
  await expect.poll(accent).toBe(teal);
  await openAppearance();
  await expect(page.getByRole('radio', { name: 'Quiet teal' })).toBeChecked();
  await dialog.evaluate((node) =>
    Promise.all(node.getAnimations().map((animation) => animation.finished)),
  );
  await page.screenshot({
    path: testInfo.outputPath('appearance-expanded-mobile.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  // Keyboard entry/exit is immediate; reduced motion uses a short fade without scaling.
  await appearance.press('ArrowDown');
  await page
    .getByRole('menuitem', { name: 'Appearance', exact: true })
    .press('Enter');
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate(
      (node) =>
        node.getAnimations().filter((a) => a.playState === 'running').length,
    ),
  ).toBe(0);
  await page.keyboard.press('Escape');
  // Close during entry and reopen immediately; no stranded focus trap or stale callback.
  for (let repeat = 0; repeat < 2; repeat++) {
    await openAppearance();
    await dialog
      .getByRole('button', { name: 'Close dialog' })
      .click({ force: true });
    await expect(dialog).toHaveCount(0);
    await expect(appearance).toBeFocused();
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openAppearance();
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((node) => getComputedStyle(node).transform),
  ).toBe('none');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(appearance).toBeFocused();
  // Malformed, unknown, and legacy system values fall back to dark/slate without breaking startup.
  for (const invalid of [
    '{bad',
    JSON.stringify({ mode: 'system', accent: 'slate' }),
    JSON.stringify({ mode: 'sepia', accent: 'unknown' }),
  ]) {
    await page.evaluate(
      (value) => localStorage.setItem('ovs.appearance', value),
      invalid,
    );
    await page.reload();
    await dismissHelper(page);
    await expect.poll(background).toBe(dark);
    await openAppearance();
    await expect(
      page.getByRole('radio', { name: 'Dark', exact: true }),
    ).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Slate blue' })).toBeChecked();
    await page.keyboard.press('Escape');
  }
  await page.addInitScript(() => {
    Storage.prototype.getItem = () => {
      throw new DOMException('Blocked', 'SecurityError');
    };
    Storage.prototype.setItem = () => {
      throw new DOMException('Blocked', 'SecurityError');
    };
  });
  await page.reload();
  await dismissHelper(page);
  await openAppearance();
  await page.getByRole('radio', { name: 'Light', exact: true }).check();
  await expect.poll(background).toBe(light);
  await expect(dialog.getByRole('status')).toContainText(
    'storage is unavailable',
  );
  expect(failures).toEqual([]);
});

// Language owns a separate browser-local preference. This journey verifies rendered text,
// existing failures, system changes, room playback, cross-tab storage, and blocked storage.
test.describe('interface language', () => {
  test.use({ locale: 'zh-TW' });
  test('follows the system and switches open workflows without changing room state', async ({
    page,
    browser,
  }, testInfo) => {
    test.setTimeout(60000);
    const failures: string[] = [];
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('console', (event) => {
      if (/intlify|message compilation|not found.*locale/i.test(event.text()))
        failures.push(event.text());
    });
    const language = async () => {
      const locale = await page.locator('html').getAttribute('lang');
      await openAppPanel(page, locale === 'zh-CN' ? '语言' : 'Language');
    };
    const selectLanguage = async (value: 'system' | 'zh-CN' | 'en') => {
      await language();
      await page.locator(`input[name="language"][value="${value}"]`).check();
      await page.keyboard.press('Escape');
    };
    const systemLanguage = async (values: string[]) => {
      await page.evaluate((languages) => {
        Object.defineProperty(navigator, 'languages', {
          configurable: true,
          value: languages,
        });
        window.dispatchEvent(new Event('languagechange'));
      }, values);
    };
    const dismissChineseHelper = async () => {
      await expect(
        page.getByRole('complementary', { name: '播放助手' }),
      ).not.toContainText('正在检查', { timeout: 8000 });
      const later = page.getByRole('button', { name: '稍后', exact: true });
      if (await later.isVisible()) await later.click();
    };
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await dismissChineseHelper();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await expect(page).toHaveTitle('一起观看 · Open Video Sync');
    await expect(page.locator('header [role="status"]')).toHaveText(
      '服务器：就绪',
    );
    expect(
      await page.evaluate(() => localStorage.getItem('ovs.language')),
    ).toBeNull();
    await page.screenshot({
      path: testInfo.outputPath('i18n-home-zh.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '本地文件', exact: true }).click();
    await page.getByRole('button', { name: '创建房间', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText(
      '请先选择支持的视频文件',
    );
    await selectLanguage('en');
    await expect(page.getByRole('alert')).toContainText(
      'Select a supported video file first.',
    );
    await expect(page.getByLabel('Room name', { exact: false })).toBeVisible();
    await page.reload();
    await dismissHelper(page);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await systemLanguage(['zh-HK']);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');

    const file = {
      name: 'private-language-video.webm',
      mimeType: 'video/webm',
      buffer: await generatedVideo(browser, 6),
    };
    const title = 'Locale <b>聚会 😀</b>';
    await createLocalRoom(page, file, title);
    const videoSource = await page.locator('video').getAttribute('src');
    const before = await (
      await page.request.get(`/api/v2${new URL(page.url()).pathname}`)
    ).json();
    await selectLanguage('zh-CN');
    await expect(page).toHaveTitle('房间 · Open Video Sync');
    await expect(
      page.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId('media-status')).toHaveText('已就绪');
    await expect(page.getByTestId('playback-phase')).toHaveText('已暂停');
    await expect(
      page.getByRole('button', { name: '一起播放', exact: true }),
    ).toBeEnabled();
    await expect(page.locator('.playback-status')).toContainText('已连接');
    expect(await page.locator('video').getAttribute('src')).toBe(videoSource);
    const after = await (
      await page.request.get(`/api/v2${new URL(page.url()).pathname}`)
    ).json();
    expect(after.revision).toBe(before.revision);
    expect(after.mediaGeneration).toBe(before.mediaGeneration);
    expect(after.title).toBe(title);
    await page.getByRole('button', { name: '邀请', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: '一起看，更精彩' }),
    ).toContainText(title);
    await expect(page.locator('.modal b')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '房间设置', exact: true }).click();
    await expect(page.getByLabel('播放控制权限', { exact: true })).toHaveValue(
      'host',
    );
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({
      path: testInfo.outputPath('i18n-room-zh-mobile.png'),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await openAppPanel(page, '外观');
    await expect(
      page.getByRole('radio', { name: '石板蓝', exact: true }),
    ).toBeChecked();
    await page.keyboard.press('Escape');
    await language();
    await page.screenshot({
      path: testInfo.outputPath('i18n-language-zh-mobile.png'),
      animations: 'disabled',
    });
    await page.locator('input[name="language"][value="system"]').check();
    await page.keyboard.press('Escape');
    await systemLanguage(['de-DE', 'zh-CN']);
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(
      page.getByRole('button', { name: 'Play together', exact: true }),
    ).toBeEnabled();
    await closeRoom(page);
    await expect(page.locator('.app-message')).toContainText(
      `You closed “${title}”.`,
    );
    await systemLanguage(['zh-CN']);
    await expect(page.locator('.app-message')).toContainText(
      `你已关闭“${title}”。`,
    );

    // An actual storage event from another same-origin tab updates the open page.
    const other = await page.context().newPage();
    try {
      await other.goto('/');
      await other.evaluate(() => localStorage.setItem('ovs.language', 'en'));
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await other.evaluate(() =>
        localStorage.setItem('ovs.language', 'invalid'),
      );
      await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    } finally {
      await other.close();
    }
    await page.reload();
    await dismissChineseHelper();
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.addInitScript(() => {
      Storage.prototype.getItem = () => {
        throw new DOMException('Blocked', 'SecurityError');
      };
      Storage.prototype.setItem = () => {
        throw new DOMException('Blocked', 'SecurityError');
      };
    });
    await page.reload();
    await dismissChineseHelper();
    await language();
    await page.locator('input[name="language"][value="en"]').check();
    await expect(
      page
        .getByRole('dialog', { name: 'Language', exact: true })
        .getByRole('status'),
    ).toContainText('storage is unavailable');
    await page.keyboard.press('Escape');
    await expect(page).toHaveTitle('Watch together · Open Video Sync');
    expect(failures).toEqual([]);
  });
});
