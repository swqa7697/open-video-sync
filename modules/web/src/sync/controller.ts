import type { PlayerAdapter } from '../player/adapters/local';
import type { Snapshot } from '../transport/api';
import type { ReadinessStatus } from '../transport/protocol-values';
import type { Estimate } from './clock';

export type Correction =
  | { kind: 'none' }
  | { kind: 'rate'; rate: number }
  | { kind: 'seek'; target: number };
export class DriftController {
  private samples = 0;
  private settledUntil = 0;
  private lastSeek = -Infinity;
  private sampledAt = -Infinity;
  reset(): void {
    this.samples = 0;
    this.settledUntil = 0;
    this.lastSeek = -Infinity;
    this.sampledAt = -Infinity;
  }
  decide(
    error: number,
    target: number,
    now: number,
    rateSupported: boolean,
    degraded: boolean,
    resolution: number,
    baseRate = 1,
  ): Correction {
    if (now < this.settledUntil || now - this.sampledAt < 250)
      return { kind: 'none' };
    this.sampledAt = now;
    const distance = Math.abs(error),
      soft = Math.max(100, resolution),
      hard = Math.max(750, resolution * 2);
    if (distance < soft) {
      this.samples = 0;
      return { kind: 'rate', rate: baseRate };
    }
    this.samples++;
    if (distance > hard || (this.samples >= 3 && !rateSupported)) {
      if (now - this.lastSeek < 3000) return { kind: 'none' };
      this.lastSeek = now;
      this.settledUntil = now + 2000;
      this.samples = 0;
      return { kind: 'seek', target };
    }
    if (degraded && rateSupported) return { kind: 'rate', rate: baseRate };
    if (this.samples >= 3 && rateSupported)
      return {
        kind: 'rate',
        rate: baseRate * Math.max(0.95, Math.min(1.05, 1 + error / 5000)),
      };
    return { kind: 'none' };
  }
}

export function supportsPlaybackRate(
  adapter: PlayerAdapter,
  rate: number,
): boolean {
  return (
    rate === 1 ||
    (adapter.capabilities.canSetPlaybackRate &&
      typeof adapter.setPlaybackRate === 'function')
  );
}
// Ownership belongs to the active panel. Every async completion checks adapter and generation.
export class SyncController {
  private drift = new DriftController();
  private applying = false;
  private generation = 0;
  private revision = -1;
  private identity = '';
  private targetFloor = 0;
  private operation = 0;
  private baseRate = 1;
  invalidate(): void {
    this.generation++;
    this.operation++;
    this.applying = false;
    this.revision = -1;
    this.identity = '';
    this.targetFloor = 0;
    this.baseRate = 1;
    this.drift.reset();
  }
  async reconcile(
    adapter: PlayerAdapter,
    snapshot: Snapshot,
    estimate: Estimate | undefined,
    now: number,
    enabled: boolean,
  ): Promise<void> {
    if (!enabled || !snapshot.media) {
      this.invalidate();
      await adapter.pause();
      return;
    }
    const key = `${snapshot.epoch}/${snapshot.mediaGeneration}`;
    if (this.identity !== key) {
      this.invalidate();
      this.identity = key;
    }
    const baseRate = snapshot.playback.rate;
    if (!supportsPlaybackRate(adapter, baseRate)) {
      this.invalidate();
      await adapter.pause();
      return;
    }
    const setRate = adapter.capabilities.canSetPlaybackRate
      ? adapter.setPlaybackRate?.bind(adapter)
      : undefined;
    const observed = adapter.getState();
    if (
      [
        'gesture_required',
        'unsupported',
        'access_denied',
        'error',
        'loading',
        'no_media',
        'mismatch',
      ].includes(observed.status)
    )
      return;
    // Preserve a buffering report while the server decides whether to wait.
    // Applying an old anchor here can seek and manufacture a new ready event.
    if (
      observed.status === 'buffering' &&
      snapshot.playback.phase === 'playing'
    )
      return;
    const playing = snapshot.playback.phase === 'playing';
    let target = Math.min(
      snapshot.media.durationMs,
      snapshot.playback.positionMs +
        (playing && estimate
          ? Math.max(
              0,
              now + estimate.offsetMs - snapshot.playback.anchorServerMs,
            ) * baseRate
          : 0),
    );
    const explicit =
      this.revision !== snapshot.revision || this.baseRate !== baseRate;
    // Calibration changes alone cannot send a running target backward.
    if (!explicit && playing) target = Math.max(this.targetFloor, target);
    this.targetFloor = target;
    if (explicit && this.applying) {
      this.operation++;
      this.applying = false;
    }
    if (this.applying) return;
    this.revision = snapshot.revision;
    this.baseRate = baseRate;
    if (explicit) this.drift.reset();
    const token = this.generation,
      operation = ++this.operation;
    this.applying = true;
    const current = () =>
      token === this.generation && operation === this.operation;
    try {
      if (!playing) {
        await adapter.pause();
        if (!current()) return;
        await setRate?.(baseRate);
        if (!current()) return;
        if (Math.abs(target - adapter.getState().positionMs) > 100) {
          await adapter.seek(target);
          if (!current()) return;
        }
      } else if (estimate) {
        if (explicit || observed.paused) {
          if (Math.abs(target - observed.positionMs) > 40) {
            await adapter.seek(target);
            if (!current()) return;
          }
          await setRate?.(baseRate);
          if (!current()) return;
          if (adapter.getState().paused) {
            await adapter.play();
            if (!current()) {
              await adapter.pause();
              return;
            }
          }
        } else if (!observed.seeking && observed.status !== 'buffering') {
          const correction = this.drift.decide(
            target - observed.positionMs,
            target,
            now,
            setRate !== undefined,
            estimate.uncertaintyMs > 250,
            adapter.capabilities.positionResolutionMs,
            baseRate,
          );
          if (correction.kind === 'seek') {
            await setRate?.(baseRate);
            if (!current()) return;
            await adapter.seek(correction.target);
            if (!current()) return;
          } else if (correction.kind === 'rate')
            await setRate?.(correction.rate);
        }
      } else {
        await adapter.pause();
        if (!current()) return;
        await setRate?.(baseRate);
      }
    } catch (error) {
      // A newer room state or connection owns playback once this operation is superseded.
      if (current()) throw error;
    } finally {
      if (current()) this.applying = false;
    }
  }
}
// The readiness a participant reports for waits. A usable clock estimate is required; a degraded
// one (uncertainty above 250 ms) only suspends small corrections, so high-latency participants
// can still release a wait and use explicit controls (DESIGN 6.2).
export function reportedReadiness(input: {
  pending: boolean;
  matched: boolean;
  estimate: Estimate | undefined;
  seeking: boolean;
  status: ReadinessStatus;
}): ReadinessStatus {
  if (input.pending) return 'loading';
  if (!input.matched) return 'mismatch';
  if (!input.estimate) return 'loading';
  // A streamed seek can wait for data before seeked. Keep that buffering signal
  // so the room can freeze its moving target and resume after data arrives.
  if (input.seeking && input.status !== 'buffering') return 'loading';
  return input.status;
}
