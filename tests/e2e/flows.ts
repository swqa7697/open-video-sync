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
  // A reload can commit before Vue mounts the helper check and its setup dialog.
  await expect(page.locator('.shell')).toBeVisible();
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
  if (await later.count()) {
    await later.click();
    await expect(
      page.getByRole('dialog', {
        name: 'Set up Bilibili playback',
        exact: true,
      }),
    ).toHaveCount(0);
  }
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
  await expect(page.getByRole('dialog')).toHaveCount(0);
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

export async function expectFittedPlayer(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.locator('.video-stage').evaluate((node) => {
        const stage = node.getBoundingClientRect(),
          video = node.querySelector('video')!,
          viewport = node.parentElement!.getBoundingClientRect(),
          column = node.closest('.viewing-column')!.getBoundingClientRect();
        if (stage.width <= 0 || stage.height <= 0) return Infinity;
        const room = node.closest<HTMLElement>('.room')!,
          space = room.parentElement!,
          spacing = getComputedStyle(space),
          card = room.querySelector('.room-layout')!.getBoundingClientRect(),
          layoutStyle = getComputedStyle(room.querySelector('.room-layout')!),
          sidebarWidth =
            room.querySelector('.member-panel')?.getBoundingClientRect()
              .width ?? 0,
          detailsHeight =
            node.closest('.player-panel')!.getBoundingClientRect().height -
            viewport.height,
          availableWidth =
            space.clientWidth -
            parseFloat(spacing.paddingLeft) -
            parseFloat(spacing.paddingRight) -
            parseFloat(layoutStyle.borderLeftWidth) -
            parseFloat(layoutStyle.borderRightWidth) -
            sidebarWidth,
          availableHeight =
            space.getBoundingClientRect().height -
            parseFloat(spacing.paddingTop) -
            parseFloat(spacing.paddingBottom) -
            room.querySelector('.room-toolbar')!.getBoundingClientRect()
              .height -
            parseFloat(layoutStyle.borderTopWidth) -
            parseFloat(layoutStyle.borderBottomWidth) -
            detailsHeight,
          ratio = video.videoWidth / video.videoHeight,
          fittedHeight = Math.min(availableHeight, availableWidth / ratio);
        return Math.max(
          Math.abs(column.width - stage.width),
          Math.abs(viewport.height - stage.height),
          Math.abs(
            card.width -
              stage.width -
              sidebarWidth -
              parseFloat(layoutStyle.borderLeftWidth) -
              parseFloat(layoutStyle.borderRightWidth),
          ),
          Math.abs(stage.height - fittedHeight),
          Math.abs(stage.width - fittedHeight * ratio),
          Math.abs(
            stage.width - (stage.height * video.videoWidth) / video.videoHeight,
          ),
          viewport.left - stage.left,
          stage.right - viewport.right,
          viewport.top - stage.top,
          stage.bottom - viewport.bottom,
          column.left - stage.left,
          stage.right - column.right,
          stage.bottom - column.bottom,
          ...[
            '.video-information',
            '.playback-status',
            '.change-media',
          ].flatMap((selector) => {
            const element = node
              .closest('.player-panel')!
              .querySelector(selector);
            if (!element) return [Infinity];
            const bounds = element.getBoundingClientRect();
            if (bounds.width <= 0 || bounds.height <= 0) return [Infinity];
            return [
              column.left - bounds.left,
              bounds.right - column.right,
              bounds.bottom - column.bottom,
            ];
          }),
          ...Array.from(
            node.querySelectorAll(
              '.player-controls button, .player-controls input',
            ),
          ).flatMap((control) => {
            const bounds = control.getBoundingClientRect();
            return [
              stage.left - bounds.left,
              bounds.right - stage.right,
              stage.top - bounds.top,
              bounds.bottom - stage.bottom,
            ];
          }),
        );
      }),
    )
    .toBeLessThanOrEqual(1);
}
