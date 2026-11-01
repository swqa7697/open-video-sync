import {
  test as base,
  firefox,
  type Browser,
  type BrowserContext,
} from '@playwright/test';

// Shared journeys live outside web; resolve the runner through this package.
export { chromium, expect } from '@playwright/test';

export interface BrowserOptions {
  guestBrowserName: 'same' | 'firefox';
}

// Public repository metadata stays synthetic in every ordinary browser journey.
export async function mockRepository(context: BrowserContext): Promise<void> {
  await context.route('https://api.github.com/**', (route) =>
    route.fulfill({
      json: { stargazers_count: 1234 },
      headers: { 'Access-Control-Allow-Origin': '*' },
    })
  );
}

export async function appContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await mockRepository(context);
  return context;
}

export const test = base.extend<BrowserOptions & { guestBrowser: Browser }>({
  guestBrowserName: ['same', { option: true }],
  context: async ({ context }, use) => {
    await mockRepository(context);
    await use(context);
  },
  guestBrowser: async ({ browser, guestBrowserName }, use) => {
    if (guestBrowserName === 'same') {
      await use(browser);
      return;
    }
    const guest = await firefox.launch();
    try {
      await use(guest);
    } finally {
      await guest.close();
    }
  },
});

export type { Browser, Page } from '@playwright/test';
