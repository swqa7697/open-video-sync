import { writeFile } from 'node:fs/promises';
import { expect, test } from '../../web/playwright-fixtures';
import { generatedVideo } from './media';
test.use({ trace: 'off' });
test.describe('autoplay permission', () => {
  // DOM snapshots and callback resolution can activate a document. Observe setup through console events only.
  test('a browser denial requires an explicit local playback gesture', async ({
    browser,
    browserName,
    baseURL,
  }, testInfo) => {
    test.setTimeout(30000);
    const fixture = await generatedVideo(browser, 10, true),
      restricted = await browser.browserType().launch(
        browserName === 'firefox'
          ? {
              firefoxUserPrefs: {
                'media.autoplay.default': 1,
                'media.autoplay.blocking_policy': 0,
              },
            }
          : { args: ['--autoplay-policy=user-gesture-required'] },
      );
    const host = await browser.newContext(),
      guest = await restricted.newContext();
    try {
      const h = await host.newPage();
      await h.goto(baseURL!);
      await h.getByLabel('Room title', { exact: true }).fill('Autoplay permission');
      await h.getByRole('button', { name: 'Create room', exact: true }).click();
      await expect(h.getByRole('status').filter({ hasText: 'Clock calibrated' })).toBeVisible();
      const response = await guest.request.post(`${baseURL}/api/v1/session`, {
        headers: { Origin: baseURL! },
        data: {},
      });
      expect(response.status()).toBe(200);
      const session = await response.json();
      const code = (await h.locator('.invite-code').innerText()).replaceAll(' ', '');
      const joined = await guest.request.post(`${baseURL}/api/v1/invitations/redeem`, {
        headers: {
          Origin: baseURL!,
          'X-OVS-CSRF': session.csrfToken,
          'Idempotency-Key': Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
            'hex',
          ),
        },
        data: { code },
      });
      expect(joined.status()).toBe(200);
      await h
        .locator('#local-video')
        .setInputFiles({ name: 'opus-vp8.webm', mimeType: 'video/webm', buffer: fixture });
      await expect(h.getByTestId('media-status')).toHaveText('ready');
      let ready: () => void = () => {},
        blocked: () => void = () => {};
      const readyPromise = new Promise<void>((resolve) => {
          ready = resolve;
        }),
        blockedPromise = new Promise<void>((resolve) => {
          blocked = resolve;
        });
      await guest.addInitScript((base64) => {
        addEventListener('DOMContentLoaded', () => {
          let selected = false,
            last = '';
          const timer = setInterval(() => {
            const input = document.querySelector<HTMLInputElement>('#local-video'),
              status = document.querySelector('[data-testid=media-status]')?.textContent;
            if (input && !input.disabled && !selected) {
              selected = true;
              const checkbox = document.querySelector<HTMLInputElement>(
                '.player-panel input[type=checkbox]',
              )!;
              checkbox.checked = false;
              checkbox.dispatchEvent(new Event('change', { bubbles: true }));
              const transfer = new DataTransfer();
              transfer.items.add(
                new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'opus-vp8.webm', {
                  type: 'video/webm',
                }),
              );
              input.files = transfer.files;
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            if (status && status !== last) {
              last = status;
              console.log(`ovs-autoplay-status:${status}`);
            }
            if (status === 'gesture_required') clearInterval(timer);
          }, 25);
        });
      }, fixture.toString('base64'));
      const p = await guest.newPage();
      p.on('console', (message) => {
        if (message.text() === 'ovs-autoplay-status:ready') ready();
        if (message.text() === 'ovs-autoplay-status:gesture_required') blocked();
      });
      await p.goto(h.url());
      await readyPromise;
      await h.getByRole('button', { name: 'Play together', exact: true }).click();
      await blockedPromise;
      await expect(h.getByTestId('playback-phase')).toHaveText('waiting');
      await p.getByRole('button', { name: 'Enable playback', exact: true }).click();
      await expect
        .poll(() => p.locator('video').evaluate((v) => !(v as HTMLVideoElement).paused))
        .toBe(true);
      await expect(p.getByTestId('media-status')).toHaveText('ready');
      await writeFile(
        testInfo.outputPath('autoplay-result.json'),
        JSON.stringify({
          browserName,
          browserVersion: restricted.version(),
          nativePolicy:
            browserName === 'firefox'
              ? 'media.autoplay.default=1; media.autoplay.blocking_policy=0'
              : 'user-gesture-required',
          source: 'generated VP8/Opus',
          permissionDenied: true,
          explicitEnableSucceeded: true,
          defaultWaitAllHeldForGesture: true,
        }) + '\n',
      );
    } finally {
      await host.close();
      await guest.close();
      await restricted.close();
    }
  });
});
