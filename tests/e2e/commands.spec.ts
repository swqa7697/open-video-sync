import { expect, test } from '../../modules/web/playwright-fixtures';
import { dismissHelper, openQuickActions, runQuickAction } from './flows';

// Keyboard search, IME, and focus transfer are a separate interaction contract.
// Room permissions and playback through this menu extend the existing room journey.
test('quick actions search locally, prefill videos, and preserve keyboard focus', async ({
  page,
}, testInfo) => {
  const failures: string[] = [];
  const mutations: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await dismissHelper(page);
  await expect(page.locator('#room-name')).toBeEditable();
  page.on('request', (request) => {
    if (request.method() !== 'GET')
      mutations.push(new URL(request.url()).pathname);
  });
  const name = page.locator('#room-name');
  await name.fill('Keep this draft');
  await openQuickActions(page);
  const palette = page.locator('.command-palette'),
    input = page.getByRole('combobox');
  expect(await palette.evaluate((node) => node.getAnimations().length)).toBe(0);
  await page.screenshot({
    path: testInfo.outputPath('commands-desktop-dark.png'),
  });
  await input.fill('/theme');
  await input.press('ArrowDown');
  await expect(palette.getByRole('option', { selected: true })).toContainText(
    '/theme light'
  );
  await input.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');
  await expect(name).toBeFocused();
  await runQuickAction(page, '/appearance');
  await expect(
    page.getByRole('dialog', { name: 'Appearance', exact: true })
  ).toBeVisible();
  await page.keyboard.press('Control+k');
  await expect(palette).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(name).toBeFocused();

  await page.keyboard.press('Meta+k');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('');
  await input.fill('/join');
  await input.evaluate((node) =>
    node.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
      })
    )
  );
  await expect(palette).toBeVisible();
  await input.fill('unmatched-action-xyz');
  await expect(palette.getByRole('option')).toHaveCount(0);
  await expect(input).not.toHaveAttribute('aria-activedescendant');
  await input.press('Enter');
  await expect(palette).toBeVisible();
  await input.fill('$ https://example.com/private-video');
  await expect(palette.getByRole('option')).toHaveCount(0);
  await expect(palette.getByRole('status')).toBeVisible();
  await input.press('Escape');
  await expect(name).toBeFocused();

  await runQuickAction(
    page,
    '$ https://www.bilibili.com/video/BV1hf4y1N75G/?p=2&tracking=synthetic'
  );
  await expect(page.locator('#bilibili-url')).toBeFocused();
  await expect(page.locator('#bilibili-url')).toHaveValue('BV1hf4y1N75G');
  await expect(page.locator('#bilibili-part')).toHaveValue('2');
  await expect(name).toHaveValue('Keep this draft');
  await runQuickAction(
    page,
    'https://www.bilibili.com/video/BV1hf4y1N75G/?p=3'
  );
  await expect(page.locator('#bilibili-part')).toHaveValue('3');
  await runQuickAction(page, 'BV1hf4y1N75G');
  await expect(page.locator('#bilibili-part')).toHaveCount(0);
  await runQuickAction(page, '加入');
  await expect(page.locator('#join-code')).toBeFocused();
  await runQuickAction(page, '/language zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await openQuickActions(page);
  await page.screenshot({
    path: testInfo.outputPath('commands-desktop-zh.png'),
  });
  await page.keyboard.press('Escape');
  await runQuickAction(page, '加入');
  await expect(page.locator('#join-code')).toBeFocused();
  await openQuickActions(page, '/theme dark');
  await page.getByRole('option', { selected: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await runQuickAction(page, '/language en');

  for (const [width, height] of [
    [1440, 900],
    [390, 844],
    [390, 480],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page
      .getByRole('button', { name: 'Open quick actions', exact: true })
      .click();
    await expect(input).toBeFocused();
    const bounds = await palette.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width!);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height!);
    await page.screenshot({
      path: testInfo.outputPath(`commands-${width}-${height}.png`),
    });
    await input.fill('/about');
    await input.press('Enter');
    await expect(
      page.getByRole('dialog', { name: 'About', exact: true })
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.command-trigger')).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`home-${width}-${height}.png`),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true);
  }
  await runQuickAction(page, '/theme light');
  await openQuickActions(page, '/language');
  await page.screenshot({
    path: testInfo.outputPath('commands-mobile-light.png'),
  });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await openQuickActions(page);
  await page.screenshot({
    path: testInfo.outputPath('commands-200-percent.png'),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true);
  await page.keyboard.press('Control+k');
  await expect(palette).toHaveCount(0);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '';
    Storage.prototype.setItem = () => {
      throw new DOMException('Blocked', 'SecurityError');
    };
  });
  await runQuickAction(page, '/theme dark');
  await expect(
    page
      .getByRole('dialog', { name: 'Appearance', exact: true })
      .getByRole('status')
  ).toContainText('storage is unavailable');
  await page.keyboard.press('Escape');
  await runQuickAction(page, '/language zh-CN');
  await expect(
    page.getByRole('dialog', { name: '语言', exact: true }).getByRole('status')
  ).toBeVisible();
  expect(mutations).toEqual([]);
  expect(failures).toEqual([]);
});
