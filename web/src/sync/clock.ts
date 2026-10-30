export interface Estimate {
  offsetMs: number;
  uncertaintyMs: number;
}
interface Sample {
  offset: number;
  rtt: number;
  at: number;
}
export class ClockEstimator {
  private samples: Sample[] = [];
  reset(): void {
    this.samples = [];
  }
  add(c0: number, s1: number, s2: number, c3: number): boolean {
    if (![c0, s1, s2, c3].every((n) => Number.isFinite(n) && n >= 0) || c3 < c0 || s2 < s1)
      return false;
    const rtt = c3 - c0 - (s2 - s1);
    if (rtt < 0 || rtt > 2000) return false;
    this.samples.push({ offset: (s1 - c0 + (s2 - c3)) / 2, rtt, at: c3 });
    this.samples = this.samples.slice(-20);
    return true;
  }
  estimate(now: number): Estimate | undefined {
    this.samples = this.samples.filter((s) => now - s.at <= 30000);
    // A rounded-up receive can be up to 1 ms ahead of this sampling tick.
    // Keep it for the next estimate rather than discarding calibration.
    const usable = this.samples.filter((s) => s.at <= now);
    if (usable.length < 3) return undefined;
    const subset = [...usable].sort((a, b) => a.rtt - b.rtt).slice(0, 5),
      offsets = subset.map((s) => s.offset).sort((a, b) => a - b);
    const mid = Math.floor(offsets.length / 2),
      offsetMs = offsets.length % 2 ? offsets[mid]! : (offsets[mid - 1]! + offsets[mid]!) / 2;
    return {
      offsetMs,
      uncertaintyMs:
        Math.max(...subset.map((s) => s.rtt / 2)) + offsets[offsets.length - 1]! - offsets[0]!,
    };
  }
}
export type SyncQuality = 'calibrating' | 'calibrated' | 'degraded';
export interface SyncQualityState {
  quality: SyncQuality;
  degradedSince: number | undefined;
}
// Display state only. Improvements show at once; degradation must persist for three seconds,
// so a brief uncertainty spike does not toggle the announced label every sample.
export function nextSyncQuality(
  previous: SyncQualityState,
  estimate: Estimate | undefined,
  now: number,
): SyncQualityState {
  if (!estimate) return { quality: 'calibrating', degradedSince: undefined };
  if (estimate.uncertaintyMs <= 250) return { quality: 'calibrated', degradedSince: undefined };
  const since = previous.degradedSince ?? now;
  return { quality: now - since >= 3000 ? 'degraded' : previous.quality, degradedSince: since };
}
