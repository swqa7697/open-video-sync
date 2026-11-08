import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import {
  expect,
  mockRepository,
  test,
  type Page,
} from '../../modules/web/playwright-fixtures';
import {
  clickPlayerControl,
  createLocalRoom,
  dismissHelper,
  invitationLink,
  seekTo,
  settings,
} from './flows';
import { generatedVideo } from './media';

interface Observation {
  at: number;
  frame: number;
}
interface Event {
  at: number;
  kind: string;
}
interface Capture {
  samples: Observation[];
  events: Event[];
  inputs: Event[];
}
async function observe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const video = document.querySelector('video')!;
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas unavailable.');
    const capture = {
      samples: [] as { at: number; frame: number }[],
      events: [] as { at: number; kind: string }[],
      inputs: [] as { at: number; kind: string }[],
    };
    (globalThis as unknown as { ovsCapture: typeof capture }).ovsCapture =
      capture;
    for (const kind of ['playing', 'pause', 'seeked', 'ratechange', 'waiting'])
      video.addEventListener(kind, () =>
        capture.events.push({ kind, at: performance.now() }),
      );
    document.addEventListener(
      'click',
      (event) => {
        const button = (event.target as Element).closest('button');
        if (
          button &&
          ['Play together', 'Pause together', 'Seek together'].includes(
            button.getAttribute('aria-label') ?? '',
          )
        )
          capture.inputs.push({
            kind: button.getAttribute('aria-label')!,
            at: performance.now(),
          });
      },
      true,
    );
    document
      .getElementById('seek-seconds')
      ?.addEventListener('change', () =>
        capture.inputs.push({ kind: 'Seek together', at: performance.now() }),
      );
    function sample() {
      if (video.readyState >= 2) {
        ctx!.drawImage(video, 0, 0, 640, 360);
        let frame = 0;
        for (let bit = 0; bit < 16; bit++) {
          const p = ctx!.getImageData(bit * 32 + 16, 272, 1, 1).data;
          if (p[0]! > 128) frame |= 1 << bit;
        }
        capture.samples.push({ at: performance.now(), frame });
        if (capture.samples.length > 10000) capture.samples.shift();
      }
      requestAnimationFrame(sample);
    }
    sample();
  });
}
async function capture(page: Page): Promise<Capture> {
  return page.evaluate(
    () => (globalThis as unknown as { ovsCapture: Capture }).ovsCapture,
  );
}
async function clockOffset(
  page: Page,
): Promise<{ offset: number; uncertainty: number }> {
  const samples: { offset: number; uncertainty: number }[] = [];
  for (let i = 0; i < 5; i++) {
    const start = performance.now(),
      browser = await page.evaluate(() => performance.now()),
      end = performance.now();
    samples.push({
      offset: (start + end) / 2 - browser,
      uncertainty: (end - start) / 2,
    });
  }
  return samples.sort((a, b) => a.uncertainty - b.uncertainty)[0]!;
}
function stats(values: number[]) {
  if (!values.length)
    return {
      count: 0,
      mean: null,
      median: null,
      standardDeviation: null,
      min: null,
      max: null,
      p95: null,
      p99: null,
    };
  const sorted = [...values].sort((a, b) => a - b),
    n = sorted.length,
    mean = values.reduce((a, b) => a + b, 0) / n;
  return {
    count: n,
    mean,
    median: sorted[Math.floor(n / 2)],
    standardDeviation: Math.sqrt(
      values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / Math.max(1, n - 1),
    ),
    min: sorted[0],
    max: sorted[n - 1],
    p95: sorted[Math.min(n - 1, Math.ceil(n * 0.95) - 1)],
    p99: sorted[Math.min(n - 1, Math.ceil(n * 0.99) - 1)],
  };
}

