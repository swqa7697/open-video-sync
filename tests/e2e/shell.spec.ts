import { expect, test } from '../../web/playwright-fixtures';

test('independent identities manage a private room over direct HTTP', async ({
  page,
  browser,
  baseURL,
}, testInfo) => {
  if (!baseURL) throw new Error('Browser base URL required.');
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  const guest = await browser.newContext();
  const outsider = await browser.newContext();
  try {
    const guestPage = await guest.newPage(),
      outsiderPage = await outsider.newPage();
    guestPage.on('pageerror', (error) => failures.push(error.message));
    await page.goto('/');
    await expect(page.locator('header [role="status"]')).toHaveText('Server: ready');
    await expect(page.getByLabel('Display name (optional)')).toBeEnabled();
    await expect(page).toHaveTitle('Your rooms · Open Video Sync');
    for (const landmark of ['banner', 'main', 'contentinfo'] as const)
      await expect(page.getByRole(landmark)).toHaveCount(1);
    // Keyboard only: skip link, saving a name, and creating a room keep focus useful.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('main')).toBeFocused();
    const firstIdentity = await (await page.request.get('/api/v2/me')).json();
    await page.getByLabel('Display name (optional)').fill('<b>Alice 😀</b>');
    await page.getByLabel('Display name (optional)').press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Name saved.' })).toBeVisible();
    await expect(page.getByLabel('Display name (optional)')).toBeFocused();
    await page.getByLabel('Room title', { exact: true }).fill('Stage one room');
    await page.getByLabel('Room title', { exact: true }).press('Enter');
    await expect(page.getByRole('heading', { name: 'Stage one room' })).toBeFocused();
    await expect(page).toHaveTitle('Room · Open Video Sync');
    const roomURL = page.url();
    const inviteURL = await page.getByLabel('Invitation link').inputValue();
    await page.getByRole('button', { name: 'Share invitation', exact: true }).click();
    await expect(page.getByLabel('Invitation link')).toHaveValue(inviteURL);
    const firstCode = (await page.locator('.invite-code').innerText()).replaceAll(' ', '');
    await expect(page.locator('.roster')).toContainText('<b>Alice 😀</b>');
    expect(await page.locator('.roster b').count()).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('host-room.png'), fullPage: true });
    await guestPage.goto(inviteURL);
    await expect(guestPage.getByRole('button', { name: 'Join room', exact: true })).toBeFocused();
    await expect(guestPage).toHaveTitle('Join a room · Open Video Sync');
    expect(new URL(guestPage.url()).hash).toBe('');
    await guestPage.keyboard.press('Enter');
    await expect(guestPage.getByRole('heading', { name: 'Stage one room' })).toBeFocused();
    await expect(guestPage.locator('#control-note')).toContainText('Only the host can play');
    const guestIdentity = await (await guest.request.get(`${baseURL}/api/v2/me`)).json();
    expect(guestIdentity.identity.identityId).not.toBe(firstIdentity.identity.identityId);
    await guestPage.reload();
    await expect(guestPage.getByRole('heading', { name: 'Stage one room' })).toBeVisible();
    const returnedIdentity = await (await guest.request.get(`${baseURL}/api/v2/me`)).json();
    expect(returnedIdentity.identity.identityId).toBe(guestIdentity.identity.identityId);
    await outsiderPage.goto(baseURL);
    await expect(outsiderPage.getByLabel('Display name (optional)')).toBeEnabled();
    const denied = await outsider.request.get(`${baseURL}/api/v2${new URL(roomURL).pathname}`);
    expect(denied.status()).toBe(404);
    const listing = await (await outsider.request.get(`${baseURL}/api/v2/rooms`)).json();
    expect(listing.rooms).toEqual([]);
    // Unbroken worst-case names must wrap instead of widening the room.
    await guestPage.getByLabel('Display name (optional)').fill('W'.repeat(48));
    await guestPage.getByRole('button', { name: 'Save name', exact: true }).click();
    await expect(guestPage.getByRole('status').filter({ hasText: 'Name saved.' })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh room', exact: true }).click();
    await expect(page.locator('.roster li')).toHaveCount(2);
    await expect(page.locator('.roster')).toContainText('W'.repeat(48));
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        await page.screenshot({
          path: testInfo.outputPath(`room-${width}-${colorScheme}.png`),
          fullPage: true,
        });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page
      .getByRole('combobox', { name: 'Playback controls', exact: true })
      .selectOption('everyone');
    await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Preferences saved.' })).toBeVisible();
    await expect(guestPage.locator('#control-note')).not.toContainText('Only the host');
    await page.getByRole('button', { name: 'Replace invitation', exact: true }).click();
    await expect(page.getByLabel('Invitation link')).not.toHaveValue(inviteURL);
    await outsiderPage.getByLabel('Invitation code', { exact: true }).fill(firstCode);
    await outsiderPage.getByRole('button', { name: 'Join room', exact: true }).click();
    await expect(outsiderPage.getByRole('alert')).toContainText('unavailable');
    await page.getByRole('button', { name: /^Remove / }).click();
    await expect(page.locator('.roster li')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Participants' })).toBeFocused();
    // The removed participant leaves the room view with the reason, not a stale room.
    await expect(
      guestPage.getByRole('status').filter({ hasText: 'You were removed' }),
    ).toBeVisible();
    // Focus stays on a control that still exists; remote endings do not steal it.
    await expect(guestPage.getByRole('button', { name: 'Save name', exact: true })).toBeFocused();
    expect(new URL(guestPage.url()).pathname).toBe('/');
    await page.getByRole('button', { name: 'Close room', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(
      page.getByRole('button', { name: 'Confirm close room', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Your rooms', exact: true })).toBeFocused();
    await expect(page).toHaveTitle('Your rooms · Open Video Sync');
    await expect(page.locator('.room-list li')).toHaveCount(0);
    await page.getByRole('button', { name: 'Forget this identity', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm forget', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'A new identity is active.' }),
    ).toBeVisible();
    const newIdentity = await (await page.request.get('/api/v2/me')).json();
    expect(newIdentity.identity.identityId).not.toBe(firstIdentity.identity.identityId);
    const cookies = await page.context().cookies();
    const sessionCookie = cookies.find((cookie) => cookie.name === 'ovs_session');
    expect(sessionCookie?.httpOnly).toBe(true);
    expect(sessionCookie?.sameSite).toBe('Lax');
    expect(sessionCookie?.secure).toBe(false);
    const storage = await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
      secure: isSecureContext,
    }));
    expect(storage.local).toEqual({});
    expect(storage.session).toEqual({});
    if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname))
      expect(storage.secure).toBe(false);
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        await page.screenshot({
          path: testInfo.outputPath(`landing-${width}-${colorScheme}.png`),
          fullPage: true,
        });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
    }
    expect(failures).toEqual([]);
  } finally {
    await guest.close();
    await outsider.close();
  }
});
