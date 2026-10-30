import { expect, test } from '../../web/playwright-fixtures';
import { generatedVideo } from './media';
import { closeRoom, createLocalRoom, dismissHelper, invitationLink, settings } from './flows';

test('independent identities manage a private room over direct HTTP', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error('Browser base URL required.');
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  const guest = await browser.newContext(),
    outsider = await browser.newContext();
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
    await expect(page.locator('header [role="status"]')).toHaveText('Server: ready');
    await expect(page).toHaveTitle('Watch together · Open Video Sync');
    for (const landmark of ['banner', 'main', 'contentinfo'] as const)
      await expect(page.getByRole(landmark)).toHaveCount(1);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    await dismissHelper(page);
    const firstIdentity = await (await page.request.get('/api/v2/me')).json();
    await page.locator('.profile-button').click();
    await page.getByLabel('Display name (optional)').fill('<b>Alice 😀</b>');
    await page.getByLabel('Display name (optional)').press('Enter');
    await expect(page.getByLabel('Display name (optional)')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('.profile-button')).toBeFocused();
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
    ]) {
      await page.setViewportSize({ width: width!, height: height! });
      await page.screenshot({ path: testInfo.outputPath(`home-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await createLocalRoom(page, file, 'Friday watch party');
    await expect(page.getByRole('heading', { name: 'Friday watch party' })).toBeFocused();
    await expect(page).toHaveTitle('Room · Open Video Sync');
    expect(await page.locator('video').getAttribute('src')).toMatch(/^blob:/);
    const roomURL = page.url(),
      inviteURL = await invitationLink(page);
    await expect(page.locator('.roster')).toContainText('<b>Alice 😀</b>');
    expect(await page.locator('.roster b').count()).toBe(0);
    await other.goto(inviteURL);
    await dismissHelper(other);
    expect(new URL(other.url()).hash).toBe('');
    await expect(other.getByRole('button', { name: 'Join', exact: true })).toHaveCount(0);
    await expect(other.getByRole('heading', { name: 'Friday watch party' })).toBeVisible();
    await expect(other.locator('#control-note')).toContainText('Only the host');
    await other.locator('#local-video').setInputFiles(file);
    await expect(other.getByTestId('media-status')).toHaveAttribute('data-state', 'ready');
    const guestIdentity = await (await guest.request.get(`${baseURL}/api/v2/me`)).json();
    expect(guestIdentity.identity.identityId).not.toBe(firstIdentity.identity.identityId);
    await other.locator('.profile-button').click();
    await other.getByLabel('Display name (optional)').fill('W'.repeat(48));
    await other.getByRole('button', { name: 'Save name', exact: true }).click();
    await other.keyboard.press('Escape');
    await expect(page.locator('.roster')).toContainText('W'.repeat(48));
    for (const [width, height] of [
      [1440, 900],
      [1024, 768],
      [390, 844],
    ]) {
      await page.setViewportSize({ width: width!, height: height! });
      await page.screenshot({ path: testInfo.outputPath(`room-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      for (const control of [
        page.locator('.video-stage'),
        page.getByRole('button', { name: 'Fullscreen locally', exact: true }),
        page.getByRole('button', { name: 'Player settings', exact: true }),
      ]) {
        const bounds = await control.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width!);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: testInfo.outputPath('room-200-percent.png'), fullPage: true });
    await page.evaluate(() => (document.documentElement.style.fontSize = ''));
    await settings(page, 'everyone', false);
    // Real pointer seeking inside the custom player changes the observed media position.
    const seek = page.getByRole('slider', { name: 'Seek', exact: true });
    const box = await seek.boundingBox();
    if (!box) throw new Error('Seek control required.');
    await seek.click({ position: { x: box.width / 3, y: box.height / 2 } });
    await expect
      .poll(() => page.locator('video').evaluate((v: HTMLVideoElement) => v.currentTime))
      .toBeGreaterThan(3);
    await expect(
      page.getByRole('button', { name: 'Show danmaku locally', exact: true }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    const firstCode = (
      await page.getByLabel('Invitation code', { exact: true }).inputValue()
    ).replaceAll(' ', '');
    await page.getByRole('button', { name: 'Replace invitation', exact: true }).click();
    await expect(page.getByLabel('Invitation link', { exact: true })).not.toHaveValue(inviteURL);
    await page.keyboard.press('Escape');
    await outside.goto('/');
    await dismissHelper(outside);
    expect(
      (await outsider.request.get(`${baseURL}/api/v2${new URL(roomURL).pathname}`)).status(),
    ).toBe(404);
    expect((await (await outsider.request.get(`${baseURL}/api/v2/rooms`)).json()).rooms).toEqual(
      [],
    );
    await outside.getByLabel('Invitation link or code').fill(firstCode);
    await outside.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(outside.getByRole('alert')).toContainText('unavailable');
    await page.getByRole('button', { name: /^Remove / }).click();
    await expect(page.locator('.roster li')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Participants', exact: true })).toBeFocused();
    await expect(other.getByRole('status').filter({ hasText: 'You were removed' })).toBeVisible();
    await closeRoom(page);
    await expect(
      page.getByRole('heading', { name: 'Start a watch party', exact: true }),
    ).toBeFocused();
    expect((await page.request.get(`/api/v2${new URL(roomURL).pathname}`)).status()).toBe(404);
    await page.locator('.profile-button').click();
    await page.getByRole('button', { name: 'Forget this identity', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm forget', exact: true }).click();
    await expect(page.locator('.app-message')).toContainText('A new identity is active.');
    const changed = await (await page.request.get('/api/v2/me')).json();
    expect(changed.identity.identityId).not.toBe(firstIdentity.identity.identityId);
    await page.keyboard.press('Escape');
    const cookie = (await page.context().cookies()).find((c) => c.name === 'ovs_session');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('Lax');
    expect(cookie?.secure).toBe(false);
    expect(
      await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } })),
    ).toEqual({ local: {}, session: {} });
    expect(failures).toEqual([]);
  } finally {
    await guest.close();
    await outsider.close();
  }
});
