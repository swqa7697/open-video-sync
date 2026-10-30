import { afterEach, expect, test, vi } from 'vite-plus/test';
import { decodeInfo, parseIndex, parseSelection } from './media';
import { DanmakuRenderer, decodeComments } from './danmaku';
afterEach(() => vi.unstubAllGlobals());
test('selection resolves only canonical IDs and exact parts without forwarding pasted credentials', () => {
  expect(
    parseSelection(
      'https://www.bilibili.com/video/BV1hf4y1N75G?p=2&token=synthetic',
      1
    )
  ).toEqual({ bvid: 'BV1hf4y1N75G', part: 2 });
  expect(parseSelection('BV1hf4y1N75G', 3)).toEqual({
    bvid: 'BV1hf4y1N75G',
    part: 3,
  });
  for (const input of [
    'https://b23.tv/example',
    'https://www.bilibili.com.evil.invalid/video/BV1hf4y1N75G',
    'https://user:secret@www.bilibili.com/video/BV1hf4y1N75G',
    'https://www.bilibili.com/video/BV1hf4y1N75G?p=0',
  ])
    expect(() => parseSelection(input, 1)).toThrow();
});
test('SIDX decoding yields bounded seek ranges and rejects truncated, nested, and oversized fragments', () => {
  const data = new Uint8Array(44),
    v = new DataView(data.buffer);
  v.setUint32(0, 44);
  data.set(new TextEncoder().encode('sidx'), 4);
  v.setUint32(16, 1000);
  v.setUint16(30, 1);
  v.setUint32(32, 1024);
  v.setUint32(36, 5000);
  expect(parseIndex(data, 100)).toEqual([
    { offset: 144, length: 1024, time: 0, end: 5 },
  ]);
  expect(() => parseIndex(data.slice(0, 43), 100)).toThrow();
  for (const size of [0, 4 * 1024 * 1024 + 1, 0x80000400]) {
    v.setUint32(32, size);
    expect(() => parseIndex(data, 100)).toThrow();
  }
});
test('helper metadata and display comments reject foreign payload fields and script modes', () => {
  const comment = {
    time: 1,
    mode: 1,
    color: 0xffffff,
    text: '<script>synthetic</script>',
  };
  expect(decodeComments({ comments: [comment] }, 10)).toEqual([comment]);
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const video = document.createElement('video'),
    overlay = document.createElement('div');
  video.currentTime = 1.5;
  const renderer = new DanmakuRenderer(video, overlay);
  renderer.comments = decodeComments({ comments: [comment] }, 10);
  frame?.(0);
  expect(overlay.textContent).toBe(comment.text);
  expect(overlay.querySelector('script')).toBeNull();
  video.currentTime = 9;
  frame?.(100);
  expect(overlay.textContent).toBe('');
  renderer.dispose();

  expect(() =>
    decodeComments({ comments: [{ ...comment, mode: 8 }] }, 10)
  ).toThrow();
  expect(() =>
    decodeComments({ comments: [{ ...comment, cookie: 'synthetic' }] }, 10)
  ).toThrow();
  expect(() =>
    decodeInfo(
      { bvid: 'BV1hf4y1N75G', part: 1, signedURL: 'synthetic' },
      'BV1hf4y1N75G',
      1
    )
  ).toThrow();
});
