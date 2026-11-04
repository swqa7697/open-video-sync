import {
  test as base,
  firefox,
  type Browser,
  type BrowserContext,
} from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';

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
    }),
  );
}

export async function appContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext();
  await mockRepository(context);
  return context;
}

export const test = base.extend<BrowserOptions & { guestBrowser: Browser }>({
  guestBrowserName: ['same', { option: true }],
  baseURL: async ({ playwright }, use, testInfo) => {
    const host = process.env.OVS_E2E_HOST ?? '127.0.0.1';
    const port =
      Number(process.env.OVS_E2E_PORT ?? 18080) + testInfo.parallelIndex;
    const address = `${host}:${port}`;
    const origin = `http://${address}`;
    const data = testInfo.outputPath('data');
    await mkdir(data, { recursive: true });
    const configFile = testInfo.config.configFile;
    if (!configFile) throw new Error('Playwright configuration required.');
    const server = spawn(resolve(dirname(configFile), '../sync/build/ovs'), {
      env: {
        ...process.env,
        OVS_LISTEN_ADDR: address,
        OVS_PUBLIC_ORIGIN: origin,
        OVS_DATA_DIR: data,
        OVS_LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const closed = new Promise<void>((resolve) =>
      server.once('close', () => resolve()),
    );
    const stop = async () => {
      if (!server.pid || server.exitCode !== null || server.signalCode !== null)
        return;
      const stopped = once(server, 'close', {
        signal: AbortSignal.timeout(12000),
      });
      server.kill('SIGTERM');
      try {
        await stopped;
      } catch (error) {
        server.kill('SIGKILL');
        await closed;
        throw error;
      }
    };
    const lines = createInterface({ input: server.stderr });
    let logs = '';
    const ready = new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.once('exit', (code, signal) =>
        reject(new Error(`OVS exited (${signal ?? code}): ${logs}`)),
      );
      lines.on('line', (line) => {
        logs = `${logs}${line}\n`.slice(-16000);
        try {
          const entry = JSON.parse(line) as { msg?: string };
          if (entry.msg === 'server ready') resolve();
        } catch {
          // Early configuration failures can use the default text logger.
        }
      });
    });
    try {
      // A startup deadline rejects into this fixture's process cleanup.
      await Promise.race([
        ready,
        once(AbortSignal.timeout(10000), 'abort').then(() => {
          throw new Error(`OVS startup timed out: ${logs}`);
        }),
      ]);
      const client = await playwright.request.newContext();
      try {
        const response = await client.get(`${origin}/health/ready`, {
          timeout: 5000,
        });
        if (response.status() !== 204) throw new Error('OVS is not ready.');
      } finally {
        await client.dispose();
      }
      await use(origin);
    } finally {
      try {
        await stop();
      } finally {
        lines.close();
        await rm(data, { recursive: true, force: true });
        if (testInfo.status !== testInfo.expectedStatus)
          await testInfo.attach('server.log', {
            body: logs,
            contentType: 'text/plain',
          });
      }
    }
  },
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
