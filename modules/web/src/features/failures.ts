import { message, type Message } from '../i18n';
import { APIError, NetworkError, ResponseError } from '../transport/api';

// InputError marks values the user can correct before sending.
export class InputError extends Error {}

export interface Failure {
  text: Message;
  reload?: boolean;
  recheck?: boolean;
  field?: string;
}
export type FailureContext = 'rename' | 'create' | 'join' | 'other';

const input: Partial<Record<FailureContext, { text: Message; field: string }>> =
  {
    rename: {
      text: message('failure.rename'),
      field: 'display-name',
    },
    create: {
      text: message('failure.create'),
      field: 'room-name',
    },
    join: {
      text: message('failure.join'),
      field: 'join-code',
    },
  };
// Presentation mapping only: each failure class gets one distinct, actionable message.
export function describeFailure(
  reason: unknown,
  context: FailureContext = 'other',
): Failure {
  const correctable = input[context];
  if (
    correctable &&
    (reason instanceof InputError ||
      (reason instanceof APIError && reason.code === 'invalid_input'))
  )
    return correctable;
  // Unknown, replaced, and closed-room codes share one answer; the code field is still the fix.
  if (
    context === 'join' &&
    reason instanceof APIError &&
    reason.code === 'invalid_invitation'
  )
    return { text: reason.text, field: 'join-code' };
  if (reason instanceof APIError)
    return {
      text: reason.text,
      reload: reason.reload,
      recheck: ['busy', 'storage_unavailable'].includes(reason.code),
    };
  if (reason instanceof NetworkError)
    return { text: reason.text, recheck: true };
  return { text: new ResponseError().text, reload: true };
}
