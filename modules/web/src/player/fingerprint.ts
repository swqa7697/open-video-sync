export function localFingerprint(
  file: File,
  roomId: string,
  signal: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Cancelled', 'AbortError'));
      return;
    }
    const worker = new Worker(
      new URL('./fingerprint.worker.ts', import.meta.url),
      {
        type: 'module',
      }
    );
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate();
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Local matching timed out. Select the file again.'));
    }, 30000);
    signal.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<unknown>) => {
      cleanup();
      if (typeof event.data === 'string' && /^[a-f0-9]{64}$/.test(event.data))
        resolve(event.data);
      else reject(new Error('Local matching failed. Select the file again.'));
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error('Local matching failed. Select the file again.'));
    };
    worker.postMessage({ file, roomId });
  });
}
