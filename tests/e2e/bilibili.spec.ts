import release from '../../modules/helper/dist/release.json';
import {
  appContext,
  expect,
  test,
} from '../../modules/web/playwright-fixtures';
import {
  clickPlayerControl,
  closeRoom,
  invitationLink,
  observePageKeyboard,
  seekTo,
} from './flows';
import { decodedFrame, generatedDASHMedia, generatedVideo } from './media';

test('playing Bilibili seeks recover decoded video through the real adapter and helper', async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  const tracks = await generatedDASHMedia(browser);
  const fixturePage = await browser.newPage();
  const sheets = await fixturePage.evaluate(() =>
    [0, 1].map((sheet) => {
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 540;
      const context = canvas.getContext('2d')!;
      for (let cell = 0; cell < 4; cell++) {
        context.fillStyle = `rgb(${24 + (sheet * 4 + cell) * 28},60,80)`;
        const x = (cell % 2) * 480,
          y = Math.floor(cell / 2) * 270;
        context.fillRect(x, y, 480, 270);
        context.fillStyle = '#fff';
        context.font = '60px sans-serif';
        context.fillText(`Scene ${sheet * 4 + cell + 1}`, x + 60, y + 150);
      }
      return canvas.toDataURL('image/png').split(',')[1]!;
    }),
  );
  await fixturePage.close();
  const response = await page.request.get('/userscripts/ovs-bilibili.user.js');
  const script = await response.text();
  await page.addInitScript({
    content: `(() => {
    sessionStorage.setItem('hold-thumbnails', '1');
    sessionStorage.setItem('thumbnail-requests', '0');
    sessionStorage.setItem('thumbnail-completed', '0');
    const tracks = ${JSON.stringify(tracks)};
    const sheets = ${JSON.stringify(sheets)};
    for (const track of tracks) track.data = Uint8Array.from(atob(track.bytes), c => c.charCodeAt(0));
    const unsafeWindow = window;
    const addBuffer = MediaSource.prototype.addSourceBuffer;
    MediaSource.isTypeSupported = () => true;
    MediaSource.prototype.addSourceBuffer = function(mime) {
      return addBuffer.call(this, mime.startsWith('video/')
        ? 'video/webm; codecs="vp8"' : 'audio/webm; codecs="opus"');
    };
    const held = new Set();
    const heldThumbnails = new Set();
    let owner, traffic, trafficID = 100000;
    window.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      try {
        const request = JSON.parse(event.data);
        if (request.channel === 'ovs-bilibili-request' && request.op === 'open') owner = request.client;
      } catch {}
    });
    document.addEventListener('begin-thumbnail-competition', () => {
      traffic = setInterval(() => {
        if (owner) window.postMessage(JSON.stringify({
          channel: 'ovs-bilibili-request', client: owner, id: ++trafficID, op: 'session'
        }), location.origin);
      }, 100);
    });
    document.addEventListener('end-thumbnail-competition', () => clearInterval(traffic));
    document.addEventListener('resume-thumbnails', () => {
      sessionStorage.removeItem('hold-thumbnails');
      for (const resume of [...heldThumbnails]) resume();
    });
    document.addEventListener('resume-seek-downloads', () => {
      for (const resume of [...held]) resume();
    });
    const GM_xmlhttpRequest = (details) => {
      let cancelled = false;
      const url = new URL(details.url);
      const thumbnail = url.pathname.endsWith('/videoshot') || url.hostname.endsWith('.hdslb.com');
      if (url.hostname.endsWith('.hdslb.com'))
        sessionStorage.setItem('thumbnail-requests', String(Number(sessionStorage.getItem('thumbnail-requests')) + 1));
      const respond = () => {
        held.delete(respond);
        heldThumbnails.delete(respond);
        if (cancelled) return;
        if (details.headers.Range) {
          const track = tracks[Number(url.searchParams.get('track'))];
          const range = details.headers.Range.match(/bytes=(\\d+)-(\\d+)/);
          const start = Number(range[1]), end = Number(range[2]);
          details.onload({ status: 206, finalUrl: details.url,
            response: track.data.slice(start, end + 1).buffer,
            responseHeaders: 'Content-Range: bytes ' + start + '-' + end + '/' + track.data.length });
          return;
        }
        let data;
        if (url.pathname.endsWith('/view')) data = {
          title: 'Streamed Bilibili seeks', pages: [{ cid: 1, page: 1 }],
          ugc_season: { title: 'Large collection', sections: [{
            episodes: Array(929).fill({
              bvid: 'BV17Jx76CEje', title: 'Episode', page: { page: 1 },
              arc: { desc: 'x'.repeat(5000) }
            })
          }] }
        };
        else if (url.pathname.endsWith('/pagelist')) data = [
          { cid: 1, page: 1, part: 'Streamed Bilibili seeks' }
        ];
        else if (url.pathname.endsWith('/videoshot')) data = {
          img_x_len: 2, img_y_len: 2, img_x_size: 480, img_y_size: 270,
          index: [0, 0, 3, 7, 11, 16, 21, 26, 29],
          image: ['//bimp.hdslb.com/videoshotpvhdboss/1.png', '//bimp.hdslb.com/videoshotpvhdboss/1-1.png'],
        };
        else if (url.hostname.endsWith('.hdslb.com')) {
          if (sessionStorage.getItem('fail-thumbnail')) sessionStorage.setItem('thumbnail-failures', String(Number(sessionStorage.getItem('thumbnail-failures')) + 1));
          else sessionStorage.setItem('thumbnail-completed', String(Number(sessionStorage.getItem('thumbnail-completed')) + 1));
          details.onload({ status: sessionStorage.getItem('fail-thumbnail') ? 404 : 200,
            finalUrl: details.url,
            response: Uint8Array.from(atob(sheets[url.pathname.endsWith('-1.png') ? 1 : 0]), c => c.charCodeAt(0)).buffer });
          return;
        }
        else if (url.pathname.endsWith('/playurl')) {
          const media = tracks.map((track, i) => ({
            id: i === 0 ? 120 : 30216,
            codecs: i === 0 ? 'avc1.64001E' : 'mp4a.40.2',
            mimeType: i === 0 ? 'video/mp4' : 'audio/mp4',
            baseUrl: 'https://cdn.bilivideo.com/upgcxcode/synthetic.m4s?track=' + i,
            SegmentBase: { Initialization: track.init.join('-'), indexRange: track.index.join('-') }
          }));
          data = { timelength: 30000, dash: { video: [media[0]], audio: [media[1]] } };
        } else if (url.pathname.endsWith('/seg.so')) {
          details.onload({ status: 200, finalUrl: details.url, response: new ArrayBuffer(0) });
          return;
        } else data = { isLogin: false };
        details.onload({ status: 200, finalUrl: details.url, responseText: JSON.stringify({ code: 0, data }) });
      };
      const timer = setTimeout(() => {
        if (thumbnail && sessionStorage.getItem('hold-thumbnails')) {
          heldThumbnails.add(respond);
          sessionStorage.setItem('thumbnail-held', '1');
        }
        else if (details.headers.Range && sessionStorage.getItem('hold-seek')) held.add(respond);
        else respond();
      }, details.headers.Range ? Number(sessionStorage.getItem('seek-delay') || 25) : url.hostname.endsWith('.hdslb.com') ? 500 : 0);
      return { abort() { cancelled = true; clearTimeout(timer); held.delete(respond); heldThumbnails.delete(respond); details.onabort(); } };
    };
    ${script}
  })();`,
  });
  await page.goto('/');
  await page.getByLabel('Video URL or BV identifier').fill('BV17Jx76CEje');
  await page
    .getByRole('button', { name: 'Preview video', exact: true })
    .click();
  await expect(page.locator('.media-preview')).toContainText(
    'Streamed Bilibili seeks',
  );
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'ready',
  );
  await expect(page.getByRole('tab', { name: /Episodes/ })).toHaveCount(0);
  const stage = page.locator('.video-stage');
  // Initial preparation and seeks complete while thumbnail metadata never replies.
  await expect
    .poll(() => page.evaluate(() => sessionStorage.getItem('thumbnail-held')))
    .toBe('1');
  await seekTo(page, 3);
  await expect.poll(() => decodedFrame(page)).toBeGreaterThanOrEqual(90);
  await seekTo(page, 0);
  await expect.poll(() => decodedFrame(page)).toBe(0);
  await stage.hover({ position: { x: 100, y: 100 } });
  const track = page.locator('.seek-track');
  const bounds = (await track.boundingBox())!;
  const hoverAt = (fraction: number) =>
    page.mouse.move(
      Math.round(bounds.x + bounds.width * fraction),
      bounds.y + bounds.height / 2,
    );
  const frameBeforeHover = await decodedFrame(page);
  await hoverAt(0.02);
  await expect(page.locator('.seek-preview')).toBeVisible();
  await expect(page.locator('.seek-preview canvas')).toBeHidden();
  await page.evaluate(() => {
    document.dispatchEvent(new Event('begin-thumbnail-competition'));
    document.dispatchEvent(new Event('resume-thumbnails'));
  });
  // Background work fills every sheet without requiring pointer movement.
  await expect
    .poll(() =>
      page.evaluate(() =>
        Number(sessionStorage.getItem('thumbnail-completed')),
      ),
    )
    .toBe(2);
  await page.evaluate(() =>
    document.dispatchEvent(new Event('end-thumbnail-competition')),
  );
  await expect(page.locator('.seek-preview canvas')).toBeVisible();
  const thumbnailRequests = await page.evaluate(() =>
    Number(sessionStorage.getItem('thumbnail-requests')),
  );
  for (const [fraction, scene] of [
    [0.02, 0],
    [0.27, 2],
    [0.45, 3],
    [0.85, 5],
    [0.98, 7],
  ] as const) {
    await hoverAt(fraction);
    const thumbnail = page.locator('.seek-preview canvas');
    await expect(thumbnail).toBeVisible();
    await expect
      .poll(() =>
        thumbnail.evaluate(
          (canvas: HTMLCanvasElement) =>
            canvas.getContext('2d')!.getImageData(10, 10, 1, 1).data[0],
        ),
      )
      .toBe(24 + scene * 28);
  }
  // Cached sheets remain usable when the CDN becomes unavailable.
  await page.evaluate(() => sessionStorage.setItem('fail-thumbnail', '1'));
  await hoverAt(0.08);
  await expect(page.locator('.seek-preview')).toHaveText('0:02');
  await expect(page.locator('.seek-preview canvas')).toBeVisible();
  await hoverAt(0.2);
  await hoverAt(0.95);
  await expect(page.locator('.seek-preview canvas')).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator('.seek-preview canvas')
        .evaluate(
          (canvas: HTMLCanvasElement) =>
            canvas.getContext('2d')!.getImageData(10, 10, 1, 1).data[0],
        ),
    )
    .toBe(24 + 6 * 28);
  expect(
    await page.evaluate(() =>
      Number(sessionStorage.getItem('thumbnail-requests')),
    ),
  ).toBe(thumbnailRequests);
  expect(await decodedFrame(page)).toBe(frameBeforeHover);
  await expect(page.locator('video')).toHaveJSProperty('paused', true);
  await page.mouse.move(0, 0);
  await expect(page.locator('.seek-preview')).toHaveCount(0);
  await clickPlayerControl(page, 'Play together');
  await expect.poll(() => decodedFrame(page)).toBeGreaterThan(5);
  await page.evaluate(() => sessionStorage.setItem('hold-seek', '1'));
  await seekTo(page, 20);
  const roomPath = `/api/v2${new URL(page.url()).pathname}`;
  await expect
    .poll(
      async () =>
        (await (await page.request.get(roomPath)).json()).barrier?.reason,
    )
    .toBe('buffering');
  await page.evaluate(() => {
    sessionStorage.removeItem('hold-seek');
    sessionStorage.setItem('seek-delay', '450');
    document.dispatchEvent(new Event('resume-seek-downloads'));
  });
  for (const target of [20, 7.9, 23.9, 2.9]) {
    if (target !== 20) await seekTo(page, target);
    await expect
      .poll(async () => {
        const frame = await decodedFrame(page);
        return frame > target * 30 + 5 && frame < (target + 3) * 30;
      })
      .toBe(true);
    await expect(page.locator('video')).toHaveJSProperty('paused', false);
  }
  await clickPlayerControl(page, 'Pause together');
  await expect(page.locator('video')).toHaveJSProperty('paused', true);
  await seekTo(page, 10);
  await expect.poll(() => decodedFrame(page)).toBeGreaterThanOrEqual(300);
  await closeRoom(page);
});