test('three independent nearby trials observe decoded frames separately from control application', async ({
  browser,
  browserName,
  baseURL,
}, testInfo) => {
  test.setTimeout(120000);
  const fixture = await generatedVideo(browser),
    trials: unknown[] = [];
  await writeFile(testInfo.outputPath('timecoded.webm'), fixture);
  for (let trial = 0; trial < 3; trial++) {
    const hostBrowser = await browser.browserType().launch(),
      guestBrowser = await browser.browserType().launch();
    try {
      const host = await hostBrowser.newPage(),
        guest = await guestBrowser.newPage();
      await mockRepository(host.context());
      await mockRepository(guest.context());
      await host.goto(baseURL!);
      await createLocalRoom(
        host,
        { name: 'synthetic.webm', mimeType: 'video/webm', buffer: fixture },
        `Observed trial ${trial}`,
      );
      await expect(
        host.getByRole('status').filter({ hasText: 'Clock calibrated' }),
      ).toBeVisible();
      const invitation = await invitationLink(host);
      await guest.goto(invitation);
      await dismissHelper(guest);
      await expect(
        guest.getByRole('status').filter({ hasText: 'Clock calibrated' }),
      ).toBeVisible();
      await settings(host, false, false);
      const file = {
        name: 'generated-timecode.webm',
        mimeType: 'video/webm',
        buffer: fixture,
      };
      await host.locator('#local-video').setInputFiles(file);
      await expect(host.getByTestId('media-status')).toHaveAttribute(
        'data-state',
        'ready',
      );
      await guest.locator('#local-video').setInputFiles(file);
      await expect(guest.getByTestId('media-status')).toHaveAttribute(
        'data-state',
        'ready',
      );
      expect(await host.evaluate(() => document.visibilityState)).toBe(
        'visible',
      );
      expect(await guest.evaluate(() => document.visibilityState)).toBe(
        'visible',
      );
      await Promise.all([observe(host), observe(guest)]);
      const offsets = await Promise.all([
        clockOffset(host),
        clockOffset(guest),
      ]);
      // Paused source frames validate the independent pixel code before timing trials.
      const calibration: {
        seconds: number;
        hostFrame: number;
        guestFrame: number;
      }[] = [];
      for (const seconds of [1, 5, 10]) {
        await seekTo(host, seconds);
        for (const player of [host, guest])
          await expect
            .poll(async () => {
              const data = await capture(player);
              return data.samples.at(-1)?.frame;
            })
            .toBe(seconds * 30);
        const h = await capture(host),
          g = await capture(guest);
        calibration.push({
          seconds,
          hostFrame: h.samples.at(-1)!.frame,
          guestFrame: g.samples.at(-1)!.frame,
        });
      }
      if (trial === 0)
        await host.locator('video').screenshot({
          path: testInfo.outputPath('calibrated-frame-300.png'),
        });
      const started = performance.now();
      await clickPlayerControl(host, 'Play together');
      await expect
        .poll(async () => (await capture(guest)).samples.at(-1)!.frame)
        .toBeGreaterThan(315);
      // Collect four seconds of decoded source progression, including corrections.
      const firstFrame = (await capture(guest)).samples.at(-1)!.frame;
      await expect
        .poll(async () => (await capture(guest)).samples.at(-1)!.frame, {
          timeout: 10000,
        })
        .toBeGreaterThanOrEqual(firstFrame + 120);
      // Measure the explicit pause before seeking, since a seek now also pauses.
      await clickPlayerControl(host, 'Pause together');
      for (const player of [host, guest])
        await expect(player.locator('video')).toHaveJSProperty('paused', true);
      await seekTo(host, 20);
      for (const player of [host, guest])
        await expect
          .poll(async () => (await capture(player)).samples.at(-1)!.frame)
          .toBeGreaterThanOrEqual(600);
      for (const player of [host, guest])
        await expect
          .poll(() =>
            player
              .locator('video')
              .evaluate((v) => (v as HTMLVideoElement).paused),
          )
          .toBe(true);
      const ended = performance.now(),
        h = await capture(host),
        g = await capture(guest);
      const skew: number[] = [],
        alignment: number[] = [];
      for (const sample of h.samples) {
        const at = sample.at + offsets[0]!.offset;
        if (at < started || at > ended) continue;
        const nearest = g.samples.reduce<Observation | undefined>(
          (best, item) =>
            !best ||
            Math.abs(item.at + offsets[1]!.offset - at) <
              Math.abs(best.at + offsets[1]!.offset - at)
              ? item
              : best,
          undefined,
        );
        if (!nearest) continue;
        const delta = Math.abs(nearest.at + offsets[1]!.offset - at);
        if (delta <= 25) {
          skew.push((Math.abs(sample.frame - nearest.frame) * 1000) / 30);
          alignment.push(delta);
        }
      }
      await writeFile(
        testInfo.outputPath(`trial-${trial}-observations.json`),
        JSON.stringify({ started, ended, offsets, host: h, guest: g }) + '\n',
      );
      const controls: {
        action: string;
        hostMs: number;
        guestMs: number | null;
        guestEstimateMs: number;
        guestIntervalMs: [number, number];
      }[] = [];
      // Offset brackets and each browser's millisecond timestamp resolution can
      // place a real event just before the estimated input time.
      const controlUncertaintyMs =
        offsets[0]!.uncertainty + offsets[1]!.uncertainty + 2;
      for (const input of h.inputs) {
        const at = input.at + offsets[0]!.offset;
        if (at < started) continue;
        const kind =
          input.kind === 'Play together'
            ? 'playing'
            : input.kind === 'Pause together'
              ? 'pause'
              : 'seeked';
        const he = h.events.find((e) => e.kind === kind && e.at >= input.at),
          ge = g.events.find(
            (e) =>
              e.kind === kind &&
              e.at + offsets[1]!.offset + controlUncertaintyMs >= at,
          );
        if (!he || !ge) throw new Error(`Missing ${kind} observation.`);
        const guestEstimateMs = ge.at + offsets[1]!.offset - at;
        controls.push({
          action: input.kind,
          hostMs: he.at - input.at,
          guestMs: guestEstimateMs < 0 ? null : guestEstimateMs,
          guestEstimateMs,
          guestIntervalMs: [
            Math.max(0, guestEstimateMs - controlUncertaintyMs),
            Math.max(0, guestEstimateMs + controlUncertaintyMs),
          ],
        });
      }
      expect(controls).toHaveLength(3);
      expect(skew.length).toBeGreaterThan(100);
      const lastHost = h.samples.at(-1)!.frame,
        lastGuest = g.samples.at(-1)!.frame;
      expect(Math.abs(lastHost - lastGuest)).toBeLessThanOrEqual(3);
      trials.push({
        trial,
        browser: hostBrowser.version(),
        foregroundDocuments: true,
        offsets,
        calibration,
        controls,
        controlApplicationMs: {
          host: stats(controls.map((c) => c.hostMs)),
          guest: stats(
            controls.flatMap((c) => (c.guestMs === null ? [] : [c.guestMs])),
          ),
        },
        controlUncertaintyMs,
        unresolvedGuestLatencies: controls.filter((c) => c.guestMs === null)
          .length,
        displayedSkewMs: stats(skew),
        maximumPairingDeltaMs: Math.max(...alignment),
        combinedObservationUncertaintyMs:
          (2 * 1000) / 30 +
          Math.max(...alignment) +
          offsets[0]!.uncertainty +
          offsets[1]!.uncertainty,
        correctiveSeekEventsDuringSteadyPlayback: h.events.filter(
          (e) =>
            e.kind === 'seeked' &&
            e.at + offsets[0]!.offset > started + 1000 &&
            e.at + offsets[0]!.offset < ended - 1000,
        ).length,
        raw: { host: h, guest: g },
      });
    } finally {
      await hostBrowser.close();
      await guestBrowser.close();
    }
  }
  await writeFile(
    testInfo.outputPath('nearby-measurements.json'),
    JSON.stringify(
      {
        browserName,
        origin: baseURL,
        fixtureSha256: createHash('sha256').update(fixture).digest('hex'),
        fixtureBytes: fixture.length,
        trials,
        limitations:
          'Three independent foreground-document trials in separate headless processes of the named browser on one host; VP8 without audio, encoded with Chromium; canvas reads decoded displayed pixels and was calibrated at three paused source positions. No physical display/camera timing, injected impairment, cross-region, stable-browser, or release guarantee. Control intervals include clock brackets and two milliseconds for timestamp resolution; negative point estimates are unresolved and excluded from latency summaries. Tails are sparse. Samples within trials are correlated. Not a before/after performance comparison.',
      },
      null,
      2,
    ) + '\n',
  );
});
