import { defineStore } from 'pinia';
import { ref } from 'vue';

import { checkReadiness, type Readiness } from '../transport/health';

// Readiness reads in-memory server flags only. Callers re-check after failures and reconnects.
export const useConnectionStore = defineStore('connection', () => {
  const status = ref<'checking' | Readiness>('checking');
  let inflight: Promise<void> | undefined;

  function refresh(signal: AbortSignal): Promise<void> {
    inflight ??= checkReadiness(signal)
      .then((value) => {
        if (!signal.aborted) status.value = value;
      })
      .catch(() => {})
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  return { status, checkReadiness: refresh };
});
