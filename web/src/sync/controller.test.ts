import { expect, test } from 'vite-plus/test';
import { ClockEstimator } from './clock';
import { DriftController, SyncController } from './controller';
import { defaultSettings, type Snapshot } from '../transport/api';
import type { PlayerAdapter, PlayerObservation } from '../player/adapters/local';

test('four-timestamp calibration rejects invalid samples and expires after suspension', () => {
  const clock = new ClockEstimator();
  expect(clock.add(100, 200, 250, 120)).toBe(false);
  expect(clock.add(100, 200, 190, 120)).toBe(false);
  expect(clock.add(100, 200, 200, 2201)).toBe(false);
  for (let i = 0; i < 5; i++)
    expect(clock.add(i * 100, i * 100 + 105, i * 100 + 106, i * 100 + 11)).toBe(true);
  expect(clock.estimate(5)).toBeUndefined();
  expect(clock.estimate(500)).toEqual({ offsetMs: 100, uncertaintyMs: 5 });
  expect(clock.estimate(31000)).toBeUndefined();
  clock.reset();
  expect(clock.estimate(500)).toBeUndefined();
});
test('drift correction persists soft error, clamps rates, and bounds corrective seeks', () => {
  const c = new DriftController(),
    settings = defaultSettings();
  expect(c.decide(300, 1000, 0, settings, true, false, 40).kind).toBe('none');
  c.decide(300, 1000, 250, settings, true, false, 40);
  expect(c.decide(300, 1000, 500, settings, true, false, 40)).toEqual({ kind: 'rate', rate: 1.05 });
  expect(c.decide(-300, 1000, 750, settings, true, true, 40)).toEqual({ kind: 'rate', rate: 1 });
  expect(c.decide(900, 1000, 1000, settings, true, true, 40)).toEqual({
    kind: 'seek',
    target: 1000,
  });
  expect(c.decide(900, 1000, 1250, settings, true, false, 40).kind).toBe('none');
  expect(c.decide(900, 1000, 3100, settings, true, false, 40).kind).toBe('none');
  expect(c.decide(900, 1000, 4100, settings, true, false, 40).kind).toBe('seek');
  const fallback = new DriftController();
  fallback.decide(150, 1000, 0, settings, false, false, 40);
  fallback.decide(150, 1000, 250, settings, false, false, 40);
  expect(fallback.decide(150, 1000, 500, settings, false, false, 40).kind).toBe('seek');
});
class Player implements PlayerAdapter {
  capabilities = {
    canPlay: true,
    canPause: true,
    canSeek: true,
    canReadPosition: true,
    canSetPlaybackRate: true,
    canDetectBuffering: true,
    canShowDanmaku: false,
    positionResolutionMs: 40,
  };
  state: PlayerObservation = {
    positionMs: 0,
    durationMs: 10000,
    paused: true,
    seeking: false,
    status: 'ready',
  };
  pendingSeek?: () => void;
  blockSeek = false;
  async load(): Promise<void> {}
  async play(): Promise<void> {
    this.state.paused = false;
  }
  async pause(): Promise<void> {
    this.state.paused = true;
  }
  async seek(position: number): Promise<void> {
    if (this.blockSeek)
      await new Promise<void>((resolve) => {
        this.pendingSeek = resolve;
      });
    this.state.positionMs = position;
  }
  async setPlaybackRate(): Promise<void> {}
  getState(): PlayerObservation {
    return { ...this.state };
  }
  subscribe(): () => void {
    return () => {};
  }
  dispose(): void {}
}
const timeline = (phase: 'playing' | 'paused', revision: number, position = 1000): Snapshot => ({
  roomId: 'a'.repeat(32),
  epoch: 'b'.repeat(32),
  title: 'Test',
  revision,
  mediaGeneration: 1,
  hostMemberId: 'c'.repeat(32),
  selfMemberId: 'c'.repeat(32),
  settings: defaultSettings(),
  media: {
    kind: 'local',
    digest: 'd'.repeat(64),
    fingerprintVersion: 1,
    sizeBytes: 10,
    durationMs: 10000,
  },
  barrier: null,
  members: [
    {
      memberId: 'c'.repeat(32),
      displayName: 'Host',
      role: 'host',
      presence: 'connected',
      playbackActive: true,
      playbackEligible: true,
      excludedFromWaiting: false,
      readiness: null,
    },
  ],
  serverNowMs: 0,
  playback: {
    phase,
    positionMs: position,
    anchorServerMs: 0,
    baseRate: 1,
    desiredPlaying: phase === 'playing',
  },
});
test('a pause during an asynchronous remote seek wins without discarding the new intent', async () => {
  const c = new SyncController(),
    p = new Player();
  p.blockSeek = true;
  const original = c.reconcile(
    p,
    timeline('playing', 1),
    { offsetMs: 0, uncertaintyMs: 1 },
    0,
    true,
  );
  await Promise.resolve();
  expect(p.pendingSeek).toBeDefined();
  p.blockSeek = false;
  await c.reconcile(p, timeline('paused', 2, 0), { offsetMs: 0, uncertaintyMs: 1 }, 0, true);
  p.pendingSeek?.();
  await original;
  await c.reconcile(p, timeline('paused', 2, 0), { offsetMs: 0, uncertaintyMs: 1 }, 250, true);
  expect(p.getState().paused).toBe(true);
  expect(p.getState().positionMs).toBe(0);
});
test('loss of connection cancels pending playback application', async () => {
  const c = new SyncController(),
    p = new Player();
  p.blockSeek = true;
  const original = c.reconcile(
    p,
    timeline('playing', 1),
    { offsetMs: 0, uncertaintyMs: 1 },
    0,
    true,
  );
  await Promise.resolve();
  await c.reconcile(p, timeline('playing', 1), undefined, 50, false);
  p.pendingSeek?.();
  await original;
  expect(p.getState().paused).toBe(true);
});

test('a late participant stays paused until the server admits playback', async () => {
  const c = new SyncController(),
    p = new Player(),
    snapshot = timeline('playing', 1);
  snapshot.members[0]!.playbackEligible = false;
  await c.reconcile(p, snapshot, { offsetMs: 0, uncertaintyMs: 1 }, 1000, true);
  expect(p.getState().paused).toBe(true);
  snapshot.members[0]!.playbackEligible = true;
  snapshot.revision++;
  await c.reconcile(p, snapshot, { offsetMs: 0, uncertaintyMs: 1 }, 1000, true);
  expect(p.getState().paused).toBe(false);
  expect(p.getState().positionMs).toBe(2000);
});
