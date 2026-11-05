import { expect, test } from '../../modules/web/playwright-fixtures';
import { dismissHelper, openQuickActions, runQuickAction } from './flows';

// Keyboard search, IME, and focus transfer are a separate interaction contract.
// Room permissions and playback through this menu extend the existing room journey.
test('quick actions search locally, prefill videos, and preserve keyboard focus', async ({
  page,
}) => {
  const failures: string[] = [];
  const mutations: string[] = [];
  const documentFits = () =>
    page.evaluate(() => {
      const root = document.documentElement;
      return {
        horizontal: root.scrollWidth <= root.clientWidth + 1,
        vertical: root.scrollHeight <= root.clientHeight + 1,
      };
    });
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
    input = palette.getByRole('combobox');
  await expect(input).toHaveCSS('outline-style', 'none');
  await expect(page.locator('.command-search')).toHaveCSS(
    'outline-style',
    'none',
  );
  expect(await palette.evaluate((node) => node.getAnimations().length)).toBe(0);
  await input.fill('/theme');
  await input.press('ArrowDown');
  await expect(palette.getByRole('option', { selected: true })).toContainText(
    '/theme light',
  );
  await input.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');
  await expect(name).toBeFocused();
  await runQuickAction(page, '/appearance');
  await expect(
    page.getByRole('dialog', { name: 'Appearance', exact: true }),
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
      }),
    ),
  );
  await expect(palette).toBeVisible();
  await input.fill('unmatched-action-xyz');
  await expect(palette.getByRole('option')).toHaveCount(0);
  await expect(input).not.toHaveAttribute('aria-activedescendant');
  await input.press('Enter');
  await expect(palette).toBeVisible();
  await input.fill('@');
  await expect(palette.getByRole('option')).toHaveCount(0);
  await expect(palette.getByRole('status')).toContainText('Join a room');
  await input.press('Enter');
  await expect(palette).toBeVisible();
  await input.fill('$ https://example.com/private-video');
  await expect(palette.getByRole('option')).toHaveCount(0);
  await expect(palette.getByRole('status')).toBeVisible();
  await input.press('Escape');
  await expect(name).toBeFocused();

  await runQuickAction(
    page,
    '$ https://www.bilibili.com/video/BV1TESTaaaaa/?p=2&tracking=synthetic',
  );
  await expect(page.locator('#bilibili-url')).toBeFocused();
  await expect(page.locator('#bilibili-url')).toHaveValue('BV1TESTaaaaa');
  await expect(page.locator('#bilibili-part')).toHaveValue('2');
  await expect(name).toHaveValue('Keep this draft');
  await runQuickAction(
    page,
    'https://www.bilibili.com/video/BV1TESTaaaaa/?p=3',
  );
  await expect(page.locator('#bilibili-part')).toHaveValue('3');
  await runQuickAction(page, 'BV1TESTaaaaa');
  await expect(page.locator('#bilibili-part')).toBeHidden();
  await expect(page.getByRole('spinbutton')).toHaveCount(0);
  for (const [query, expected] of [
    [
      'https://www.bilibili.com/bangumi/play/ss9000000000021?tracking=synthetic',
      'ss9000000000021',
    ],
    ['$ ep9000000000011', 'ep9000000000011'],
  ]) {
    await runQuickAction(page, query!);
    await expect(page.locator('#bilibili-url')).toHaveValue(expected!);
    await expect(page.locator('#bilibili-part')).toBeHidden();
    await expect(page.getByRole('spinbutton')).toHaveCount(0);
  }
  await runQuickAction(page, '加入');
  await expect(page.locator('#join-code')).toBeFocused();
  await expect(
    page.locator('.input-action').filter({ has: page.locator('#join-code') }),
  ).toHaveCSS('outline-style', 'none');
  await runQuickAction(page, '/language zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await runQuickAction(page, '加入');
  await expect(page.locator('#join-code')).toBeFocused();
  await openQuickActions(page, '/theme dark');
  await palette.getByRole('option', { selected: true }).click();
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
    await input.fill('/about');
    await input.press('Enter');
    await expect(
      page.getByRole('dialog', { name: 'About', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.command-trigger')).toBeFocused();
    expect(await documentFits()).toEqual({ horizontal: true, vertical: true });
  }
  await runQuickAction(page, '/theme light');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.fontSize = '200%';
  });
  await openQuickActions(page);
  expect(await documentFits()).toEqual({ horizontal: true, vertical: true });
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
      .getByRole('status'),
  ).toContainText('storage is unavailable');
  await page.keyboard.press('Escape');
  await runQuickAction(page, '/language zh-CN');
  await expect(
    page.getByRole('dialog', { name: '语言', exact: true }).getByRole('status'),
  ).toBeVisible();
  expect(mutations).toEqual([]);
  expect(failures).toEqual([]);
});