test('previewing another Bilibili link preserves the active helper and room until confirmation', async ({
  page,
  browser,
}) => {
  const response = await page.request.get('/userscripts/ovs-bilibili.user.js');
  expect(response.ok()).toBe(true);
  const script = await response.text();
  // Synthetic MP4 metadata drives preview/handle isolation.
  // Control capabilities for the synthetic MP4 metadata; local WebM stays native.
  // Codec selection is also covered by helper tests, and decoded playback by playback.spec.ts.
  await page.addInitScript({
    content: `(() => {
    const unsafeWindow = window;
    const nativeSupport = MediaSource.isTypeSupported.bind(MediaSource);
    MediaSource.isTypeSupported = (mime) => {
      if (mime === 'video/mp4; codecs="avc1.64001E"') return false;
      if (mime === 'video/mp4; codecs="av01.0.08M.08"') return true;
      if (mime === 'audio/mp4; codecs="mp4a.40.2"')
        return sessionStorage.getItem('preview-failure') !== 'no-audio';
      return nativeSupport(mime);
    };
    let holdNextRead = true;
    const GM_xmlhttpRequest = (details) => {
      let cancelled = false;
      const media = new URL(details.url).pathname.startsWith('/upgcxcode/');
      const respond = () => {
        if (cancelled) return;
        if (media) {
          if (sessionStorage.getItem('cdn-failure') === new URL(details.url).hostname) {
            details.onerror();
            return;
          }
          const range = details.headers.Range.match(/bytes=(\\d+)-(\\d+)/);
          const bytes = new Uint8Array(Number(range[2]) - Number(range[1]) + 1).fill(42);
          details.onload({ status: 206, finalUrl: details.url, response: bytes.buffer,
            responseHeaders: 'Content-Range: bytes ' + range[1] + '-' + range[2] + '/9007199254740991' });
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
            backupUrl: ['https://backup.bilivideo.com/upgcxcode/synthetic.m4s?token=SYNTHETIC_REPLACEMENT_CANARY'],
            SegmentBase: { Initialization: '0-31', indexRange: '32-63' }
          };
          data = { timelength: 5000, dash: { video: [track, { ...track, codecs: 'av01.0.08M.08' }], audio: [
            { ...track, id: 30216, codecs: 'mp4a.40.2', mimeType: 'audio/mp4' }
          ] } };
        } else throw Error('Unexpected platform request');
        details.onload({ status: 200, finalUrl: details.url,
          responseText: JSON.stringify({ code: sessionStorage.getItem('preview-failure') === 'access' ? -404 : 0, data }) });
      };
      if (media && holdNextRead) {
        holdNextRead = false;
        document.addEventListener('release-media-read', respond, { once: true });
        document.dispatchEvent(new Event('media-read-held'));
      } else queueMicrotask(respond);
      return { abort() {
        cancelled = true;
        document.removeEventListener('release-media-read', respond);
        details.onabort?.();
      } };
    };
    ${script}
  })();`,
  });
  const helper = (op: string, args: Record<string, unknown> = {}) =>
    page.evaluate(
      ({ op, args }) =>
        new Promise<{
          ok: boolean;
          value?: { handle?: string; tracks?: Array<{ codec: string }> };
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
            location.origin,
          );
        }),
      { op, args },
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
    'ready',
  );
  expect((await helper('hello', { version: 1 })).ok).toBe(true);
  const opened = await helper('open', {
    bvid: 'BV1hf4y1N75G',
    part: 1,
    generation: 1,
  });
  expect(opened.ok).toBe(true);
  expect(opened.value?.tracks?.map((track) => track.codec)).toEqual([
    'av01.0.08M.08',
    'mp4a.40.2',
  ]);
  const read = {
    handle: opened.value!.handle,
    track: 0,
    offset: 0,
    length: 32,
    generation: 1,
    seek: 0,
    end: 2 * 1024 * 1024 - 1,
    rate: 2 * 1024 * 1024,
  };
  const roomPath = `/api/v2${new URL(page.url()).pathname}`;
  const before = await (await page.request.get(roomPath)).json();
  const originalSource = await page
    .locator('video')
    .evaluate((video: HTMLVideoElement) => video.currentSrc);
  const expectOriginalMedia = async () => {
    const snapshot = await (await page.request.get(roomPath)).json();
    expect(snapshot.media).toEqual(before.media);
    expect(snapshot.mediaGeneration).toBe(before.mediaGeneration);
    await expect(page.locator('video')).toHaveJSProperty(
      'currentSrc',
      originalSource,
    );
    await expect(page.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready',
    );
  };
  await page.getByRole('button', { name: 'Change video', exact: true }).click();
  await page
    .getByLabel('Video URL or BV identifier')
    .fill('https://www.bilibili.com/video/BV17Jx76CEje');
  const held = page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        document.addEventListener('media-read-held', () => resolve(), {
          once: true,
        });
      }),
  );
  const reading = helper('bytes', read);
  await held;
  try {
    await page
      .getByRole('button', { name: 'Preview video', exact: true })
      .click();
    await expect(page.locator('.media-preview')).toHaveText(
      'Replacement preview',
    );
    await expectOriginalMedia();
  } finally {
    await page.evaluate(() =>
      document.dispatchEvent(new Event('release-media-read')),
    );
  }
  expect((await reading).ok).toBe(true);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expectOriginalMedia();
  expect((await helper('bytes', read)).ok).toBe(true);
  for (const [failure, text] of [
    ['access', 'unavailable'],
    ['no-audio', 'cannot decode'],
  ] as const) {
    await page
      .getByRole('button', { name: 'Change video', exact: true })
      .click();
    await page.evaluate(
      (mode) => sessionStorage.setItem('preview-failure', mode),
      failure,
    );
    await page.getByLabel('Video URL or BV identifier').fill('BV17Jx76CEje');
    await page
      .getByRole('button', { name: 'Preview video', exact: true })
      .click();
    await expect(page.locator('.media-picker [role="alert"]')).toContainText(
      text,
    );
    expect((await helper('bytes', read)).ok).toBe(true);
    await page
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
    await expectOriginalMedia();
  }
  expect(await page.locator('body').innerText()).not.toContain(
    'SYNTHETIC_REPLACEMENT_CANARY',
  );
  // Fail the primary, then the backup. Later reads must reuse the recovered primary.
  for (const [index, host] of [
    'cdn.bilivideo.com',
    'backup.bilivideo.com',
  ].entries()) {
    await page.evaluate(
      (value) => sessionStorage.setItem('cdn-failure', value),
      host,
    );
    expect(
      (
        await helper('bytes', {
          ...read,
          offset: (index + 1) * 2 * 1024 * 1024,
          end: (index + 2) * 2 * 1024 * 1024 - 1,
        })
      ).ok,
    ).toBe(true);
    await expectOriginalMedia();
  }
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
        (await (await page.request.get(roomPath)).json()).media.durationMs,
    )
    .toBe(6000);
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'ready',
  );
  await expect(
    page.getByRole('button', { name: 'Change video', exact: true }),
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
          location.origin,
        );
      });
    },
    {
      version: release.version,
      build: release.build,
      older,
      firstNewer,
      newer,
    },
  );
  await page.goto('/');
  await expect(page.getByRole('dialog')).toContainText('not detected');
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await page.evaluate(() =>
    sessionStorage.setItem('synthetic-helper', 'same-version-old-build'),
  );
  await page.getByRole('button', { name: 'Reload page', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('needs an update');
  await expect(page.getByRole('dialog')).toContainText(
    `Installed ${release.version} · Required ${release.version}`,
  );
  await expect(page.getByRole('dialog').getByRole('link')).toHaveText(
    'Update helper',
  );
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await page.getByLabel('Video URL or BV identifier').fill('BV1hf4y1N75G');
  await page.evaluate(() => sessionStorage.setItem('synthetic-helper', 'old'));
  await page.getByRole('button', { name: 'Reload page', exact: true }).click();
  // The development version 0.0.0 has no older valid release. The component
  // regression covers outdated-helper onboarding with a fixed newer requirement.
  await expect(page.getByRole('dialog')).toContainText(
    older ? 'needs an update' : 'does not match',
  );
  await expect(page.getByRole('dialog')).toContainText(
    `Installed ${older ?? firstNewer} · Required ${release.version}`,
  );
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await page.evaluate(() =>
    sessionStorage.setItem('synthetic-helper', 'future'),
  );
  await page.getByRole('button', { name: 'Reload page', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('does not match');
  await page.getByRole('button', { name: 'Later', exact: true }).click();
  await page.evaluate(() =>
    sessionStorage.setItem('synthetic-helper', 'signed-out'),
  );
  await page.getByRole('button', { name: 'Reload page', exact: true }).click();
  await expect(
    page.getByRole('complementary', { name: 'Playback helper' }),
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
        crypto.getRandomValues(new Uint8Array(16)),
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
    'access_denied',
  );
  await expect(page.getByRole('alert')).toContainText('Sign in to Bilibili');
  await expect(page.locator('.roster')).toContainText(
    'Platform access unavailable',
  );
  const danmaku = page.locator('.danmaku-toggle');
  const preferences = page.getByRole('dialog', {
    name: 'Danmaku settings',
    exact: true,
  });
  await danmaku.hover();
  await expect(preferences).toBeVisible();
  expect(
    await preferences.evaluate(
      (panel) => panel.scrollWidth - panel.clientWidth,
    ),
  ).toBe(0);
  await page
    .getByRole('slider', { name: 'Danmaku density', exact: true })
    .hover();
  await expect(preferences).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(preferences).toHaveCount(0);
  await danmaku.press('ArrowDown');
  await expect(
    page.getByRole('slider', { name: 'Danmaku density', exact: true }),
  ).toBeFocused();
  const density = page.getByRole('slider', {
    name: 'Danmaku density',
    exact: true,
  });
  const size = page.getByRole('slider', {
    name: 'Danmaku text size',
    exact: true,
  });
  await density.press('End');
  await size.press('End');
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
        .evaluate((overlay) => overlay.clientHeight),
    ).toBe(fullHeight);
  }
  await area.selectOption('0.25');
  const panelKeys = await observePageKeyboard(page);
  await page.keyboard.press('Control+k');
  await expect(page.locator('.command-palette')).toHaveCount(0);
  // Hover can open a panel while keyboard focus remains in the player beneath it.
  await danmaku.hover();
  const playerVolume = page.getByRole('slider', {
    name: 'Local volume',
    exact: true,
  });
  await playerVolume.focus();
  await expect(playerVolume).toBeFocused();
  const volume = await page.locator('#local-volume').inputValue();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('m');
  await page.keyboard.press('f');
  await expect(page.locator('#local-volume')).toHaveValue(volume);
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(danmaku).toBeFocused();
  await expect(preferences).toHaveCount(0);
  expect(await panelKeys.evaluate((state) => state.events)).toEqual([]);
  await panelKeys.evaluate((state) => state.stop());
  await panelKeys.dispose();
  // Wait for fullscreen layout before opening menus that close on resize.
  await Promise.all([
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          document.addEventListener(
            'fullscreenchange',
            () => requestAnimationFrame(() => resolve()),
            { once: true },
          ),
        ),
    ),
    clickPlayerControl(page, 'Fullscreen locally'),
  ]);
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true);
  await danmaku.press('ArrowDown');
  await expect(preferences).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preferences).toHaveCount(0);
  await expect(danmaku).toBeFocused();
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await page.keyboard.press('Escape');
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(false);
  await danmaku.press('Enter');
  await expect(danmaku).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'access_denied',
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
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    await danmaku.focus();
    await danmaku.press('ArrowDown');
    await expect(preferences).toBeVisible();
    await expect(danmaku).toHaveAttribute('aria-pressed', 'false');
    await expect(density).toHaveValue('40');
    await expect(size).toHaveValue('32');
    await expect(speed).toHaveValue('0.6');
    await expect(area).toHaveValue('0.25');
    expect(
      await preferences.evaluate(
        (panel) => panel.scrollWidth - panel.clientWidth,
      ),
    ).toBe(0);
    if (viewport.width === 1440)
      expect(
        await preferences.evaluate(
          (panel) => panel.scrollHeight - panel.clientHeight,
        ),
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
  await danmaku.press('Enter');
  await expect(danmaku).toHaveAttribute('aria-pressed', 'true');
  const enabledIcon = await danmaku.locator('path').getAttribute('d');
  await page.locator('.video-stage').hover({ position: { x: 100, y: 100 } });
  await page
    .getByRole('heading', { name: 'Bilibili helper boundaries', exact: true })
    .click();
  await expect(page.locator('.player-controls')).toHaveCSS('opacity', '0', {
    timeout: 500,
  });
  await page.keyboard.press('d');
  await expect(danmaku).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.player-controls')).toHaveCSS('opacity', '0', {
    timeout: 500,
  });
  expect(await danmaku.locator('path').getAttribute('d')).not.toBe(enabledIcon);
  await page.locator('.video-stage').hover({ position: { x: 100, y: 100 } });
  await danmaku.click();
  await expect(danmaku).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('playback-phase')).toHaveAttribute(
    'data-state',
    'paused',
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
    'ready',
  );
  const invitation = await invitationLink(page);
  const guest = await appContext(browser);
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
      }),
    ).toBeVisible();
    await expect(
      other.getByRole('complementary', { name: 'Playback helper' }),
    ).toHaveCount(0);
    await expect(
      other.getByRole('button', { name: 'Join', exact: true }),
    ).toHaveCount(0);
    const afterInstall = await (await other.request.get('/api/v2/me')).json();
    expect(afterInstall.identity.identityId).toBe(
      beforeInstall.identity.identityId,
    );
    const restored = await (
      await other.request.get(`/api/v2/rooms/${room.snapshot.roomId}`)
    ).json();
    expect(restored.members).toHaveLength(2);
    expect(await invitationLink(page)).toBe(invitation);
    await other.locator('#local-video').setInputFiles(file);
    await expect(other.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    await closeRoom(page);
    await expect(
      other.getByRole('status').filter({ hasText: 'The host closed' }),
    ).toBeVisible();
    await expect(other.locator('video')).toHaveCount(0);
    await expect(
      other.getByRole('heading', { name: 'Start a watch party', exact: true }),
    ).toBeFocused();
  } finally {
    await guest.close();
  }
  expect(foreign).toEqual([]);
});
