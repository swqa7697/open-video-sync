import { expect, test } from '../../modules/web/playwright-fixtures';
import { generatedVideo } from './media';
import { closeRoom, invitationLink } from './flows';
import release from '../../modules/helper/dist/release.json';

test('previewing another Bilibili link preserves the active helper and room until confirmation', async ({
  page,
  browser,
}) => {
  const response = await page.request.get('/userscripts/ovs-bilibili.user.js');
  expect(response.ok()).toBe(true);
  const script = await response.text();
  // Run the distributed helper against synthetic metadata and delayed media reads.
  // Playback remains a real local video; the opaque helper handle represents an active stream.
  await page.addInitScript({
    content: `(() => {
    const unsafeWindow = window;
    const GM_xmlhttpRequest = (details) => {
      let cancelled = false;
      const media = new URL(details.url).pathname.startsWith('/upgcxcode/');
      const timer = setTimeout(() => {
        if (cancelled) return;
        if (media) {
          const range = details.headers.Range.match(/bytes=(\\d+)-(\\d+)/);
          const bytes = new Uint8Array(Number(range[2]) - Number(range[1]) + 1).fill(42);
          details.onload({ status: 206, finalUrl: details.url, response: bytes.buffer });
          return;
        }
        const url = new URL(details.url);
        let data;
        if (url.pathname.endsWith('/view')) data = {
          title: 'Replacement preview', pages: [{ page: 1, cid: 2 }]
        };
        else if (url.pathname.endsWith('/nav')) data = { isLogin: false };
        else if (url.pathname.endsWith('/playurl')) {
          const track = { id: 32, codecs: 'avc1.64001E', mimeType: 'video/mp4',
            baseUrl: 'https://cdn.bilivideo.com/upgcxcode/synthetic.m4s?token=SYNTHETIC_REPLACEMENT_CANARY',
            SegmentBase: { Initialization: '0-31', indexRange: '32-63' }
          };
          data = { timelength: 5000, dash: { video: [track, { ...track, codecs: 'av01.0.08M.08' }], audio: [
            { ...track, id: 30216, codecs: 'mp4a.40.2', mimeType: 'audio/mp4' }
          ] } };
        } else throw Error('Unexpected platform request');
        details.onload({ status: 200, finalUrl: details.url,
          responseText: JSON.stringify({ code: sessionStorage.getItem('deny-preview') ? -404 : 0, data }) });
      }, media ? 1000 : 0);
      return { abort() { cancelled = true; clearTimeout(timer); details.onabort?.(); } };
    };
    ${script}
  })();`,
  });
  const helper = (op: string, args: Record<string, unknown> = {}) =>
    page.evaluate(
      ({ op, args }) =>
        new Promise<{
          ok: boolean;
          value?: { handle?: string };
          error?: string;
        }>((resolve, reject) => {
          const id = Math.floor(Math.random() * 1000000) + 1;
          const client = 'a'.repeat(32);
          const receive = (event: MessageEvent) => {
            if (
              event.source !== window ||
              event.origin !== location.origin ||
              typeof event.data !== 'string'
            )
              return;
            const reply = JSON.parse(event.data);
            if (
              reply.channel !== 'ovs-bilibili-response' ||
              reply.client !== client ||
              reply.id !== id
            )
              return;
            clearTimeout(timer);
            window.removeEventListener('message', receive);
            resolve(reply);
          };
          const timer = setTimeout(() => {
            window.removeEventListener('message', receive);
            reject(new Error('Synthetic helper call timed out'));
          }, 5000);
          window.addEventListener('message', receive);
          window.postMessage(
            JSON.stringify({
              channel: 'ovs-bilibili-request',
              client,
              id,
              op,
              ...args,
            }),
            location.origin
          );
        }),
      { op, args }
    );
  await page.goto('/');
  const file = {
    name: 'original.webm',
    mimeType: 'video/webm',
    buffer: await generatedVideo(browser, 5),
  };
  await page.getByRole('button', { name: 'Local file', exact: true }).click();
  await page.locator('#create-local-video').setInputFiles(file);
  await page
    .getByLabel('Room name', { exact: false })
    .fill('Media replacement');
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'ready'
  );
  expect((await helper('hello', { version: 1 })).ok).toBe(true);
  const opened = await helper('open', {
    bvid: 'BV1hf4y1N75G',
    part: 1,
    generation: 1,
  });
  expect(opened.ok).toBe(true);
  const read = {
    handle: opened.value!.handle,
    track: 0,
    offset: 0,
    length: 32,
    generation: 1,
  };
  const roomPath = `/api/v2${new URL(page.url()).pathname}`;
  const before = await (await page.request.get(roomPath)).json();
  await page.getByRole('button', { name: 'Change video', exact: true }).click();
  await page
    .getByLabel('Video URL or BV identifier')
    .fill('https://www.bilibili.com/video/BV17Jx76CEje');
  const reading = helper('bytes', read);
  await page
    .getByRole('button', { name: 'Preview video', exact: true })
    .click();
  await expect(page.locator('.media-preview')).toHaveText(
    'Replacement preview'
  );
  expect((await reading).ok).toBe(true);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  const after = await (await page.request.get(roomPath)).json();
  expect(after.media).toEqual(before.media);
  expect(after.mediaGeneration).toBe(before.mediaGeneration);
  expect((await helper('bytes', read)).ok).toBe(true);
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'ready'
  );
  await page.getByRole('button', { name: 'Change video', exact: true }).click();
  await page.evaluate(() => sessionStorage.setItem('deny-preview', '1'));
  await page.getByLabel('Video URL or BV identifier').fill('BV17Jx76CEje');
  await page
    .getByRole('button', { name: 'Preview video', exact: true })
    .click();
  await expect(page.locator('.media-picker [role="alert"]')).toContainText(
    'unavailable'
  );
  expect((await helper('bytes', read)).ok).toBe(true);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  expect(await page.locator('body').innerText()).not.toContain(
    'SYNTHETIC_REPLACEMENT_CANARY'
  );
  await page.getByRole('button', { name: 'Change video', exact: true }).click();
  await page.getByRole('button', { name: 'Local file', exact: true }).click();
  await page.locator('#create-local-video').setInputFiles({
    ...file,
    name: 'replacement.webm',
    buffer: await generatedVideo(browser, 6),
  });
  await page
    .getByRole('dialog', { name: 'Change the video', exact: true })
    .press('Enter');
  await expect
    .poll(
      async () =>
        (await (await page.request.get(roomPath)).json()).media.durationMs
    )
    .toBe(6000);
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'ready'
  );
  await expect(
    page.getByRole('button', { name: 'Change video', exact: true })
  ).toBeEnabled();
  await closeRoom(page);
});

