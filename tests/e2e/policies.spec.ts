import {
  createLocalRoom,
  invitationLink,
  dismissHelper,
  settings,
  seekTo,
} from './flows';
import { expect, test } from '../../web/playwright-fixtures';
import { generatedVideo } from './media';

test('waiting timeout, buffering, ready late joining, and host absence preserve controller permissions', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(110000);
  const fixture = await generatedVideo(browser, 60),
    guest = await browser.newContext();
  const file = {
    name: 'policy-fixture.webm',
    mimeType: 'video/webm',
    buffer: fixture,
  };
  try {
    await page.goto('/');
    await createLocalRoom(
      page,
      { name: 'synthetic.webm', mimeType: 'video/webm', buffer: fixture },
      'Policies and recovery'
    );
    await expect(
      page.getByRole('status').filter({ hasText: 'Clock calibrated' })
    ).toBeVisible();
    await settings(page, 'everyone');
    const roomURL = page.url(),
      invitation = await invitationLink(page);
    const other = await guest.newPage();
    await other.goto(invitation);
    await dismissHelper(other);
    await expect(
      other.getByRole('status').filter({ hasText: 'Clock calibrated' })
    ).toBeVisible();
    await page.locator('#local-video').setInputFiles(file);
    await expect(page.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready'
    );
    await page
      .getByRole('button', { name: 'Play together', exact: true })
      .click();
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'waiting'
    );
    await seekTo(page, Number('5'));
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: /Waiting at 5\.0 seconds for .*Guest [0-9a-f]+\./ })
    ).toBeVisible();
    await expect(
      page.getByText('Waiting timed out.', { exact: false })
    ).toBeVisible({
      timeout: 33000,
    });
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'paused'
    );
    // A participant with control permission can explicitly retry after timeout.
    await other.locator('#local-video').setInputFiles(file);
    await expect(other.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready'
    );
    await other
      .getByRole('button', { name: 'Play together', exact: true })
      .click();
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'playing'
    );
    // Inject adapter events to test the browser-to-server policy path; this is not a network starvation measurement.
    await other
      .locator('video')
      .evaluate((v) => v.dispatchEvent(new Event('waiting')));
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'waiting'
    );
    await other
      .locator('video')
      .evaluate((v) => v.dispatchEvent(new Event('canplay')));
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'playing'
    );
    await page
      .getByRole('button', { name: 'Pause together', exact: true })
      .click();
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'paused'
    );
    // Reconnect while paused, then close the guest before the next play cohort is frozen.
    await other.close();
    await page
      .getByRole('button', { name: 'Play together', exact: true })
      .click();
    await expect(page.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'playing'
    );
    const late = await guest.newPage();
    await late.goto(roomURL);
    await dismissHelper(late);
    await expect(
      late.getByRole('status').filter({ hasText: 'Clock calibrated' })
    ).toBeVisible();
    await late.locator('#local-video').setInputFiles(file);
    await expect(late.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready'
    );
    await expect
      .poll(() =>
        late.locator('video').evaluate((v) => !(v as HTMLVideoElement).paused)
      )
      .toBe(true);
    await page.close();
    await late
      .getByRole('button', { name: 'Pause together', exact: true })
      .click();
    await expect(late.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'paused'
    );
    await late
      .getByRole('button', { name: 'Play together', exact: true })
      .click();
    await expect(late.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'playing'
    );
    const returned = await page.context().newPage();
    await returned.goto(roomURL);
    await dismissHelper(returned);
    await returned.locator('#local-video').setInputFiles(file);
    await expect(returned.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready'
    );
    await expect(late.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'playing'
    );
    await returned.screenshot({
      path: testInfo.outputPath('policies.png'),
      fullPage: true,
    });
    // Explicit host departure changes server permission while preserving actual playback.
    await settings(returned, 'host');
    await returned.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(
      late.getByRole('status').filter({
        hasText: 'The host left. Everyone can now control playback.',
      })
    ).toBeVisible();
    await late
      .getByRole('button', { name: 'Pause together', exact: true })
      .click();
    await expect
      .poll(() =>
        late
          .locator('video')
          .evaluate((video: HTMLVideoElement) => video.paused)
      )
      .toBe(true);
    await late.getByRole('button', { name: 'Leave', exact: true }).click();
    await expect(
      late.getByRole('heading', { name: 'Start a watch party', exact: true })
    ).toBeVisible();
    expect(
      (await late.request.get(`/api/v2${new URL(roomURL).pathname}`)).status()
    ).toBe(404);
    await returned.close();
  } finally {
    await guest.close();
  }
});
