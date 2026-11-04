export interface PlayerPreferences {
  volume: number;
  muted: boolean;
  quality?: number;
  danmakuVisible: boolean;
  danmakuDensity: number;
  danmakuSize: number;
  danmakuSpeed: number;
  danmakuArea: number;
}

export function readPlayerPreferences(): PlayerPreferences {
  const defaults = {
    volume: 0.5,
    muted: false,
    danmakuVisible: true,
    danmakuDensity: 20,
    danmakuSize: 20,
    danmakuSpeed: 1,
    danmakuArea: 0.5,
  };
  try {
    const saved: unknown = JSON.parse(
      localStorage.getItem('ovs.player') ?? 'null',
    );
    if (!saved || typeof saved !== 'object') return defaults;
    const value = saved as Record<string, unknown>;
    return {
      volume:
        typeof value.volume === 'number' &&
        Number.isFinite(value.volume) &&
        value.volume >= 0 &&
        value.volume <= 1
          ? value.volume
          : defaults.volume,
      muted: typeof value.muted === 'boolean' ? value.muted : defaults.muted,
      danmakuVisible:
        typeof value.danmakuVisible === 'boolean'
          ? value.danmakuVisible
          : defaults.danmakuVisible,
      danmakuDensity:
        typeof value.danmakuDensity === 'number' &&
        Number.isInteger(value.danmakuDensity) &&
        value.danmakuDensity >= 1 &&
        value.danmakuDensity <= 40
          ? value.danmakuDensity
          : defaults.danmakuDensity,
      danmakuSize:
        typeof value.danmakuSize === 'number' &&
        Number.isInteger(value.danmakuSize) &&
        value.danmakuSize >= 16 &&
        value.danmakuSize <= 32
          ? value.danmakuSize
          : defaults.danmakuSize,
      danmakuSpeed:
        typeof value.danmakuSpeed === 'number' &&
        Number.isFinite(value.danmakuSpeed) &&
        value.danmakuSpeed >= 0.5 &&
        value.danmakuSpeed <= 1.5
          ? value.danmakuSpeed
          : defaults.danmakuSpeed,
      danmakuArea:
        value.danmakuArea === 1 ||
        value.danmakuArea === 0.5 ||
        value.danmakuArea === 0.25
          ? value.danmakuArea
          : defaults.danmakuArea,
      ...(typeof value.quality === 'number' &&
      Number.isSafeInteger(value.quality) &&
      value.quality >= 1 &&
      value.quality <= 127
        ? { quality: value.quality }
        : {}),
    };
  } catch {
    return defaults;
  }
}

export function savePlayerPreferences(value: PlayerPreferences): void {
  try {
    localStorage.setItem('ovs.player', JSON.stringify(value));
  } catch {
    // Browser-local controls remain usable when storage is unavailable.
  }
}
