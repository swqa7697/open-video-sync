import { test as base, firefox, type Browser } from '@playwright/test';

// Shared journeys live outside web; resolve the runner through this package.
export { chromium, expect } from '@playwright/test';

export interface BrowserOptions {
  guestBrowserName: 'same' | 'firefox';
}

export const test = base.extend<BrowserOptions & { guestBrowser: Browser }>({
  guestBrowserName: ['same', { option: true }],
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
