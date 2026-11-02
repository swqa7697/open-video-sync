import { fingerprint } from './fingerprint-core';

self.onmessage = async (event: MessageEvent<unknown>) => {
  const value = event.data;
  if (
    !value ||
    typeof value !== 'object' ||
    !('file' in value) ||
    !(value.file instanceof File) ||
    !('roomId' in value) ||
    typeof value.roomId !== 'string'
  ) {
    self.postMessage(null);
    return;
  }
  try {
    self.postMessage(await fingerprint(value.file, value.roomId));
  } catch {
    self.postMessage(null);
  }
};
