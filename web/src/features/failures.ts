import { APIError, NetworkError, ResponseError } from '../transport/api';

// InputError marks values the user can correct before sending.
export class InputError extends Error {}

export interface Failure {
  text: string;
  reload?: boolean;
  recheck?: boolean;
  field?: string;
}
export type FailureContext = 'rename' | 'create' | 'join' | 'other';

const input: Partial<Record<FailureContext, { text: string; field: string }>> = {
  rename: {
    text: 'Use up to 48 characters without line breaks or control characters.',
    field: 'display-name',
  },
  create: { text: 'Enter a room title of up to 120 characters.', field: 'room-name' },
  join: {
    text: 'Enter the 16-character invitation code, or open the full invitation link.',
    field: 'join-code',
  },
};
// Presentation mapping only: each failure class gets one distinct, actionable message.
export function describeFailure(reason: unknown, context: FailureContext = 'other'): Failure {
  const correctable = input[context];
  if (
    correctable &&
    (reason instanceof InputError ||
      (reason instanceof APIError && reason.code === 'invalid_input'))
  )
    return correctable;
  // Unknown, replaced, and closed-room codes share one answer; the code field is still the fix.
  if (context === 'join' && reason instanceof APIError && reason.code === 'invalid_invitation')
    return { text: reason.message, field: 'join-code' };
  if (reason instanceof APIError)
    return {
      text: reason.message,
      reload: reason.reload,
      recheck: ['busy', 'storage_unavailable'].includes(reason.code),
    };
  if (reason instanceof NetworkError) return { text: reason.message, recheck: true };
  return { text: new ResponseError().message, reload: true };
}
