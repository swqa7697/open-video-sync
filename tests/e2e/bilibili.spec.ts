import { expect, test } from '../../modules/web/playwright-fixtures';
import { generatedVideo } from './media';
import { closeRoom, dismissHelper, invitationLink } from './flows';
import release from '../../modules/helper/dist/release.json';
test('Bilibili helper failures preserve local playback and dispose closed rooms', async ({
  page,
  browser,
  baseURL,
}) => {
  const foreign: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).hostname.endsWith('bilibili.com'))
      foreign.push(r.url());
  });
  await page.addInitScript((expected) => {
    window.addEventListener('message', (event) => {
      const mode = sessionStorage.getItem('synthetic-helper');
      if (!mode || event.source !== window || typeof event.data !== 'string')
        return;
      const q = JSON.parse(event.data);
      if (q.channel !== 'ovs-bilibili-request' || q.op === 'dispose') return;
      const reply =
        q.op === 'hello' || q.op === 'probe'
          ? {
              ok: true,
              value: {
                version: 1,
                helper:
                  mode === 'old'
                    ? '1.0.0'
                    : mode === 'future'
                      ? '9.0.0'
                      : expected,
                maxChunk: 262144,
              },
            }
          : { ok: false, error: 'login-required' };
      window.postMessage(
        JSON.stringify({
          channel: 'ovs-bilibili-response',
          client: q.client,
          id: q.id,
          ...reply,
        }),
        location.origin
      );
    });
  }, release.version);
  await page.goto('/');
  await expect(page.getByRole('dialog')).toContainText('not detected');
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await page.getByLabel('Video URL or BV identifier').fill('BV1hf4y1N75G');
  await page.evaluate(() => sessionStorage.setItem('synthetic-helper', 'old'));
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('needs an update');
  await expect(page.getByRole('dialog')).toContainText(
    `Installed 1.0.0 · Required ${release.version}`
  );
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await page.evaluate(() =>
    sessionStorage.setItem('synthetic-helper', 'future')
  );
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('does not match');
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await page.evaluate(() =>
    sessionStorage.setItem('synthetic-helper', 'signed-out')
  );
  await page.getByRole('button', { name: 'Recheck', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'Playback helper' })
  ).toHaveCount(0);
  await expect(page.getByLabel('Video URL or BV identifier')).toHaveValue(
    'BV1hf4y1N75G'
  );
  await page
    .getByRole('button', { name: 'Preview video', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('Sign in to Bilibili');
  // Synthetic stable metadata isolates automatic entry from live provider availability.
  const session = await (await page.request.get('/api/v2/me')).json();
  const created = await page.request.post('/api/v2/rooms', {
    headers: {
      Origin: baseURL!,
      'X-OVS-CSRF': session.csrfToken,
      'Idempotency-Key': Buffer.from(
        crypto.getRandomValues(new Uint8Array(16))
      ).toString('hex'),
    },
    data: {
      title: 'Bilibili helper boundaries',
      settings: { controllers: 'host', waitForAll: true },
      media: {
        kind: 'bilibili',
        bvid: 'BV1hf4y1N75G',
        cid: '1',
        part: 1,
        durationMs: 5000,
      },
    },
  });
  expect(created.status()).toBe(200);
  const room = await created.json();
  await page.goto(`/rooms/${room.snapshot.roomId}`);
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'access_denied'
  );
  await expect(page.getByRole('alert')).toContainText('Sign in to Bilibili');
  await expect(page.locator('.roster')).toContainText(
    'Platform access unavailable'
  );
  await expect(page.getByTestId('playback-phase')).toHaveAttribute(
    'data-state',
    'paused'
  );
  const file = {
    name: 'helper-fallback.webm',
    mimeType: 'video/webm',
    buffer: await generatedVideo(browser, 5),
  };
  await page.getByRole('button', { name: 'Change video', exact: true }).click();
  await page.getByRole('button', { name: 'Local file', exact: true }).click();
  await page.locator('#create-local-video').setInputFiles(file);
  await page
    .getByRole('button', { name: 'Use this video', exact: true })
    .click();
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'ready'
  );
  const invitation = await invitationLink(page);
  const guest = await browser.newContext();
  try {
    const other = await guest.newPage();
    await other.goto(invitation);
    await dismissHelper(other);
    await other.locator('#local-video').setInputFiles(file);
    await expect(other.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready'
    );
    await closeRoom(page);
    await expect(
      other.getByRole('status').filter({ hasText: 'The host closed' })
    ).toBeVisible();
    await expect(other.locator('video')).toHaveCount(0);
    await expect(
      other.getByRole('heading', { name: 'Start a watch party', exact: true })
    ).toBeFocused();
  } finally {
    await guest.close();
  }
  expect(foreign).toEqual([]);
});
