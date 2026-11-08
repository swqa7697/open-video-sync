import release from '../../modules/helper/dist/release.json';
import {
  appContext,
  expect,
  test,
} from '../../modules/web/playwright-fixtures';
import {
  clickPlayerControl,
  closeRoom,
  expectFittedPlayer,
  invitationLink,
  observePageKeyboard,
  openAppPanel,
  openPlayerMenu,
  openQuickActions,
  runQuickAction,
  seekTo,
  setPlaybackSpeed,
  settings,
} from './flows';
import { decodedFrame, generatedDASHMedia, generatedVideo } from './media';

// Invented metadata keeps long Chinese titles covered without naming public videos.
const syntheticVideos = [
  {
    bvid: 'BV1TESTaaaad',
    title:
      '合成测试视频：第一段展示彩色方块与编号，第二段切换背景并显示字幕，第三段检查拖动进度条后的画面恢复；这个虚构的长标题用于验证不同窗口尺寸下的播放器布局、文字省略和菜单位置。',
  },
  {
    bvid: 'BV1TESTaaaae',
    title: '合成测试视频：另一组彩色方块与字幕，用于验证切换视频后的播放器布局',
  },
] as const;

test('playing Bilibili seeks recover decoded video through the real adapter and helper', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120000);
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
  const helperBootstrap = {
    content: `(() => {
    sessionStorage.setItem('hold-thumbnails', '1');
    sessionStorage.setItem('thumbnail-requests', '0');
    sessionStorage.setItem('thumbnail-completed', '0');
    sessionStorage.setItem('danmaku-requests', '0');
    const tracks = ${JSON.stringify(tracks)};
    const sheets = ${JSON.stringify(sheets)};
    const syntheticTitles = ${JSON.stringify(Object.fromEntries(syntheticVideos.map(({ bvid, title }) => [bvid, title])))};
    for (const track of tracks) track.data = Uint8Array.from(atob(track.bytes), c => c.charCodeAt(0));
    const unsafeWindow = window;
    const addBuffer = MediaSource.prototype.addSourceBuffer;
    let activeSource;
    MediaSource.isTypeSupported = () => true;
    MediaSource.prototype.addSourceBuffer = function(mime) {
      activeSource = this;
      return addBuffer.call(this, mime.startsWith('video/')
        ? 'video/webm; codecs="vp8"' : 'audio/webm; codecs="opus"');
    };
    document.addEventListener('evict-future-media', event => {
      const source = activeSource;
      Promise.all(Array.from(source.sourceBuffers).map(async buffer => {
        if (buffer.updating)
          await new Promise(resolve => buffer.addEventListener('updateend', resolve, { once: true }));
        const end = buffer.buffered.length ? buffer.buffered.end(buffer.buffered.length - 1) : 0;
        if (end <= 10) return;
        await new Promise((resolve, reject) => {
          const cleanup = () => {
            buffer.removeEventListener('updateend', done);
            buffer.removeEventListener('error', failed);
          };
          const done = () => { cleanup(); resolve(); };
          const failed = () => { cleanup(); reject(Error('Synthetic buffer eviction failed.')); };
          buffer.addEventListener('updateend', done, { once: true });
          buffer.addEventListener('error', failed, { once: true });
          try { buffer.remove(10, end); } catch (error) { cleanup(); reject(error); }
        });
      })).then(event.detail.resolve, event.detail.reject);
    });
    const held = new Set();
    const heldThumbnails = new Set();
    const heldEpisodes = new Set();
    let owner, trafficID = 100000;
    window.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      try {
        const request = JSON.parse(event.data);
        if (request.channel === 'ovs-bilibili-request' && request.op === 'open') owner = request.client;
      } catch {}
    });
    document.addEventListener('begin-thumbnail-competition', () => {
      if (!owner) throw Error('Synthetic helper owner unavailable.');
      for (let request = 0; request < 4; request++) {
        window.postMessage(JSON.stringify({
          channel: 'ovs-bilibili-request', client: owner, id: ++trafficID, op: 'session'
        }), location.origin);
      }
    });
    document.addEventListener('resume-thumbnails', () => {
      sessionStorage.removeItem('hold-thumbnails');
      for (const resume of [...heldThumbnails]) resume();
    });
    document.addEventListener('resume-seek-downloads', () => {
      for (const resume of [...held]) resume();
    });
    document.addEventListener('resume-episodes', () => {
      sessionStorage.removeItem('hold-episodes');
      for (const resume of [...heldEpisodes]) resume();
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
        heldEpisodes.delete(respond);
        if (cancelled) return;
        if (url.pathname === '/pgc/view/web/season' && sessionStorage.getItem('fail-episode')) {
          details.onload({ status: 403, finalUrl: details.url, responseText: '{}' });
          return;
        }
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
        if (url.pathname === '/pgc/view/web/season') data = {
          season_id: 9000000000021, title: 'Synthetic bangumi', episodes: [
            { id: 9000000000011, bvid: 'BV1TESTaaaaa', cid: 1, title: '1', long_title: 'Opening' },
            { id: 9000000000012, bvid: 'BV1TESTaaaab', cid: 2, title: '2', long_title: 'Finale' }
          ]
        };
        else if (url.pathname.endsWith('/view')) data = {
          title: syntheticTitles[url.searchParams.get('bvid')] ?? 'Streamed Bilibili seeks', pages: [{ cid: 1, page: 1 }],
          ugc_season: { title: 'Large collection', sections: [{
            episodes: Array(929).fill({
              bvid: 'BV1TESTaaaab', title: 'Episode', page: { page: 1 },
              arc: { desc: 'x'.repeat(5000) }
            })
          }] }
        };
        else if (url.pathname.endsWith('/pagelist')) data = [
          { cid: 1, page: 1, part: syntheticTitles[url.searchParams.get('bvid')] ?? 'Streamed Bilibili seeks' }
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
            bandwidth: i === 0 ? 2183000 : 177000,
            ...(i === 0 ? { frameRate: '30000/1001' } : {}),
            baseUrl: 'https://cdn.bilivideo.com/upgcxcode/synthetic.m4s?track=' + i,
            SegmentBase: { Initialization: track.init.join('-'), indexRange: track.index.join('-') }
          }));
          data = { timelength: 30000, dash: { video: [media[0]], audio: [media[1]] } };
        } else if (url.pathname.endsWith('/seg.so')) {
          sessionStorage.setItem('danmaku-requests', String(Number(sessionStorage.getItem('danmaku-requests')) + 1));
          details.onload({ status: 200, finalUrl: details.url, response: new ArrayBuffer(0) });
          return;
        } else data = { isLogin: false };
        details.onload({ status: 200, finalUrl: details.url, responseText: JSON.stringify({ code: 0,
          [url.pathname.startsWith('/pgc/') ? 'result' : 'data']: data }) });
      };
      queueMicrotask(() => {
        if (cancelled) return;
        if (thumbnail && sessionStorage.getItem('hold-thumbnails')) {
          heldThumbnails.add(respond);
          sessionStorage.setItem('thumbnail-held', '1');
        }
        else if (url.pathname === '/pgc/view/web/season' && sessionStorage.getItem('hold-episodes')) heldEpisodes.add(respond);
        else if (details.headers.Range && sessionStorage.getItem('hold-seek')) held.add(respond);
        else respond();
      });
      return { abort() { cancelled = true; held.delete(respond); heldThumbnails.delete(respond); heldEpisodes.delete(respond); details.onabort(); } };
    };
    ${script}
  })();`,
  };
  await page.addInitScript(helperBootstrap);
  await page.goto('/');
  await page
    .getByLabel('Video URL or identifier')
    .fill(syntheticVideos[0].bvid);
  await page
    .getByRole('button', { name: 'Preview video', exact: true })
    .click();
  await expect(page.locator('.media-preview')).toContainText(
    syntheticVideos[0].title,
  );
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'ready',
  );
  const notifications = page.getByRole('button', {
    name: 'Dismiss notification',
    exact: true,
  });
  while (await notifications.count()) await notifications.first().click();
  await expect(page.getByRole('tab', { name: /Episodes/ })).toHaveCount(0);
  await expect(page.locator('.episode-trigger')).toHaveCount(0);
  const stage = page.locator('.video-stage');
  const playerMenu = page.getByRole('menu', { name: 'Player menu' });
  const statistics = page.getByRole('region', {
    name: 'Video statistics',
    exact: true,
  });
  for (const viewport of [
    { width: 1966, height: 654 },
    { width: 864, height: 1365 },
  ]) {
    await page.setViewportSize(viewport);
    await expectFittedPlayer(page);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Change video', exact: true }).click();
  const replacement = page.getByRole('dialog', {
    name: 'Change the video',
    exact: true,
  });
  await replacement
    .getByLabel('Video URL or identifier')
    .fill(syntheticVideos[1].bvid);
  await replacement
    .getByRole('button', { name: 'Preview video', exact: true })
    .click();
  await expect(replacement.locator('.media-preview')).toContainText(
    syntheticVideos[1].title,
  );
  await replacement
    .getByRole('button', { name: 'Use this video', exact: true })
    .click();
  await expect(replacement).toHaveCount(0);
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'ready',
  );
  await expect(page.locator('.video-description h3')).toContainText(
    syntheticVideos[1].title,
  );
  // Live accent changes reach the player without replacing or interrupting media.
  const accents = [];
  for (const name of ['Soft iris', 'Quiet teal', 'Dusty rose']) {
    await openAppPanel(page, 'Appearance');
    await page.getByRole('radio', { name, exact: true }).check();
    await page.keyboard.press('Escape');
    await page.locator('.danmaku-settings-trigger').press('ArrowDown');
    await expect(page.locator('.danmaku-menu')).toBeVisible();
    const colors = await page.evaluate(() => {
      const button = document.querySelector('.playback-toggle')!;
      const style = getComputedStyle(button);
      return {
        playback: style.color,
        icon: getComputedStyle(button.querySelector('path')!).fill,
        surface: style.backgroundColor,
        border: style.borderColor,
        volume: getComputedStyle(document.querySelector('.volume-slider')!)
          .color,
        danmaku: Array.from(
          document.querySelectorAll('.danmaku-menu input[type="range"]'),
          (input) => getComputedStyle(input).accentColor,
        ),
      };
    });
    expect(colors.icon).toBe(colors.playback);
    expect(colors.volume).toBe(colors.playback);
    expect(colors.danmaku).toHaveLength(3);
    for (const color of colors.danmaku) expect(color).toBe(colors.playback);
    accents.push(colors);
    await expect(page.locator('video')).toHaveJSProperty('paused', true);
    await expect(page.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    await page.keyboard.press('Escape');
  }
  for (const field of ['playback', 'surface', 'border', 'volume'] as const)
    expect(new Set(accents.map((colors) => colors[field])).size).toBe(3);
  await openAppPanel(page, 'Appearance');
  await page.getByRole('radio', { name: 'Slate blue', exact: true }).check();
  await page.keyboard.press('Escape');
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1966, height: 654 },
    { width: 864, height: 1365 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expectFittedPlayer(page);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    );
    // The right controls share one row; every popover clears that row at the same height.
    const controls = await page
      .locator('.control-end button[aria-haspopup], .display-controls button')
      .all();
    const heights: number[] = [];
    const centers = await Promise.all(
      controls.map(async (control) => {
        const box = (await control.boundingBox())!;
        heights.push(box.height);
        return box.y + box.height / 2;
      }),
    );
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(1);
    const bottoms: number[] = [];
    for (const [trigger, popup] of [
      ['.danmaku-settings-trigger', '.danmaku-menu'],
      ['.playback-rate', '.rate-menu'],
      ['.quality-trigger', '.quality-menu'],
    ]) {
      await page.locator(trigger!).press('ArrowDown');
      const menu = page.locator(popup!);
      await expect(menu).toBeVisible();
      const box = (await menu.boundingBox())!;
      const surface = (await stage.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(surface.x);
      expect(box.x + box.width).toBeLessThanOrEqual(surface.x + surface.width);
      expect(box.y).toBeGreaterThanOrEqual(surface.y);
      bottoms.push(box.y + box.height);
      if (popup === '.rate-menu') {
        await page.keyboard.press('End');
        await expect(
          menu.getByRole('menuitemradio', { name: '2×', exact: true }),
        ).toBeFocused();
        await page.keyboard.press('Home');
        await expect(
          menu.getByRole('menuitemradio', { name: '0.5×', exact: true }),
        ).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(
          menu.getByRole('menuitemradio', { name: '0.75×', exact: true }),
        ).toBeFocused();
      }
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(page.locator(trigger!)).toBeFocused();
      await expect(page.locator('video')).toHaveJSProperty('paused', true);
    }
    expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThan(1);
    await openPlayerMenu(page);
    const original = playerMenu.getByRole('menuitem', {
      name: 'Open on Bilibili',
      exact: true,
    });
    await expect(original).toHaveAttribute(
      'href',
      `https://www.bilibili.com/video/${syntheticVideos[1].bvid}?p=1`,
    );
    await expect(original).toHaveAttribute('target', '_blank');
    const menuBox = (await playerMenu.boundingBox())!;
    const stageBox = (await stage.boundingBox())!;
    expect(menuBox.x).toBeGreaterThanOrEqual(stageBox.x);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(
      stageBox.x + stageBox.width + 1,
    );
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(
      stageBox.y + stageBox.height + 1,
    );
    expect(menuBox.x).toBeGreaterThanOrEqual(0);
    expect(menuBox.y).toBeGreaterThanOrEqual(0);
    expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(viewport.width);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(viewport.height);
    await playerMenu
      .getByRole('menuitem', { name: 'Video statistics', exact: true })
      .click();
    await expect(statistics).toBeVisible();
    await expect(statistics).toContainText(/640\s*[×x]\s*360/);
    await expect(statistics).toContainText('Video bitrate');
    await expect(statistics).toContainText('Audio bitrate');
    await expect(statistics).toContainText('Video segments');
    await expect(statistics).toContainText('Audio segments');
    await expect(statistics).toContainText('Network activity');
    await expect(statistics.locator('.network-graph')).toBeVisible();
    await expect(statistics).not.toContainText('Video Host');
    expect(
      await statistics.evaluate(
        (panel) => panel.scrollWidth - panel.clientWidth,
      ),
    ).toBe(0);
    if (viewport.width === 1440) {
      const pendingDownload = page.waitForEvent('download');
      await statistics
        .getByRole('button', { name: 'Download statistics', exact: true })
        .click();
      const download = await pendingDownload;
      const stream = await download.createReadStream();
      if (!stream) throw new Error('The statistics download must have a body.');
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      const snapshot = Buffer.concat(chunks).toString('utf8');
      expect(() => JSON.parse(snapshot)).not.toThrow();
      expect(snapshot).toContain('2183000');
      expect(snapshot).not.toContain('bilivideo.com');
      expect(snapshot).not.toContain('blob:');
      expect(snapshot).not.toContain('handle');
    }
    await page.keyboard.press('Escape');
    await expect(statistics).toHaveCount(0);
    await expect(page.locator('video')).toHaveJSProperty('paused', true);
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await stage.hover({ position: { x: 16, y: 8 } });
  const playbackSpeed = page.getByRole('button', {
    name: 'Playback speed',
    exact: true,
  });
  await setPlaybackSpeed(page, 1.5);
  await expect(page.locator('video')).toHaveJSProperty('playbackRate', 1.5);
  await expect(page.locator('video')).toHaveJSProperty('paused', true);
  await openPlayerMenu(page);
  const danmakuRequests = await page.evaluate(() =>
    Number(sessionStorage.getItem('danmaku-requests')),
  );
  await playerMenu
    .getByRole('menuitem', { name: 'Reload danmaku', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => Number(sessionStorage.getItem('danmaku-requests'))),
    )
    .toBeGreaterThan(danmakuRequests);
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
  await expect(playbackSpeed).toHaveText('1.5×');
  await expect
    .poll(() =>
      page
        .locator('video')
        .evaluate((video: HTMLVideoElement) =>
          Math.abs(video.playbackRate - 1.5),
        ),
    )
    .toBeLessThanOrEqual(0.076);
  await page.evaluate(() => sessionStorage.setItem('hold-seek', '1'));
  // A larger forward reserve can contain this entire synthetic clip. Ensure
  // the held seek needs real media delivery by evicting its target first.
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        document.dispatchEvent(
          new CustomEvent('evict-future-media', {
            detail: { resolve, reject },
          }),
        );
      }),
  );
  await expect
    .poll(() =>
      page.locator('video').evaluate((video: HTMLVideoElement) => {
        for (let i = 0; i < video.buffered.length; i++)
          if (video.buffered.start(i) <= 20 && video.buffered.end(i) > 20)
            return true;
        return false;
      }),
    )
    .toBe(false);
  await seekTo(page, 20);
  const roomPath = `/api/v2${new URL(page.url()).pathname}`;
  await expect
    .poll(
      async () =>
        (await (await page.request.get(roomPath)).json()).playback.phase,
    )
    .toBe('paused');
  await expect(page.locator('video')).toHaveJSProperty('paused', true);
  await expect(
    page.getByRole('img', { name: 'Buffering…', exact: true }),
  ).toBeVisible();
  const spinner = page.locator('.playback-spinner');
  const initialTransform = await spinner.evaluate(
    (element) => getComputedStyle(element).transform,
  );
  await expect
    .poll(() =>
      spinner.evaluate((element) => getComputedStyle(element).transform),
    )
    .not.toBe(initialTransform);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(spinner).toHaveCSS('animation-name', 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(spinner).toHaveCSS('animation-name', 'playback-spin');
  await page.evaluate(() => {
    sessionStorage.removeItem('hold-seek');
    document.dispatchEvent(new Event('resume-seek-downloads'));
  });
  for (const target of [20, 7.9, 23.9, 2.9]) {
    if (target !== 20) await seekTo(page, target);
    await expect
      .poll(async () => {
        const frame = await decodedFrame(page);
        return Math.abs(frame - target * 30) <= 2;
      })
      .toBe(true);
    await expect(page.locator('video')).toHaveJSProperty('paused', true);
    await clickPlayerControl(page, 'Play together');
    await expect
      .poll(() => decodedFrame(page))
      .toBeGreaterThan(target * 30 + 5);
    await expect(page.locator('video')).toHaveJSProperty('paused', false);
  }
  await clickPlayerControl(page, 'Pause together');
  await expect(page.locator('video')).toHaveJSProperty('paused', true);
  await expect(
    page.getByRole('img', { name: 'Paused', exact: true }),
  ).toBeVisible();
  await seekTo(page, 10);
  await expect.poll(() => decodedFrame(page)).toBeGreaterThanOrEqual(300);
  // Reuse the actual decoder and helper to cover SS resolution, EP persistence,
  // reloading the selected episode, and host episode changes.
  await page.getByRole('button', { name: 'Change video', exact: true }).click();
  await page
    .getByLabel('Video URL or identifier')
    .fill('https://www.bilibili.com/bangumi/play/ss9000000000021');
  await page
    .getByRole('button', { name: 'Preview video', exact: true })
    .click();
  await expect(page.locator('.media-preview')).toContainText(
    'Synthetic bangumi · 1 · Opening',
  );
  await page
    .getByRole('button', { name: 'Use this video', exact: true })
    .click();
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'ready',
  );
  await expect
    .poll(
      async () =>
        (await (await page.request.get(roomPath)).json()).media.episodeId,
    )
    .toBe('9000000000011');
  await expect(playbackSpeed).toHaveText('1×');
  await expect(page.locator('video')).toHaveJSProperty('playbackRate', 1);
  await page.reload();
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'ready',
  );
  const episodeTrigger = page.locator('.episode-trigger');
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expectFittedPlayer(page);
    await clickPlayerControl(page, 'Episodes');
    const menu = page.getByRole('menu', { name: 'Episodes', exact: true });
    await expect(menu.getByRole('menuitemradio')).toHaveCount(2);
    await expect(
      menu.getByRole('menuitemradio', { checked: true }),
    ).toContainText('Opening');
    const bounds = (await menu.boundingBox())!;
    const surface = (await page.locator('.video-stage').boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(surface.x);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      surface.x + surface.width,
    );
    expect(bounds.y).toBeGreaterThanOrEqual(surface.y);
    await page.keyboard.press('End');
    await expect(menu.getByRole('menuitemradio').last()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(episodeTrigger).toBeFocused();
    await expect(page.locator('video')).toHaveJSProperty('paused', true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('tab', { name: /Episodes/ }).click();
  await openQuickActions(page, '换集');
  const palette = page.locator('.command-palette'),
    input = palette.getByRole('combobox');
  await input.press('Enter');
  await expect(input).toHaveValue('@');
  await expect(input).toBeFocused();
  await expect(palette.getByRole('option')).toHaveCount(2);
  await expect(palette.locator('[aria-current="true"]')).toContainText(
    'Opening',
  );
  await input.press('Enter');
  await expect(palette).toBeVisible();
  await input.fill('@3');
  await expect(palette.getByRole('status')).toContainText('No item 3');
  await input.fill('@fINaLE');
  await expect(palette.getByRole('option')).toHaveCount(1);
  await expect(palette.locator('.command-episode-number')).toHaveText('2');
  await input.evaluate((node) =>
    node.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
      }),
    ),
  );
  await expect(palette).toBeVisible();
  expect(
    (await (await page.request.get(roomPath)).json()).media.episodeId,
  ).toBe('9000000000011');
  await input.fill('@');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await palette.evaluate((node) => node.getAnimations().length)).toBe(0);
  const paletteBounds = (await palette.boundingBox())!;
  expect(paletteBounds.x + paletteBounds.width).toBeLessThanOrEqual(390);
  expect(paletteBounds.y + paletteBounds.height).toBeLessThanOrEqual(844);
  await input.fill('@02');
  await page.evaluate(() => sessionStorage.setItem('fail-episode', '1'));
  await input.press('Enter');
  await expect(palette.getByRole('alert')).toBeVisible();
  await expect(input).toHaveValue('@02');
  expect(
    (await (await page.request.get(roomPath)).json()).media.episodeId,
  ).toBe('9000000000011');
  await page.evaluate(() => {
    sessionStorage.removeItem('fail-episode');
    sessionStorage.setItem('hold-episodes', '1');
  });
  await input.press('Enter');
  await expect(palette.locator('[aria-busy="true"]')).toContainText(
    'Switching',
  );
  await expect(palette.getByRole('option')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await input.press('Enter');
  await page.evaluate(() =>
    document.dispatchEvent(new Event('resume-episodes')),
  );
  await expect(palette).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await (await page.request.get(roomPath)).json()).media.episodeId,
    )
    .toBe('9000000000012');
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'ready',
  );
  await expect(page.locator('video')).toHaveJSProperty('paused', false);
  await expect.poll(() => decodedFrame(page)).toBeGreaterThan(5);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('.command-trigger').focus();
  await openQuickActions(page, '@1');
  await palette.getByRole('option').click();
  await expect(palette).toHaveCount(0);
  await expect(page.locator('.command-trigger')).toBeFocused();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(roomPath)).json()).media.episodeId,
    )
    .toBe('9000000000011');
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'ready',
  );
  await page.getByRole('tab', { name: /Episodes/ }).click();
  await settings(page, false, false);
  await clickPlayerControl(page, 'Play together');
  await expect(page.locator('video')).toHaveJSProperty('paused', false);
  await clickPlayerControl(page, 'Episodes');
  await page.getByRole('menuitemradio', { name: /Finale/ }).click();
  await expect
    .poll(
      async () =>
        (await (await page.request.get(roomPath)).json()).media.episodeId,
    )
    .toBe('9000000000012');
  await expect(page.locator('video')).toHaveJSProperty('paused', false);
  await expect.poll(() => decodedFrame(page)).toBeGreaterThan(5);
  await clickPlayerControl(page, 'Pause together');
  await page
    .getByRole('button', { name: 'Room settings', exact: true })
    .click();
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole('dialog').getByRole('checkbox')).toHaveCount(3);
    await expect(
      page.getByLabel('Allow everyone to change videos and episodes', {
        exact: true,
      }),
    ).not.toBeChecked();
    await page.getByRole('dialog').evaluate(async (dialog) => {
      await Promise.all(
        dialog.getAnimations().map((animation) => animation.finished),
      );
    });
    await page.screenshot({
      path: testInfo.outputPath(
        `media-permission-settings-${viewport.width}.png`,
      ),
      animations: 'disabled',
    });
  }
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 900 });
  // A separate identity receives video selection permission independently of playback.
  const guest = await appContext(browser);
  try {
    await guest.addInitScript(helperBootstrap);
    const other = await guest.newPage();
    await other.goto(await invitationLink(page));
    await expect(other.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    await other.setViewportSize({ width: 1440, height: 900 });
    await other.getByRole('tab', { name: /Episodes/ }).click();
    await expect(other.locator('.episode-button')).toHaveCount(2);
    await expect(other.locator('.episode-button').first()).toBeDisabled();
    await expect(other.locator('.episode-trigger')).toHaveCount(0);
    await expect(other.locator('.change-media')).toHaveCount(0);
    await other.screenshot({
      path: testInfo.outputPath('media-permission-denied-desktop.png'),
      animations: 'disabled',
    });
    await settings(page, false, false, true);
    await expect(other.locator('.episode-trigger')).toHaveCount(1);
    await expect(other.locator('.episode-button').first()).toBeEnabled();
    await expect(
      other.getByRole('button', { name: 'Play together', exact: true }),
    ).toBeDisabled();
    await clickPlayerControl(other, 'Episodes');
    await other.screenshot({
      path: testInfo.outputPath('media-permission-granted-desktop.png'),
      animations: 'disabled',
    });
    await other.getByRole('menuitemradio', { name: /Opening/ }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(roomPath)).json()).media.episodeId,
      )
      .toBe('9000000000011');
    await expect(page.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    await expect(other.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    await other
      .getByRole('button', { name: 'Change video', exact: true })
      .click();
    await other.getByLabel('Video URL or identifier').fill('ep9000000000012');
    await other
      .getByRole('button', { name: 'Preview video', exact: true })
      .click();
    await other
      .getByRole('button', { name: 'Use this video', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(roomPath)).json()).media.episodeId,
      )
      .toBe('9000000000012');
    await expect(other.getByTestId('playback-phase')).toHaveAttribute(
      'data-state',
      'paused',
    );
    await expect(other.getByTestId('media-status')).toHaveAttribute(
      'data-state',
      'ready',
    );
    await clickPlayerControl(other, 'Episodes');
    await settings(page, false, false, false);
    await expect(other.locator('.episode-trigger')).toHaveCount(0);
    await expect(other.locator('.episode-menu')).toHaveCount(0);
    await expect(other.locator('.video-stage')).toBeFocused();
    await expect(other.locator('.episode-button').first()).toBeDisabled();
    await other.setViewportSize({ width: 390, height: 844 });
    await other.getByRole('button', { name: /Members and episodes/ }).click();
    await other.getByRole('tab', { name: /Episodes/ }).click();
    await expect(other.locator('.episode-button').first()).toBeDisabled();
    await other.screenshot({
      path: testInfo.outputPath('media-permission-denied-mobile.png'),
      animations: 'disabled',
    });
  } finally {
    await guest.close();
  }
  await closeRoom(page);
});

