import type { Member, Snapshot } from '../transport/api';
import type { ReadinessStatus } from '../transport/protocol-values';

// Readable status text. Raw protocol codes stay in data-state attributes for tools.
export const readinessText: Record<ReadinessStatus, string> = {
  no_media: 'No video selected',
  loading: 'Loading video…',
  ready: 'Ready',
  buffering: 'Buffering…',
  gesture_required: 'Needs Enable playback',
  mismatch: 'Different video from the room',
  access_denied: 'Platform access unavailable',
  unsupported: 'Not playable in this browser',
  error: 'Video failed to load',
};
export const phaseText: Record<Snapshot['playback']['phase'], string> = {
  empty: 'No video',
  paused: 'Paused',
  waiting: 'Waiting for participants',
  playing: 'Playing',
  ended: 'Ended',
};
// Presence overrides readiness: an offline member's last report is not current.
export function memberState(member: Member, mediaGeneration: number): string {
  if (member.presence !== 'connected') return 'Offline';
  const readiness = member.readiness;
  if (!readiness || readiness.mediaGeneration !== mediaGeneration) return readinessText.no_media;
  const note =
    readiness.capabilities.canPlay && !readiness.capabilities.canDetectBuffering
      ? ' · buffering not detected'
      : '';
  return readinessText[readiness.status] + note;
}
export function settingsSummary(settings: Snapshot['settings']): string {
  return `${settings.controllers === 'host' ? 'Host controls playback' : 'Everyone controls playback'} · ${settings.waitForAll ? 'Waits for everyone' : 'Does not wait'}`;
}
