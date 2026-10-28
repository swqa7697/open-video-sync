import { afterEach, expect, test, vi } from 'vite-plus/test';
import { LocalAdapter } from './local';
afterEach(() => vi.unstubAllGlobals());
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