test('previewing another Bilibili link preserves the active helper and room until confirmation', async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
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
          title: sessionStorage.getItem('preview-title') || 'Replacement preview',
          pages: sessionStorage.getItem('preview-multipart')
            ? [{ page: 1, cid: 2 }, { page: 2, cid: 3 }]
            : [{ page: 1, cid: 2 }]
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
      } else if (!media && new URL(details.url).pathname.endsWith('/view') && sessionStorage.getItem('hold-preview')) {
        document.addEventListener('release-preview', respond, { once: true });
      } else queueMicrotask(respond);
      return { abort() {
        cancelled = true;
        document.removeEventListener('release-media-read', respond);
        document.removeEventListener('release-preview', respond);
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
    bvid: 'BV1TESTaaaaa',
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
    .getByLabel('Video URL or identifier')
    .fill('https://www.bilibili.com/video/BV1TESTaaaab');
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
  // Reuse the active-room isolation journey for the distinct layout contract.
  // Each viewport exercises one bounded title and response rather than a full cross-product.
  const longTitle = 'A long synthetic preview title 中文 '.repeat(4).trim();
  for (const [width, height, locale, multipart] of [
    [1440, 900, 'en', false],
    [1024, 768, 'en', true],
    [390, 844, 'en', true],
    [320, 844, 'zh-CN', true],
  ] as const) {
    await page.setViewportSize({ width, height });
    if (locale === 'zh-CN') await runQuickAction(page, '/language zh-CN');
    await page.evaluate(
      ({ title, multipart }) => {
        sessionStorage.setItem('preview-title', title);
        sessionStorage.setItem('hold-preview', '1');
        if (multipart) sessionStorage.setItem('preview-multipart', '1');
        else sessionStorage.removeItem('preview-multipart');
      },
      { title: longTitle, multipart },
    );
    await page.locator('.change-media').click();
    const dialog = page.getByRole('dialog');
    await dialog.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    await dialog.locator('#bilibili-url').fill('BV1TESTaaaab');
    const geometry = () =>
      dialog
        .locator(
          '.modal-heading, .media-picker .input-action button, form > button',
        )
        .evaluateAll((nodes) =>
          nodes.flatMap((node) => {
            const { x, y, width, height } = node.getBoundingClientRect();
            return [x, y, width, height];
          }),
        );
    const idle = await geometry();
    expect(idle).toHaveLength(12);
    const expectStable = async () => {
      await expect
        .poll(async () =>
          Math.max(
            ...(await geometry()).map((value, index) =>
              Math.abs(value - idle[index]!),
            ),
          ),
        )
        .toBeLessThanOrEqual(1);
    };
    const preview = dialog.locator('.media-picker .input-action button');
    await preview.click();
    await expect(preview).toBeDisabled();
    await expect(dialog.locator('.media-picker [role="status"]')).toContainText(
      /Preparing your video|正在准备视频/,
    );
    await expectStable();
    await page.evaluate(() => {
      sessionStorage.removeItem('hold-preview');
      document.dispatchEvent(new Event('release-preview'));
    });
    await expect(dialog.locator('.media-preview .feedback-text')).toHaveText(
      longTitle,
    );
    await expectStable();
    if (multipart) await expect(dialog.locator('.part-row')).toBeVisible();
    else await expect(dialog.locator('.part-row')).toBeHidden();
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    if (width === 390) {
      const details = dialog.locator('.media-preview .feedback-toggle');
      await expect(details).toBeVisible();
      await details.focus();
      await page.keyboard.press('Enter');
      await expect(details).toHaveAttribute('aria-expanded', 'true');
      const popover = dialog.locator('.feedback-details');
      await expect(popover.locator('> p')).toHaveText(longTitle);
      await expect(popover.getByRole('button')).toBeFocused();
      await expectStable();
      await expectOriginalMedia();
      await page.keyboard.press('Space');
      await expect(details).toHaveAttribute('aria-expanded', 'false');
      await expect(details).toBeFocused();
      await expectStable();
      await page.keyboard.press('Enter');
      await expect(details).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Escape');
      await expect(details).toHaveAttribute('aria-expanded', 'false');
      await expect(dialog).toBeVisible();
      await expect(details).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(details).toHaveAttribute('aria-expanded', 'true');
      await dialog.locator('#bilibili-url').fill('invalid');
      await expect(dialog.locator('.feedback-details')).toBeHidden();
      await preview.click();
      await expect(
        dialog.locator('.media-picker [role="alert"]'),
      ).toBeVisible();
      await expectStable();
      await dialog.locator('#bilibili-url').fill('BV1TESTaaaab');
      await preview.click();
      await expect(dialog.locator('.media-preview .feedback-text')).toHaveText(
        longTitle,
      );
      await expectStable();
      await expectOriginalMedia();
    }
    expect(
      await page.evaluate(() => {
        const root = document.documentElement;
        return (
          root.scrollHeight <= root.clientHeight + 1 &&
          root.scrollWidth <= root.clientWidth + 1
        );
      }),
    ).toBe(true);
    await dialog.locator('.modal-heading button').click();
    if (locale === 'zh-CN') await runQuickAction(page, '/language en');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    sessionStorage.removeItem('preview-title');
    sessionStorage.removeItem('preview-multipart');
  });
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
    await page.getByLabel('Video URL or identifier').fill('BV1TESTaaaab');
    const failureDialog = page.getByRole('dialog');
    await failureDialog.evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished),
      );
    });
    const beforeFailure = await failureDialog.boundingBox();
    await page
      .getByRole('button', { name: 'Preview video', exact: true })
      .click();
    await expect(page.locator('.media-picker [role="alert"]')).toContainText(
      text,
    );
    await expect
      .poll(async () => {
        const afterFailure = (await failureDialog.boundingBox())!;
        return Math.max(
          ...(['x', 'y', 'width', 'height'] as const).map((key) =>
            Math.abs(afterFailure[key] - beforeFailure![key]),
          ),
        );
      })
      .toBeLessThanOrEqual(1);
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
  await page.getByLabel('Video URL or identifier').fill('BV1TESTaaaaa');
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
  await page.getByLabel('Video URL or identifier').fill('BV1TESTaaaaa');
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
      settings: {
        everyoneCanControl: false,
        everyoneCanSelectMedia: false,
        waitForAll: true,
      },
      media: {
        kind: 'bilibili',
        bvid: 'BV1TESTaaaaa',
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
  const danmakuSettings = page.locator('.danmaku-settings-trigger');
  const preferences = page.getByRole('dialog', {
    name: 'Danmaku settings',
    exact: true,
  });
  await danmaku.hover();
  await expect(preferences).toHaveCount(0);
  await danmakuSettings.hover();
  await expect(preferences).toHaveCount(0);
  await danmakuSettings.click();
  await expect(preferences).toBeVisible();
  await expect(preferences.getByRole('status')).toHaveCount(0);
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
  await expect(preferences).toBeVisible();
  await danmakuSettings.click();
  await expect(preferences).toHaveCount(0);
  await danmakuSettings.press('ArrowDown');
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
  // The open settings panel owns shortcuts even if focus is moved underneath.
  const playerSurface = page.locator('.video-stage');
  await playerSurface.focus();
  await expect(playerSurface).toBeFocused();
  const volume = await page.locator('#local-volume').inputValue();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('m');
  await page.keyboard.press('f');
  await expect(page.locator('#local-volume')).toHaveValue(volume);
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await page.keyboard.press('Escape');
  await expect(danmakuSettings).toBeFocused();
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
  await danmakuSettings.press('ArrowDown');
  await expect(preferences).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preferences).toHaveCount(0);
  await expect(danmakuSettings).toBeFocused();
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await openPlayerMenu(page, 'keyboard');
  await page
    .getByRole('menuitem', { name: 'Video statistics', exact: true })
    .click();
  const fullscreenStatistics = page.getByRole('region', {
    name: 'Video statistics',
    exact: true,
  });
  await expect(fullscreenStatistics).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(fullscreenStatistics).toHaveCount(0);
  expect(await page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await page.keyboard.press('Escape');
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(false);
  await clickPlayerControl(page, 'Fullscreen locally');
  await expect
    .poll(() => page.evaluate(() => !!document.fullscreenElement))
    .toBe(true);
  await openPlayerMenu(page, 'keyboard');
  await page
    .getByRole('menuitem', { name: 'Video statistics', exact: true })
    .click();
  await expect(fullscreenStatistics).toBeVisible();
  // Browser-owned fullscreen exits must also dismiss the floating panel.
  await page.evaluate(() => document.exitFullscreen());
  await expect(fullscreenStatistics).toHaveCount(0);
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
    await danmakuSettings.press('ArrowDown');
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
    await expect(
      preferences.getByRole('button', { name: 'Reload danmaku', exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(danmakuSettings).toBeFocused();
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
