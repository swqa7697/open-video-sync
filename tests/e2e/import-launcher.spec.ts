import { expect, test } from '../../modules/web/playwright-fixtures';

test('instance helpers share a Bilibili launcher and import the current video', async ({
  page,
  context,
  baseURL,
}) => {
  test.setTimeout(60000);
  if (!baseURL) throw new Error('Browser base URL required.');
  const origin = new URL(baseURL).origin;
  const otherOrigin = 'https://another-ovs.example';
  const response = await page.request.get('/userscripts/ovs-bilibili.user.js');
  expect(response.ok()).toBe(true);
  const script = await response.text();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await context.route('https://www.bilibili.com/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Synthetic Bilibili video</title>
        <style>
          :root { --text1:#18191c; --text2:#61666d; --brand_blue:#00aeec; --bg1:#fff; --line_regular:#e3e5e7; --graph_bg_thin:#f6f7f8; font:14px/1.5 system-ui,sans-serif; color:var(--text1); }
          * { box-sizing:border-box; } body { margin:0; } header { height:64px; padding:18px 28px; border-bottom:1px solid var(--line_regular); color:var(--brand_blue); font-weight:600; }
          main { width:min(980px,calc(100% - 48px)); margin:28px auto; } h1 { font-size:20px; font-weight:500; margin:0 0 8px; } .meta { color:var(--text2); font-size:12px; margin:0 0 20px; }
          .video { aspect-ratio:16/9; border-radius:4px; background:#18191c; display:grid; place-items:center; color:#aeb4bd; }
          .video-toolbar-left-main,.toolbar-left { display:flex; align-items:center; gap:20px; flex-wrap:wrap; min-height:56px; border-bottom:1px solid var(--line_regular); }
          .native-action { padding:4px 0; border:0; color:var(--text2); background:none; font:inherit; } .description { color:var(--text2); }
        </style></head><body><div id="app" data-server-rendered="true"><header>bilibili</header><main><h1>Synthetic Bilibili video</h1><p class="meta">2026-11-03 · Public video preview</p><div class="video">Bilibili player</div>
        <div id="video-actions"><div class="video-toolbar-left"><div class="video-toolbar-left-main"><button class="native-action">赞 64</button><button class="native-action">币 15</button><button class="native-action">藏 49</button><button class="native-action">分享 5</button></div></div></div>
        <p class="description">Video details and episode information</p></main></div></body></html>`,
    }),
  );
  await page.addInitScript(() => {
    if (location.origin !== 'https://www.bilibili.com') return;
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.dataset.launcherRequests = '0';
      document.documentElement.dataset.launcherReplies = '0';
      window.addEventListener('message', (event: MessageEvent<unknown>) => {
        if (typeof event.data !== 'string') return;
        const value: unknown = JSON.parse(event.data);
        if (
          value &&
          typeof value === 'object' &&
          'channel' in value &&
          value.channel === 'ovs-bilibili-response'
        )
          document.documentElement.dataset.launcherReplies = '1';
      });
    });
  });
  for (const code of [script, script.replaceAll(origin, otherOrigin), script]) {
    await page.addInitScript({
      content: `(() => {
        if (location.origin !== 'https://www.bilibili.com') return;
        const unsafeWindow = window;
        const GM_xmlhttpRequest = () => {
          document.documentElement.dataset.launcherRequests = '1';
          throw Error('Bilibili launcher must not invoke helper network privileges.');
        };
        ${code}
      })();`,
    });
  }
  await page.goto('https://www.bilibili.com/video/BV1TESTaaaaa?p=2');
  const launcher = page.locator('#ovs-bilibili-launcher-v1');
  await expect(launcher).toHaveCount(1);
  await expect(launcher.locator('a').first()).not.toBeVisible();
  // Editing the SSR subtree before Vue hydrates it causes a full rebuild and
  // disrupts Bilibili's separately mounted header. Keep the entry outside it.
  await expect(page.locator('body > #ovs-bilibili-launcher-v1')).toHaveCount(1);
  await expect(page.getByRole('banner')).toHaveText('bilibili');
  const actions = await page.locator('#video-actions').innerHTML();
  // Hydration can finish without a child-list mutation.
  await page.locator('#app').evaluate((node) => {
    node.removeAttribute('data-server-rendered');
  });
  await expect(
    page.locator('.video-toolbar-left-main > #ovs-bilibili-launcher-v1'),
  ).toHaveCount(1);
  // The platform can also replace its action bar after hydration.
  await page
    .locator('#video-actions')
    .evaluate((node) => node.replaceChildren());
  await expect(page.locator('body > #ovs-bilibili-launcher-v1')).toHaveCount(1);
  await page.locator('#video-actions').evaluate((node, html) => {
    node.innerHTML = html;
  }, actions);
  await expect(
    page.locator('.video-toolbar-left-main > #ovs-bilibili-launcher-v1'),
  ).toHaveCount(1);
  await launcher.locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(launcher.locator('a').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(launcher.locator('a').first()).not.toBeVisible();
  await expect(launcher.locator('summary')).toBeFocused();
  await launcher.locator('summary').click();
  await expect(launcher.locator('a')).toHaveCount(2);
  const destination = launcher.locator(`a[data-ovs-origin="${origin}"]`);
  const alternate = launcher.locator(`a[data-ovs-origin="${otherOrigin}"]`);
  await expect(destination).toHaveAttribute(
    'href',
    `${origin}/import#v=1&bvid=BV1TESTaaaaa&part=2`,
  );
  await expect(alternate).toHaveAttribute(
    'href',
    `${otherOrigin}/import#v=1&bvid=BV1TESTaaaaa&part=2`,
  );
  await expect(destination).toHaveAttribute('rel', 'noopener noreferrer');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(launcher.locator('a').first()).not.toBeVisible();
  const bounds = (await launcher.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await launcher.locator('summary').click();
  const menu = (await launcher.locator('[data-ovs-menu]').boundingBox())!;
  expect(menu.x).toBeGreaterThanOrEqual(0);
  expect(menu.x + menu.width).toBeLessThanOrEqual(390);
  expect(menu.y + menu.height).toBeLessThanOrEqual(844);
  await page.getByRole('heading').click();
  await expect(launcher.locator('a').first()).not.toBeVisible();

  for (const [path, input, part] of [
    ['/video/BV1TESTaaaaa?p=2&token=SYNTHETIC', 'BV1TESTaaaaa', '2'],
    ['/bangumi/play/ep9000000000011?from=tracking', 'ep9000000000011', '1'],
    ['/bangumi/play/ss9000000000021', 'ss9000000000021', '1'],
  ] as const) {
    // Bilibili changes the current video without replacing the document.
    await page.evaluate((path) => history.replaceState(null, '', path), path);
    if (path.startsWith('/bangumi')) {
      await page.locator('#video-actions').evaluate((node) => {
        node.innerHTML =
          '<div class="toolbar"><div class="toolbar-left"><button class="native-action">赞 64</button><button class="native-action">分享 5</button></div></div>';
      });
      await expect(
        page.locator('.toolbar-left > #ovs-bilibili-launcher-v1'),
      ).toHaveCount(1);
    }
    if ((await launcher.getAttribute('open')) === null)
      await launcher.locator('summary').click();
    const opened = context.waitForEvent('page');
    await destination.click();
    const imported = await opened;
    await expect(imported).toHaveURL(`${origin}/import`);
    await expect(imported.locator('#bilibili-url')).toHaveValue(input!);
    if (part !== '1')
      await expect(imported.locator('#bilibili-part')).toHaveValue(part!);
    await imported.close();
  }

  await page.evaluate(() =>
    history.replaceState(null, '', '/video/BV1TESTaaaaa?p=0'),
  );
  await destination.click();
  await expect(destination).not.toHaveAttribute('href');
  await expect(launcher.locator('[role="status"]')).toBeVisible();
  await expect(page).toHaveURL(
    'https://www.bilibili.com/video/BV1TESTaaaaa?p=0',
  );
  expect(context.pages()).toHaveLength(1);

  // Platform-page code cannot use the OVS privileged bridge, even with its envelope.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const request = JSON.stringify({
          channel: 'ovs-bilibili-request',
          client: 'a'.repeat(32),
          id: 1,
          op: 'preview',
          bvid: 'BV1TESTaaaaa',
          part: 1,
        });
        const delivered = (event: MessageEvent<unknown>) => {
          if (
            event.source !== window ||
            event.origin !== location.origin ||
            event.data !== request
          )
            return;
          window.removeEventListener('message', delivered);
          resolve();
        };
        window.addEventListener('message', delivered);
        window.postMessage(request, location.origin);
      }),
  );
  await expect(page.locator('html')).toHaveAttribute(
    'data-launcher-requests',
    '0',
  );
  await expect(page.locator('html')).toHaveAttribute(
    'data-launcher-replies',
    '0',
  );
  // Scrolling a longer site list must not dismiss the menu itself.
  await page.keyboard.press('Escape');
  await page.evaluate(() =>
    history.replaceState(null, '', '/video/BV1TESTaaaaa'),
  );
  for (let site = 0; site < 10; site++) {
    const code = script.replaceAll(origin, `https://ovs-${site}.example`);
    await page.addScriptTag({
      content: `(() => { const unsafeWindow = window; ${code}\n})();`,
    });
  }
  await launcher.locator('summary').click();
  const siteMenu = launcher.locator('[data-ovs-menu]');
  await siteMenu.hover();
  await page.mouse.wheel(0, 160);
  await expect
    .poll(() => siteMenu.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await expect(siteMenu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(siteMenu).not.toBeVisible();
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page.getByRole('banner')).toHaveText('bilibili');
  expect(errors).toEqual([]);
});
