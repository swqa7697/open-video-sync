import { expect, type Page } from '../../modules/web/playwright-fixtures';

export interface VideoFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}
export async function observePageKeyboard(page: Page) {
  return page.evaluateHandle(() => {
    const events: string[] = [];
    const record = (event: KeyboardEvent) => {
      events.push(`${event.type}:${event.key}`);
    };
    const types = ['keydown', 'keypress', 'keyup'] as const;
    for (const type of types) document.addEventListener(type, record);
    return {
      events,
      stop() {
        for (const type of types) document.removeEventListener(type, record);
      },
    };
  });
}
export async function openAppPanel(page: Page, name: string): Promise<void> {
  await page.locator('.app-settings-trigger').click();
  await page.getByRole('menuitem', { name, exact: true }).click();
}
export async function dismissHelper(page: Page): Promise<void> {
  await expect
    .poll(
      async () =>
        (
          await page
            .getByRole('complementary', { name: 'Playback helper' })
            .allTextContents()
        ).join(''),
      { timeout: 8000 },
    )
    .not.toContain('Checking');
  const later = page.getByRole('button', { name: 'Later', exact: true });
  if (await later.isVisible()) await later.click();
}
// Pointer actions reveal the bar first, as users do when controls are hidden.
export async function clickPlayerControl(
  page: Page,
  name: string,
): Promise<void> {
  await page.locator('.video-stage').hover({ position: { x: 100, y: 100 } });
  await page.getByRole('button', { name, exact: true }).click();
}
export async function openPlayerMenu(
  page: Page,
  input: 'pointer' | 'keyboard' = 'pointer',
): Promise<void> {
  await page.bringToFront();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
  const stage = page.locator('.video-stage');
  if (input === 'keyboard') {
    await stage.focus();
    await page.keyboard.press('Shift+F10');
  } else await stage.click({ button: 'right', position: { x: 80, y: 60 } });
  await expect(page.getByRole('menu', { name: 'Player menu' })).toBeVisible();
}
export async function openQuickActions(page: Page, query = ''): Promise<void> {
  // Native actions require the foreground page, as with real keyboard input.
  await page.bringToFront();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Control+k');
  const input = page.locator('.command-palette').getByRole('combobox');
  await expect(input).toBeFocused();
  if (query) await input.fill(query);
}
export async function runQuickAction(page: Page, query: string): Promise<void> {
  await openQuickActions(page, query);
  await page.locator('.command-palette').getByRole('combobox').press('Enter');
  await expect(page.locator('.command-palette')).toHaveCount(0);
}
export async function createLocalRoom(
  page: Page,
  file: VideoFile,
  title: string,
): Promise<void> {
  await dismissHelper(page);
  await page.getByRole('button', { name: 'Local file', exact: true }).click();
  await page.locator('#create-local-video').setInputFiles(file);
  await page.getByLabel('Room name', { exact: false }).fill(title);
  await page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('media-status')).toHaveAttribute(
    'data-state',
    'ready',
  );
}
export async function invitationLink(page: Page): Promise<string> {
  await page.getByRole('button', { name: 'Invite', exact: true }).click();
  await expect(
    page.getByLabel('Invitation link', { exact: true }),
  ).not.toHaveValue('');
  const value = await page
    .getByLabel('Invitation link', { exact: true })
    .inputValue();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  return value;
}
export async function settings(
  page: Page,
  controllers: 'host' | 'everyone',
  wait = true,
): Promise<void> {
  await page
    .getByRole('button', { name: 'Room settings', exact: true })
    .click();
  await page
    .getByLabel('Playback controls', { exact: true })
    .selectOption(controllers);
  await page.getByLabel('Wait for everyone', { exact: true }).setChecked(wait);
  await page
    .getByRole('button', { name: 'Save preferences', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}
// Exact synthetic slider input keeps the independent decoded-frame calibration deterministic.
// The shell journey separately exercises pointer seeking through the actual browser control.
export async function seekTo(page: Page, seconds: number): Promise<void> {
  await page
    .getByRole('slider', { name: 'Seek', exact: true })
    .evaluate((input: HTMLInputElement, value) => {
      input.value = String(value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, seconds);
}
export async function closeRoom(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: 'Room settings', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Close room for everyone', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Confirm close room', exact: true })
    .click();
}
