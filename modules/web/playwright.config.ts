import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import type { BrowserOptions } from './playwright-fixtures';

const host = process.env.OVS_E2E_HOST ?? '127.0.0.1';
const baseURL = `http://${host}:18080`;

export default defineConfig<BrowserOptions>({
  testDir: '../../tests/e2e',
  // Scenarios share one instance and its address-based admission budgets.
  workers: 1,
  outputDir: '../../.misc/e2e/results',
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    {
      name: 'chromium-firefox',
      testMatch: 'playback.spec.ts',
      use: { ...devices['Desktop Chrome'], guestBrowserName: 'firefox' },
    },
  ],
  webServer: {
    command: '../sync/build/ovs',
    url: `${baseURL}/health/ready`,
    reuseExistingServer: false,
    env: {
      OVS_LISTEN_ADDR: `${host}:18080`,
      OVS_PUBLIC_ORIGIN: baseURL,
      OVS_DATA_DIR: fileURLToPath(
        new URL('../../.misc/e2e/data', import.meta.url)
      ),
    },
  },
});
