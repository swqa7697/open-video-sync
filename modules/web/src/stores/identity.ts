import { defineStore } from 'pinia';
import { ref } from 'vue';

import { InputError } from '../features/failures';
import { decodeSession, request, type Session } from '../transport/api';
import { decodeProfilePatch } from '../transport/contracts';

// Credentials stay in memory; the bearer cookie remains inaccessible to JavaScript.
export const useIdentityStore = defineStore('identity', () => {
  const session = ref<Session>();
  async function bootstrap(signal: AbortSignal): Promise<void> {
    const value = decodeSession(
      await request('/session', 'POST', '', {}, signal),
    );
    if (!signal.aborted) session.value = value;
  }
  async function rename(
    displayName: string,
    signal: AbortSignal,
  ): Promise<void> {
    let patch: ReturnType<typeof decodeProfilePatch>;
    try {
      patch = decodeProfilePatch({ displayName });
    } catch {
      throw new InputError('invalid display name');
    }
    const value = decodeSession(
      await request(
        '/me',
        'PATCH',
        session.value?.csrfToken ?? '',
        patch,
        signal,
      ),
    );
    if (!signal.aborted) session.value = value;
  }
  async function forget(signal: AbortSignal): Promise<void> {
    await request(
      '/session',
      'DELETE',
      session.value?.csrfToken ?? '',
      {},
      signal,
    );
    session.value = undefined;
  }
  return { session, bootstrap, rename, forget };
});
