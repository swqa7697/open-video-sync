import { t, type MessageKey } from '../i18n';
import type { Member, Snapshot } from '../transport/api';
import type { ReadinessStatus } from '../transport/protocol-values';

// Readable status text. Raw protocol codes stay in data-state attributes for tools.
export const readinessText: Record<ReadinessStatus, MessageKey> = {
  no_media: 'status.noMedia',
  loading: 'status.loading',
  ready: 'status.ready',
  buffering: 'status.buffering',
  gesture_required: 'status.gesture',
  mismatch: 'status.mismatch',
  access_denied: 'status.accessDenied',
  unsupported: 'status.unsupported',
  error: 'status.error',
};
export const phaseText: Record<Snapshot['playback']['phase'], MessageKey> = {
  empty: 'status.empty',
  paused: 'status.paused',
  waiting: 'status.waiting',
  playing: 'status.playing',
  ended: 'status.ended',
};
// Presence overrides readiness: an offline member's last report is not current.
export function memberState(member: Member, mediaGeneration: number): string {
  if (member.presence !== 'connected') return t('status.offline');
  const readiness = member.readiness;
  if (!readiness || readiness.mediaGeneration !== mediaGeneration)
    return t(readinessText.no_media);
  const note =
    readiness.capabilities.canPlay && !readiness.capabilities.canDetectBuffering
      ? t('status.noBufferDetection')
      : '';
  return t(readinessText[readiness.status]) + note;
}
export function settingsSummary(settings: Snapshot['settings']): string {
  return t('settings.summary', {
    everyoneCanControl: settings.everyoneCanControl
      ? t('settings.everyoneSummary')
      : t('settings.hostSummary'),
    everyoneCanSelectMedia: settings.everyoneCanSelectMedia
      ? t('settings.everyoneMediaSummary')
      : t('settings.hostMediaSummary'),
    waiting: settings.waitForAll
      ? t('settings.waitSummary')
      : t('settings.noWaitSummary'),
  });
}
