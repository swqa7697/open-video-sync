import { expect, test } from '../../web/playwright-fixtures';
import { generatedVideo } from './media';
test('Bilibili helper failures preserve local playback and dispose closed rooms', async ({
  page,
  browser,
}) => {
  const foreign: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).hostname.endsWith('bilibili.com')) foreign.push(r.url());
  });
  // One synthetic helper: absent by default, then outdated, then signed out of Bilibili.
  await page.addInitScript(() => {
    window.addEventListener('message', (event) => {
      const mode = sessionStorage.getItem('synthetic-helper');
      if (!mode || event.source !== window || typeof event.data !== 'string') return;
      const q = JSON.parse(event.data);
      if (q.channel !== 'ovs-bilibili-request' || q.op === 'dispose') return;
      const reply =
        q.op === 'hello'
          ? {
              ok: true,
              value: { version: 1, helper: mode === 'old' ? '0.2.0' : '1.0.0', maxChunk: 262144 },
            }
          : { ok: false, error: 'login-required' };
      window.postMessage(
        JSON.stringify({ channel: 'ovs-bilibili-response', client: q.client, id: q.id, ...reply }),
        location.origin,
      );
    });
  });
  await page.goto('/');
  await page.getByLabel('Room title', { exact: true }).fill('Bilibili helper boundaries');
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Clock calibrated' })).toBeVisible();
  const invitation = await page.getByLabel('Invitation link').inputValue();
  await page
    .getByLabel('Bilibili video URL or BV identifier')
    .fill('https://b23.tv/synthetic-private-query');
  await page.getByRole('button', { name: 'Select Bilibili video', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('canonical video URL');
  await page.getByLabel('Bilibili video URL or BV identifier').fill('BV1hf4y1N75G');
  await page.getByRole('button', { name: 'Select Bilibili video', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Install or enable');
  expect(await page.locator('video').getAttribute('src')).toBeNull();
  await page.evaluate(() => sessionStorage.setItem('synthetic-helper', 'old'));
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Clock calibrated' })).toBeVisible();
  await page.getByLabel('Bilibili video URL or BV identifier').fill('BV1hf4y1N75G');
  await page.getByRole('button', { name: 'Select Bilibili video', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Update the OVS');
  await expect(page.getByRole('alert').getByRole('button', { name: 'Reload page' })).toBeVisible();
  expect(await page.locator('video').getAttribute('src')).toBeNull();
  // Platform access failure stays local but reaches the room as readiness, not media.
  await page.evaluate(() => sessionStorage.setItem('synthetic-helper', 'signed-out'));
  await page.reload();
  await expect(page.getByRole('status').filter({ hasText: 'Clock calibrated' })).toBeVisible();
  await page.getByLabel('Bilibili video URL or BV identifier').fill('BV1hf4y1N75G');
  await page.getByRole('button', { name: 'Select Bilibili video', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Sign in to Bilibili');
  await expect(page.getByTestId('media-status')).toHaveAttribute('data-state', 'access_denied');
  await expect(page.locator('.roster')).toContainText('Platform access unavailable');
  await expect(page.getByTestId('playback-phase')).toHaveAttribute('data-state', 'empty');
  const file = {
    name: 'helper-fallback.webm',
    mimeType: 'video/webm',
    buffer: await generatedVideo(browser, 5),
  };
  await page.locator('#local-video').setInputFiles(file);
  await expect(page.getByTestId('media-status')).toHaveAttribute('data-state', 'ready');
  const guest = await browser.newContext();
  try {
    const other = await guest.newPage();
    await other.goto(invitation);
    await other.getByRole('button', { name: 'Join room', exact: true }).click();
    await expect(other.getByRole('status').filter({ hasText: 'Clock calibrated' })).toBeVisible();
    await other.locator('#local-video').setInputFiles(file);
    await expect(other.getByTestId('media-status')).toHaveAttribute('data-state', 'ready');
    await page.getByRole('button', { name: 'Close room', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm close room', exact: true }).click();
    await expect(
      other
        .getByRole('status')
        .filter({ hasText: 'The host closed “Bilibili helper boundaries”.' }),
    ).toBeVisible();
    await expect(other.locator('video')).toHaveCount(0);
    await expect(other.getByRole('heading', { name: 'Your rooms', exact: true })).toBeFocused();
    await expect(other.getByRole('button', { name: 'Use this tab', exact: true })).toHaveCount(0);
  } finally {
    await guest.close();
  }
  expect(foreign).toEqual([]);
});
