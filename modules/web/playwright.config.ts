import { defineConfig, devices } from '@playwright/test';
import { availableParallelism } from 'node:os';

import type { BrowserOptions } from './playwright-fixtures';

const measurements = process.env.OVS_E2E_MEASUREMENTS === '1';

export default defineConfig<BrowserOptions>({
  testDir: '../../tests/e2e',
  // Each test owns its application instance, database, and admission budgets.
  fullyParallel: true,
  // Journeys own multiple browser processes; leave CPU headroom on hosted runners.
  workers: measurements
    ? 1
    : Math.min(process.env.CI ? 2 : 4, availableParallelism()),
  testMatch: measurements ? 'measurement.spec.ts' : '**/*.spec.ts',
  testIgnore: measurements ? [] : ['measurement.spec.ts'],
  outputDir: measurements
    ? '../../.misc/e2e/measurements'
    : '../../.misc/e2e/results',
  reporter: 'list',
  use: {
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    ...(!measurements
      ? [
          {
            name: 'chromium-firefox',
            testMatch: 'playback.spec.ts',
            use: {
              ...devices['Desktop Chrome'],
              guestBrowserName: 'firefox' as const,
            },
          },
        ]
      : []),
  ],
});
