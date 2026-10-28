import { expect, test } from '../../web/playwright-fixtures';
import { generatedVideo } from './media';

test('waiting timeout, exclusion, buffering, late joining, and host return preserve explicit intent', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(70000);
  const fixture = await generatedVideo(browser, 60),
    guest = await browser.newContext();
  const file = { name: 'policy-fixture.webm', mimeType: 'video/webm', buffer: fixture };
  try {
    await page.goto('/');
    await page.getByLabel('Room title', { exact: true }).fill('Policies and recovery');
    await page.getByRole('button', { name: 'Create room', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Clock calibrated' })).toBeVisible();
    await page.getByLabel('Wait timeout (ms)').fill('5000');
    await page.getByLabel('Playback controls').selectOption('everyone');
    await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
    const roomURL = page.url(),
      invitation = await page.getByLabel('Invitation link').inputValue();
    const other = await guest.newPage();
    await other.goto(invitation);
    await other.getByRole('button', { name: 'Join room', exact: true }).click();
    await expect(other.getByRole('status').filter({ hasText: 'Clock calibrated' })).toBeVisible();
    await page.locator('#local-video').setInputFiles(file);
    await expect(page.getByTestId('media-status')).toHaveText('ready');
    await page.getByRole('button', { name: 'Play together', exact: true }).click();
    await expect(page.getByTestId('playback-phase')).toHaveText('waiting');
    await page.getByLabel('Seek to seconds').fill('5');
    await page.getByRole('button', { name: 'Seek together', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Waiting for participants at 5.0' }),
    ).toBeVisible();
    await expect(page.getByText('Waiting timed out.', { exact: false })).toBeVisible({
      timeout: 8000,
    });
    await expect(page.getByTestId('playback-phase')).toHaveText('paused');
    await page.getByRole('button', { name: /^Exclude .* from waiting$/ }).click();
    await page.getByRole('button', { name: 'Play together', exact: true }).click();
    await expect(page.getByTestId('playback-phase')).toHaveText('playing');
    await other.locator('#local-video').setInputFiles(file);
    await expect
      .poll(() => other.locator('video').evaluate((v) => !(v as HTMLVideoElement).paused))
      .toBe(true);
    await page.getByRole('button', { name: /^Include .* in waiting$/ }).click();
    // Inject adapter events to test the browser-to-server policy path; this is not a network starvation measurement.
    await other.locator('video').evaluate((v) => v.dispatchEvent(new Event('waiting')));
    await expect(page.getByTestId('playback-phase')).toHaveText('waiting');
    await other.locator('video').evaluate((v) => v.dispatchEvent(new Event('canplay')));
    await expect(page.getByTestId('playback-phase')).toHaveText('playing');
    await page.getByLabel('Late joining').selectOption('wait_at_next_play');
    await page.getByRole('button', { name: 'Save preferences', exact: true }).click();
    await expect(page.getByTestId('playback-phase')).toHaveText('paused');
    // Reconnect while paused, then close the guest before the next play cohort is frozen.
    await other.close();
    await page.getByRole('button', { name: 'Play together', exact: true }).click();
    await expect(page.getByTestId('playback-phase')).toHaveText('playing');
    const late = await guest.newPage();
    await late.goto(roomURL);
    await expect(late.getByRole('status').filter({ hasText: 'Clock calibrated' })).toBeVisible();
    await late.locator('#local-video').setInputFiles(file);
    await expect(late.getByTestId('media-status')).toHaveText('ready');
    await expect(
      late.getByText('You are outside active playback.', { exact: false }),
    ).toBeVisible();
    expect(await late.locator('video').evaluate((v) => (v as HTMLVideoElement).paused)).toBe(true);
    await page.getByRole('button', { name: 'Play together', exact: true }).click();
    await expect
      .poll(() => late.locator('video').evaluate((v) => !(v as HTMLVideoElement).paused))
      .toBe(true);
    await page.close();
    await expect(late.getByTestId('playback-phase')).toHaveText('paused', { timeout: 20000 });
    await late.getByRole('button', { name: 'Play together', exact: true }).click();
    await expect(late.getByRole('alert')).toBeVisible();
    await expect(late.getByTestId('playback-phase')).toHaveText('paused');
    const returned = await page.context().newPage();
    await returned.goto(roomURL);
    await returned.locator('#local-video').setInputFiles(file);
    await expect(returned.getByTestId('media-status')).toHaveText('ready');
    await returned.getByRole('button', { name: 'Play together', exact: true }).click();
    await expect(late.getByTestId('playback-phase')).toHaveText('playing');
    await returned.screenshot({ path: testInfo.outputPath('policies.png'), fullPage: true });
    await returned.close();
  } finally {
    await guest.close();
  }
});
