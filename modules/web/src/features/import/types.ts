import type { Message } from '../../i18n';

export interface ImportOutcome {
  status: 'accepted' | 'unavailable' | 'uncertain' | 'stale' | 'failed';
  message?: Message;
}