test('Bilibili helper failures preserve local playback and dispose closed rooms', async ({
  page,
  browser,
  baseURL,
}) => {
  const parts = release.version.split('.').map(Number);
  const previous = [...parts];
  const lastNonzero = previous.findLastIndex((value) => value > 0);
  if (lastNonzero >= 0) previous[lastNonzero]! -= 1;
  const older = lastNonzero >= 0 ? previous.join('.') : undefined;
  const firstNewer = `${parts[0]}.${parts[1]}.${parts[2]! + 1}`;
  const newer = `${parts[0]! + 1}.0.0`;
  const foreign: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).hostname.endsWith('bilibili.com'))
      foreign.push(r.url());
  });
  await page.addInitScript(
    (expected) => {
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
                      ? (expected.older ?? expected.firstNewer)
                      : mode === 'future'
                        ? expected.newer
                        : expected.version,
                  maxChunk: 262144,
                  ...(mode === 'same-version-old-build'
                    ? {}
                    : { build: expected.build }),
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
    },
    { version: release.version, build: release.build, older, firstNewer, newer }
  );
  await page.goto('/');
  await expect(page.getByRole('dialog')).toContainText('not detected');
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await page.evaluate(() =>
    sessionStorage.setItem('synthetic-helper', 'same-version-old-build')
  );
  await page.getByRole('button', { name: 'Reload page', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('needs an update');
  await expect(page.getByRole('dialog')).toContainText(
    `Installed ${release.version} · Required ${release.version}`
  );
  await expect(page.getByRole('dialog').getByRole('link')).toHaveText(
    'Update helper'
  );
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await page.getByLabel('Video URL or BV identifier').fill('BV1hf4y1N75G');
  await page.evaluate(() => sessionStorage.setItem('synthetic-helper', 'old'));
  await page.getByRole('button', { name: 'Reload page', exact: true }).click();
  // The development version 0.0.0 has no older valid release. The component
  // regression covers outdated-helper onboarding with a fixed newer requirement.
  await expect(page.getByRole('dialog')).toContainText(
    older ? 'needs an update' : 'does not match'
  );
  await expect(page.getByRole('dialog')).toContainText(
    `Installed ${older ?? firstNewer} · Required ${release.version}`
  );
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await page.evaluate(() =>
    sessionStorage.setItem('synthetic-helper', 'future')
  );
  await page.getByRole('button', { name: 'Reload page', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('does not match');
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await page.evaluate(() =>
    sessionStorage.setItem('synthetic-helper', 'signed-out')
  );
  await page.getByRole('button', { name: 'Reload page', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'Playback helper' })
  ).toHaveCount(0);
  await page.getByLabel('Video URL or BV identifier').fill('BV1hf4y1N75G');
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
  const danmaku = page.locator('.danmaku-toggle');
  const preferences = page.getByRole('dialog', {
    name: 'Danmaku settings',
    exact: true,
  });
  await danmaku.hover();
  await expect(preferences).toBeVisible();
  expect(
    await preferences.evaluate((panel) => panel.scrollWidth - panel.clientWidth)
  ).toBe(0);
  await page
    .getByRole('slider', { name: 'Danmaku density', exact: true })
    .hover();
  await expect(preferences).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(preferences).toHaveCount(0);
  await danmaku.press('ArrowDown');
  await expect(
    page.getByRole('slider', { name: 'Danmaku density', exact: true })
  ).toBeFocused();
  const speed = page.getByRole('slider', {
    name: 'Danmaku speed',
    exact: true,
  });
  await expect(speed).toHaveValue('1');
  await speed.focus();
  await speed.press('Home');
  await expect(speed).toHaveValue('0.5');
  await speed.press('ArrowRight');
  await expect(speed).toHaveValue('0.6');
  await expect(speed).toHaveAttribute('aria-valuetext', '0.6 times speed');
  const area = preferences.getByRole('combobox', {
    name: 'Scrolling area',
    exact: true,
  });
  await expect(area).toHaveValue('0.5');
  await area.selectOption('1');
  const fullHeight = await page
    .locator('.danmaku-overlay')
    .evaluate((overlay) => overlay.clientHeight);
  for (const fraction of [0.5, 0.25, 1]) {
    await area.selectOption(String(fraction));
    await expect(area).toHaveValue(String(fraction));
    // Fixed comments retain the full overlay while scrolling lanes are bounded separately.
    expect(
      await page
        .locator('.danmaku-overlay')
        .evaluate((overlay) => overlay.clientHeight)
    ).toBe(fullHeight);
  }
  await area.selectOption('0.25');
  await page.keyboard.press('Escape');
  await expect(danmaku).toBeFocused();
  await expect(preferences).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'access_denied'
  );
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1024, height: 600 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    // Resize closes player menus; reopen after the browser delivers that event.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    );
    await danmaku.focus();
    await danmaku.press('ArrowDown');
    await expect(preferences).toBeVisible();
    await expect(area).toHaveValue('0.25');
    expect(
      await preferences.evaluate(
        (panel) => panel.scrollWidth - panel.clientWidth
      )
    ).toBe(0);
    if (viewport.width === 1440)
      expect(
        await preferences.evaluate(
          (panel) => panel.scrollHeight - panel.clientHeight
        )
      ).toBe(0);
    const reload = preferences.getByRole('button', {
      name: 'Reload danmaku',
      exact: true,
    });
    await reload.scrollIntoViewIfNeeded();
    await expect(reload).toBeInViewport();
    await page.keyboard.press('Escape');
    await expect(danmaku).toBeFocused();
    await expect(preferences).toHaveCount(0);
  }
  await expect(danmaku).toHaveAttribute('aria-pressed', 'true');
  const enabledIcon = await danmaku.locator('path').getAttribute('d');
  await page
    .getByRole('heading', { name: 'Bilibili helper boundaries', exact: true })
    .click();
  await page.keyboard.press('d');
  await expect(danmaku).toHaveAttribute('aria-pressed', 'false');
  expect(await danmaku.locator('path').getAttribute('d')).not.toBe(enabledIcon);
  await danmaku.click();
  await expect(danmaku).toHaveAttribute('aria-pressed', 'true');
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
    .getByRole('dialog', { name: 'Change the video', exact: true })
    .press('Enter');
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'ready'
  );
  const invitation = await invitationLink(page);
  const guest = await browser.newContext();
  try {
    const other = await guest.newPage();
    await other.goto(invitation);
    const roomURL = `${baseURL}/rooms/${room.snapshot.roomId}`;
    await expect(other).toHaveURL(roomURL);
    const setup = other.getByRole('dialog', {
      name: 'Set up Bilibili playback',
      exact: true,
    });
    await expect(setup).toContainText('not detected');
    const beforeInstall = await (await other.request.get('/api/v2/me')).json();
    const script = await other.request.get('/userscripts/ovs-bilibili.user.js');
    expect(script.ok()).toBe(true);
    // Start the actual distributed helper on the next document, as installation does.
    // This local-media journey needs no privileged platform requests.
    await other.addInitScript({
      content: `(() => {
        const unsafeWindow = window;
        const GM_xmlhttpRequest = () => { throw new Error('Unexpected platform request'); };
        ${await script.text()}
      })();`,
    });
    const reloaded = other.waitForEvent('load');
    await setup
      .getByRole('button', { name: 'Reload page', exact: true })
      .click();
    await reloaded;
    await expect(other).toHaveURL(roomURL);
    await expect(
      other.getByRole('heading', {
        name: 'Bilibili helper boundaries',
        exact: true,
      })
    ).toBeVisible();
    await expect(
      other.getByRole('complementary', { name: 'Playback helper' })
    ).toHaveCount(0);
    await expect(
      other.getByRole('button', { name: 'Join', exact: true })
    ).toHaveCount(0);
    const afterInstall = await (await other.request.get('/api/v2/me')).json();
    expect(afterInstall.identity.identityId).toBe(
      beforeInstall.identity.identityId
    );
    const restored = await (
      await other.request.get(`/api/v2/rooms/${room.snapshot.roomId}`)
    ).json();
    expect(restored.members).toHaveLength(2);
    expect(await invitationLink(page)).toBe(invitation);
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
