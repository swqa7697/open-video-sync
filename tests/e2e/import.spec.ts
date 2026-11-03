import { expect, test, type Page } from '../../modules/web/playwright-fixtures';
import { closeRoom, openQuickActions, runQuickAction } from './flows';

test('video imports create rooms and replace media through the existing tab with recoverable receipts', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(90000);
  const script = await (
    await page.request.get('/userscripts/ovs-bilibili.user.js')
  ).text();
  // Exercise the shipped helper and real room protocol with bounded synthetic provider data.
  // Media decoding already belongs to the Bilibili playback journey.
  await context.addInitScript({
    content: `(() => {
    const unsafeWindow = window;
    if (typeof MediaSource !== 'undefined') MediaSource.isTypeSupported = () => true;
    const GM_xmlhttpRequest = details => {
      let cancelled = false;
      const timer = setTimeout(() => {
        if (cancelled) return;
        const url = new URL(details.url);
        let data;
        if (url.pathname.endsWith('/view')) data = {
          title: 'Imported synthetic video',
          pages: [{cid:1,page:1,part:'Opening'},{cid:2,page:2,part:'Finale'}]
        };
        else if (url.pathname.endsWith('/playurl')) data = {
          timelength:10000, dash:{video:[{
            id:80,codecs:'avc1.64001E',mimeType:'video/mp4',
            baseUrl:'https://cdn.bilivideo.com/upgcxcode/synthetic-video.m4s',
            SegmentBase:{Initialization:'0-9',indexRange:'10-29'}
          }],audio:[{
            id:30216,codecs:'mp4a.40.2',mimeType:'audio/mp4',
            baseUrl:'https://cdn.bilivideo.com/upgcxcode/synthetic-audio.m4s',
            SegmentBase:{Initialization:'0-9',indexRange:'10-29'}
          }]}
        };
        else if (url.pathname.endsWith('/nav')) data = {isLogin:false};
        else { details.onload({status:404,finalUrl:details.url,responseText:'{}'}); return; }
        details.onload({status:200,finalUrl:details.url,responseText:JSON.stringify({code:0,data})});
      },0);
      return {abort(){cancelled=true;clearTimeout(timer);details.onabort?.();}};
    };
    ${script}
  })();`,
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let cutResult = false;
  const commands: string[] = [];
  await page.routeWebSocket('**/ws/v2/rooms/*', (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((data) => {
      if (typeof data === 'string') {
        const frame = JSON.parse(data) as { type: string; commandId?: string };
        if (frame.type === 'media.select') commands.push(frame.commandId!);
      }
      server.send(data);
    });
    server.onMessage((data) => {
      const frame =
        typeof data === 'string'
          ? (JSON.parse(data) as { type: string })
          : undefined;
      if (cutResult && frame?.type === 'command.result') {
        cutResult = false;
        // Commit succeeded, but the connection closes before its acknowledgement arrives.
        void socket.close({
          code: 1013,
          reason: 'Synthetic lost acknowledgement',
        });
        void server.close();
      } else socket.send(data);
    });
  });
  const start = async (target: Page, part: number) => {
    await target.goto(`/import#v=1&bvid=BV1hf4y1N75G&part=${part}`);
    await expect(target).toHaveURL(/\/import$/);
    await expect(target.locator('#bilibili-url')).toHaveValue('BV1hf4y1N75G');
    await expect(target.getByRole('dialog')).toHaveCount(0);
    await target
      .getByRole('button', { name: 'Preview and continue', exact: true })
      .click();
    await expect(
      target.getByRole('heading', { name: 'Where would you like to watch?' }),
    ).toBeVisible();
  };
  await page.goto('/import#v=1&bvid=BV1hf4y1N75G&part=1');
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(page.url()).hostname)
  )
    expect(await page.evaluate(() => isSecureContext)).toBe(false);
  await expect(page.locator('#bilibili-url')).toHaveValue('BV1hf4y1N75G');
  await page.reload();
  await expect(page.locator('#bilibili-url')).toHaveValue('BV1hf4y1N75G');
  await openQuickActions(page, '/video');
  await expect(page.getByRole('option')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Preview and continue', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Where would you like to watch?' }),
  ).toBeVisible();
  await page
    .getByLabel('Room name', { exact: false })
    .fill('Import destination');
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(page).toHaveURL(/\/rooms\/[a-f0-9]{32}$/);
  const roomId = new URL(page.url()).pathname.split('/').at(-1)!;
  const readRoom = async (target = page) =>
    (await target.request.get(`/api/v2/rooms/${roomId}`)).json() as Promise<{
      epoch: string;
      revision: number;
      mediaGeneration: number;
      media: { part: number };
      playback: { phase: string; positionMs: number };
    }>;
  const initial = await readRoom();
  expect(initial.media.part).toBe(1);
  const importer = await context.newPage();
  importer.on('pageerror', (error) => errors.push(error.message));
  let importSockets = 0;
  importer.on('websocket', () => importSockets++);
  await start(importer, 2);
  await importer.getByLabel('Your room', { exact: true }).selectOption(roomId);
  await expect(importer.locator('.import-current')).toContainText('Part 1');
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    await importer.setViewportSize({ width: width!, height: height! });
    await expect(importer.locator('body')).toHaveJSProperty(
      'scrollWidth',
      width!,
    );
    await importer.screenshot({
      path: testInfo.outputPath(`import-${width}.png`),
      fullPage: true,
    });
  }
  await runQuickAction(importer, '/theme light');
  await expect(importer.locator('html')).toHaveAttribute('data-mode', 'light');
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    await importer.setViewportSize({ width: width!, height: height! });
    await importer.evaluate(() => window.scrollTo(0, 0));
    await importer.screenshot({
      path: testInfo.outputPath(`import-${width}-light.png`),
      fullPage: true,
    });
  }
  await runQuickAction(importer, '/theme dark');
  expect((await readRoom()).mediaGeneration).toBe(initial.mediaGeneration);
  await importer
    .getByRole('button', { name: 'Replace video', exact: true })
    .click();
  await expect(importer.getByRole('dialog')).toContainText(
    'Import destination',
  );
  await importer.getByRole('dialog').evaluate(async (dialog) => {
    await Promise.all(
      dialog.getAnimations().map((animation) => animation.finished),
    );
  });
  await importer.screenshot({
    path: testInfo.outputPath('confirm-390.png'),
    fullPage: false,
  });
  cutResult = true;
  await importer
    .getByRole('dialog')
    .getByRole('button', { name: 'Replace video', exact: true })
    .click();
  await expect(
    importer.getByRole('button', {
      name: 'Check original request',
      exact: true,
    }),
  ).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => (await readRoom()).media.part).toBe(2);
  await expect(page.locator('.player-panel')).not.toContainText(
    'open in another tab',
  );
  await importer
    .getByRole('button', { name: 'Check original request', exact: true })
    .click();
  await expect(importer.locator('.import-panel')).toContainText(
    'Video replaced. The room continues in its existing tab.',
  );
  expect(importSockets).toBe(0);
  expect(commands).toHaveLength(2);
  expect(commands[0]).toBe(commands[1]);
  const replaced = await readRoom();
  expect(replaced.mediaGeneration).toBe(initial.mediaGeneration + 1);
  expect(replaced.playback).toMatchObject({ phase: 'paused', positionMs: 0 });
  await importer.reload();
  await expect(importer.locator('.import-panel')).toContainText(
    'This import link is invalid',
  );

  // Explicit fallback remains available when the host no longer has a responding room page.
  await page.close();
  await importer.goto('/');
  await start(importer, 1);
  await importer.getByLabel('Your room', { exact: true }).selectOption(roomId);
  await expect(importer.locator('.import-current')).toContainText('Part 2');
  await importer
    .getByRole('button', { name: 'Replace video', exact: true })
    .click();
  await importer
    .getByRole('dialog')
    .getByRole('button', { name: 'Replace video', exact: true })
    .click();
  await importer
    .getByRole('button', {
      name: 'Open room here and replace video',
      exact: true,
    })
    .click();
  await expect(importer).toHaveURL(new RegExp(`/rooms/${roomId}$`));
  await expect.poll(async () => (await readRoom(importer)).media.part).toBe(1);
  expect((await readRoom(importer)).mediaGeneration).toBe(
    replaced.mediaGeneration + 1,
  );
  expect(errors).toEqual([]);
  await closeRoom(importer);
});
