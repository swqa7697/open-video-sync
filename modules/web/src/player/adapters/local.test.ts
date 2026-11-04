import { afterEach, expect, test, vi } from 'vite-plus/test';

import { LocalAdapter } from './local';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

test('local statistics report the playhead buffer and label observed frame rate as an estimate', () => {
  const video = document.createElement('video');
  video.pause = () => {};
  video.load = () => {};
  let frames = 30;
  Object.defineProperties(video, {
    videoWidth: { value: 1920 },
    videoHeight: { value: 1080 },
    paused: { value: false },
    buffered: {
      value: {
        length: 2,
        start: (index: number) => [0, 8][index],
        end: (index: number) => [4, 12][index],
      },
    },
  });
  video.getVideoPlaybackQuality = () => ({
    creationTime: 0,
    totalVideoFrames: frames + 2,
    droppedVideoFrames: 2,
    corruptedVideoFrames: 0,
  });
  const adapter = new LocalAdapter(video);
  expect(adapter.getStatistics()).toEqual({
    width: 1920,
    height: 1080,
    bufferAheadSeconds: 4,
  });
  video.currentTime = 1;
  frames = 60;
  expect(adapter.getStatistics()).toMatchObject({
    frameRate: 30,
    frameRateEstimated: true,
    bufferAheadSeconds: 3,
  });
  video.currentTime = 6;
  video.dispatchEvent(new Event('seeking'));
  expect(adapter.getStatistics().bufferAheadSeconds).toBe(0);
  video.currentTime = 10;
  expect(adapter.getStatistics().bufferAheadSeconds).toBe(2);
  adapter.dispose();
  expect(() => adapter.getStatistics()).toThrow('Disposed');
});

test('a streamed seek waits for data and a newer seek or disposal cancels the old wait', async () => {
  vi.useFakeTimers();
  const video = document.createElement('video');
  video.pause = () => {};
  video.load = () => {};
  const adapter = new LocalAdapter(video);
  const outcomes: string[] = [];
  const seek = (position: number) =>
    adapter.seek(position).then(
      () => outcomes.push('seeked'),
      (error: Error) => outcomes.push(error.name),
    );
  try {
    const first = seek(60000);
    // Streaming can continue to supply bounded chunks while the target lacks a full fragment.
    await vi.advanceTimersByTimeAsync(16000);
    expect(outcomes).toEqual([]);
    const second = seek(70000);
    await first;
    expect(outcomes).toEqual(['AbortError']);
    video.dispatchEvent(new Event('seeked'));
    await second;
    expect(outcomes).toEqual(['AbortError', 'seeked']);
    const failed = seek(75000);
    video.dispatchEvent(new Event('error'));
    await failed;
    expect(outcomes).toEqual(['AbortError', 'seeked', 'Error']);
    const last = seek(80000);
    adapter.dispose();
    await last;
    expect(outcomes).toEqual(['AbortError', 'seeked', 'Error', 'AbortError']);
  } finally {
    adapter.dispose();
  }
});
test('a disposed adapter cannot pause the replacement when an old play promise completes', async () => {
  const nativeURL = URL;
  let number = 0;
  vi.stubGlobal(
    'URL',
    class extends nativeURL {
      static createObjectURL(): string {
        return `blob:fixture-${++number}`;
      }
      static revokeObjectURL(): void {}
    },
  );
  const video = document.createElement('video');
  let paused = true;
  Object.defineProperties(video, {
    duration: { value: 10 },
    videoWidth: { value: 640 },
    paused: { get: () => paused },
  });
  video.pause = () => {
    paused = true;
  };
  video.load = () => {};
  let finish: () => void = () => {};
  video.play = () =>
    new Promise<void>((resolve) => {
      finish = resolve;
    });
  const load = async (adapter: LocalAdapter) => {
    const promise = adapter.load(
      new File(['synthetic'], 'private.webm'),
      new AbortController().signal,
    );
    video.dispatchEvent(new Event('loadeddata'));
    await promise;
  };
  const first = new LocalAdapter(video);
  await load(first);
  const pending = first.play();
  first.dispose();
  const replacement = new LocalAdapter(video);
  await load(replacement);
  video.play = async () => {
    paused = false;
  };
  await replacement.play();
  const replacementSource = video.src;
  finish();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await first.pause();
  expect(video.paused).toBe(false);
  expect(video.src).toBe(replacementSource);
  replacement.dispose();
  expect(video.paused).toBe(true);
  expect(video.hasAttribute('src')).toBe(false);
});
test('a stalled fetch with playable data is not buffering; waiting is until playable again', async () => {
  const nativeURL = URL;
  vi.stubGlobal(
    'URL',
    class extends nativeURL {
      static createObjectURL(): string {
        return 'blob:fixture-buffering';
      }
      static revokeObjectURL(): void {}
    },
  );
  const video = document.createElement('video');
  let readyState = 4;
  Object.defineProperties(video, {
    duration: { value: 10 },
    videoWidth: { value: 640 },
    readyState: { get: () => readyState },
  });
  video.load = () => {};
  const adapter = new LocalAdapter(video);
  const loading = adapter.load(
    new File(['synthetic'], 'private.webm'),
    new AbortController().signal,
  );
  video.dispatchEvent(new Event('loadeddata'));
  await loading;
  // Firefox fires stalled for MediaSource when appends pause; buffered data is still playable.
  video.dispatchEvent(new Event('stalled'));
  expect(adapter.getState().status).toBe('ready');
  readyState = 2;
  video.dispatchEvent(new Event('waiting'));
  expect(adapter.getState().status).toBe('buffering');
  // waiting holds buffering after data returns until a playable event arrives.
  readyState = 4;
  expect(adapter.getState().status).toBe('buffering');
  video.dispatchEvent(new Event('canplay'));
  expect(adapter.getState().status).toBe('ready');
  adapter.dispose();
});
test.each([
  ['AbortError', 'ready'],
  ['NotSupportedError', 'error'],
] as const)(
  'a play rejection with %s leaves the status %s',
  async (name, status) => {
    const nativeURL = URL;
    vi.stubGlobal(
      'URL',
      class extends nativeURL {
        static createObjectURL(): string {
          return 'blob:fixture-rejection';
        }
        static revokeObjectURL(): void {}
      },
    );
    const video = document.createElement('video');
    Object.defineProperties(video, {
      duration: { value: 10 },
      videoWidth: { value: 640 },
      readyState: { value: 4 },
    });
    video.load = () => {};
    let reject: (error: DOMException) => void = () => {};
    video.play = () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      });
    // As in browsers, a pause cancels a pending play before playback starts.
    video.pause = () => reject(new DOMException('Interrupted', 'AbortError'));
    const adapter = new LocalAdapter(video);
    const loading = adapter.load(
      new File(['synthetic'], 'private.webm'),
      new AbortController().signal,
    );
    video.dispatchEvent(new Event('loadeddata'));
    await loading;
    const playing = adapter.play();
    if (name === 'AbortError') await adapter.pause();
    else reject(new DOMException('Unsupported source', name));
    // Callers still learn that playback did not start.
    await expect(playing).rejects.toMatchObject({ name });
    expect(adapter.getState().status).toBe(status);
    adapter.dispose();
  },
);
