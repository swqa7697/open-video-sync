import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '../tests/e2e',
  outputDir: '../.misc/e2e/results',
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:18080',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: '../build/ovs',
    url: 'http://127.0.0.1:18080/health/ready',
    reuseExistingServer: false,
    env: {
      OVS_LISTEN_ADDR: '127.0.0.1:18080',
      OVS_PUBLIC_ORIGIN: 'http://127.0.0.1:18080',
      OVS_DATA_DIR: fileURLToPath(new URL('../.misc/e2e/data', import.meta.url)),
    },
  },
});
