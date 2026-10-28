import { defineStore } from 'pinia';
import { ref } from 'vue';
import { checkReadiness } from '../transport/health';

export const useConnectionStore = defineStore('connection', () => {
  const status = ref<'checking' | 'ready' | 'unavailable'>('checking');

  async function refresh(signal: AbortSignal): Promise<void> {
    try {
      const ready = await checkReadiness(signal);
      if (!signal.aborted) status.value = ready ? 'ready' : 'unavailable';
    } catch {
      if (!signal.aborted) status.value = 'unavailable';
    }
  }

  return { status, checkReadiness: refresh };
});
