import { defineStore } from 'pinia';
import { ref, watch } from 'vue';

import { errorMessage, message, type Message } from '../i18n';
import { request } from '../transport/api';
import {
  decodeWatchHistory,
  type HistoryEntry,
  type HistoryVideo,
} from '../transport/history';
import { useIdentityStore } from './identity';

// Serialize history operations so an older list response cannot undo a newer mutation.
export const useHistoryStore = defineStore('history', () => {
  const identity = useIdentityStore();
  const entries = ref<HistoryEntry[]>([]);
  const recordingEnabled = ref(true);
  const loading = ref(false);
  const saving = ref(false);
  const error = ref<Message | ''>('');
  let controller = new AbortController();
  let generation = 0;
  let queued = Promise.resolve();
  let pendingReads = 0;
  let pendingWrites = 0;
  watch(
    () => identity.session?.identity.identityId,
    () => {
      controller.abort();
      controller = new AbortController();
      generation++;
      queued = Promise.resolve();
      pendingReads = pendingWrites = 0;
      entries.value = [];
      recordingEnabled.value = true;
      loading.value = saving.value = false;
      error.value = '';
    },
    { flush: 'sync' },
  );
  function perform(
    method: string,
    path = '',
    payload?: unknown,
    quiet = false,
  ): Promise<void> {
    if (!identity.session || (quiet && pendingWrites >= 8))
      return Promise.resolve();
    if (pendingReads + pendingWrites >= 16) {
      if (!quiet) error.value = message('history.failed');
      return Promise.resolve();
    }
    const version = generation;
    const signal = controller.signal;
    const csrf = identity.session.csrfToken;
    const writing = method !== 'GET';
    if (writing) saving.value = ++pendingWrites > 0;
    else loading.value = ++pendingReads > 0;
    const operation = queued.then(async () => {
      if (signal.aborted || version !== generation) return;
      if (!quiet) error.value = '';
      try {
        const result = decodeWatchHistory(
          // One hundred bounded titles can exceed the ordinary API response limit.
          await request(
            `/me/history${path}`,
            method,
            csrf,
            payload,
            signal,
            undefined,
            false,
            256 * 1024,
          ),
        );
        if (signal.aborted || version !== generation) return;
        entries.value = result.entries;
        recordingEnabled.value = result.recordingEnabled;
      } catch (reason) {
        if (!quiet && !signal.aborted && version === generation)
          error.value = errorMessage(reason, 'history.failed');
      } finally {
        if (version === generation) {
          if (writing) saving.value = --pendingWrites > 0;
          else loading.value = --pendingReads > 0;
        }
      }
    });
    queued = operation;
    return operation;
  }
  return {
    entries,
    recordingEnabled,
    loading,
    saving,
    error,
    load: () => perform('GET'),
    record: (video: HistoryVideo) => perform('POST', '', video, true),
    remove: (entryId: string) => perform('DELETE', `/${entryId}`, {}),
    clear: () => perform('DELETE', '', {}),
    setRecording: (value: boolean) =>
      perform('PATCH', '/preferences', { recordingEnabled: value }),
  };
});
