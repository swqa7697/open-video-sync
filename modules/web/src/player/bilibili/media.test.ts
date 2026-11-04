import { afterEach, expect, onTestFinished, test, vi } from 'vite-plus/test';

import { DanmakuRenderer, decodeComments, type Comment } from './danmaku';
import {
  decodeInfo,
  decodePlaylist,
  decodePreview,
  parseIndex,
  parseSelection,
} from './media';

afterEach(() => vi.unstubAllGlobals());

function commentRenderer(reduced = false) {
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal('matchMedia', () => ({ matches: reduced }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  const cancel = vi.fn();
  vi.stubGlobal('cancelAnimationFrame', cancel);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    measureText: (text: string) => ({ width: Array.from(text).length * 10 }),
  } as CanvasRenderingContext2D);
  const video = document.createElement('video'),
    overlay = document.createElement('div'),
    stage = document.createElement('div');
  stage.append(overlay);
  Object.defineProperty(stage, 'clientHeight', { value: 400 });
  Object.defineProperties(overlay, {
    clientWidth: { value: 800, configurable: true },
    // The overlay viewport excludes the player's controls.
    clientHeight: { value: 304, configurable: true },
  });
  const renderer = new DanmakuRenderer(video, overlay);
  onTestFinished(() => renderer.dispose());
  return {
    renderer,
    overlay,
    cancel,
    tick: (time: number) => {
      video.currentTime = time;
      frame?.(time * 1000);
    },
  };
}
const xPosition = (node: HTMLElement) =>
  Number(node.style.transform.match(/translate3d\(([-\d.]+)px/)?.[1]);

test('dense comments keep their lanes and never overlap or backfill crowded timestamps', () => {
  const { renderer, overlay, tick } = commentRenderer();
  renderer.density = 40;
  const comments: Comment[] = [
    { time: 0, mode: 5, color: 0xffffff, text: 'First pinned' },
    { time: 0.5, mode: 1, color: 0xffffff, text: 'Short' },
    { time: 0.5, mode: 1, color: 0xffffff, text: '长'.repeat(80) },
    { time: 0.6, mode: 4, color: 0xffffff, text: 'Bottom pinned' },
    ...Array.from({ length: 100 }, (_, i) => ({
      time: 0.7 + i * 0.005,
      mode: 1,
      color: 0xffffff,
      text: `Crowded ${i}`,
    })),
  ];
  renderer.comments = comments;
  tick(0);
  tick(0.5);
  const short = [...overlay.children].find(
    (node) => node.textContent === 'Short',
  ) as HTMLSpanElement;
  const lane = short.style.top;
  let previous = new Set<Element>();
  for (let time = 0.6; time <= 8; time += 0.1) {
    tick(time);
    const nodes = [...overlay.children] as HTMLSpanElement[];
    expect(nodes.length).toBeLessThanOrEqual(40);
    for (const [i, node] of nodes.entries()) {
      const sameLane = nodes
        .slice(i + 1)
        .filter((other) => other.style.top === node.style.top);
      for (const other of sameLane) {
        const left = xPosition(node),
          right = xPosition(other);
        const first = left < right ? node : other;
        expect(Math.abs(left - right)).toBeGreaterThanOrEqual(
          Array.from(first.textContent!).length * 10 + 2 + 24 - 0.001,
        );
      }
    }
    // There are no new timestamps after 1.2 s. A dropped comment stays dropped.
    if (time > 1.4)
      for (const node of nodes) expect(previous.has(node)).toBe(true);
    previous = new Set(nodes);
    expect(short.parentElement).toBe(overlay);
    expect(short.style.top).toBe(lane);
  }
  expect(overlay.textContent).not.toContain('First pinned');
  expect(overlay.textContent).not.toContain('Bottom pinned');
  renderer.area = 0.25;
  renderer.comments = comments.slice(0, 4).map((comment) => ({
    ...comment,
    time: 8,
  }));
  tick(8);
  const top = overlay.children[0] as HTMLSpanElement,
    bottom = [...overlay.children].find(
      (node) => node.textContent === 'Bottom pinned',
    ) as HTMLSpanElement,
    topPosition = top.style.top,
    bottomPosition = bottom.style.top;
  for (const area of [0.5, 0.25, 1]) {
    renderer.area = area;
    tick(8);
    expect(top.parentElement).toBe(overlay);
    expect(bottom.parentElement).toBe(overlay);
    expect(top.style.top).toBe(topPosition);
    expect(bottom.style.top).toBe(bottomPosition);
    for (const node of [...overlay.children] as HTMLSpanElement[]) {
      if (node === top || node === bottom) continue;
      expect(Number.parseFloat(node.style.top) + 30).toBeLessThanOrEqual(
        Math.min(304, 400 * area),
      );
    }
  }
  renderer.fontSize = 32;
  Object.defineProperty(overlay, 'clientHeight', { value: 154 });
  tick(8);
  const tops = [...overlay.children].map((node) =>
    Number.parseFloat((node as HTMLElement).style.top),
  );
  expect(tops.every((top) => top >= 12 && top + 48 <= 154)).toBe(true);
});

test('long and short comments share a lifetime while speed changes preserve position and clock ownership', () => {
  const { renderer, overlay, tick, cancel } = commentRenderer();
  renderer.comments = [
    { time: 0, mode: 1, color: 0xffffff, text: 'Short' },
    { time: 0, mode: 1, color: 0xffffff, text: '长'.repeat(80) },
  ];
  tick(0);
  const short = overlay.children[0] as HTMLSpanElement,
    long = overlay.children[1] as HTMLSpanElement;
  tick(0.5);
  expect(xPosition(long)).toBeLessThan(xPosition(short));
  const before = xPosition(short);
  tick(1);
  const normalStep = before - xPosition(short),
    original = short.style.transform;
  renderer.speed = 0.5;
  tick(1);
  expect(short.style.transform).toBe(original);
  tick(1.5);
  expect(Number.parseFloat(short.style.top)).toBe(12);
  expect(before - normalStep - xPosition(short)).toBeCloseTo(normalStep / 2);
  const paused = short.style.transform;
  tick(1.5);
  expect(short.style.transform).toBe(paused);
  renderer.speed = 1.5;
  const slower = xPosition(short);
  tick(2);
  expect(slower - xPosition(short)).toBeCloseTo(normalStep * 1.5);
  renderer.speed = 1;
  // A delayed animation frame must not rebuild visible comments on tab return.
  tick(4);
  expect(short.parentElement).toBe(overlay);
  expect(long.parentElement).toBe(overlay);
  for (let time = 4.5; time <= 9.5; time += 0.5) tick(time);
  expect(short.parentElement).toBe(overlay);
  expect(long.parentElement).toBe(overlay);
  expect(xPosition(long) + 802).toBeGreaterThan(0);
  tick(10.01);
  expect(short.parentElement).toBeNull();
  expect(long.parentElement).toBeNull();
  tick(2);
  expect(overlay.children).toHaveLength(2);
  tick(500);
  expect(overlay.children).toHaveLength(0);
  renderer.comments = [
    { time: 500, mode: 5, color: 0xffffff, text: 'New media' },
  ];
  tick(500);
  expect(overlay.textContent).toBe('New media');
  renderer.visible = false;
  tick(500);
  expect(overlay.children).toHaveLength(0);
  renderer.dispose();
  expect(cancel).toHaveBeenCalled();
  expect(renderer.comments).toHaveLength(0);
});

test('reduced motion keeps comments stationary and expires them without overlapping pinned text', () => {
  const { renderer, overlay, tick } = commentRenderer(true);
  renderer.fontSize = 32;
  renderer.comments = [1, 4, 5].map((mode) => ({
    time: 0,
    mode,
    color: 0xffffff,
    text: `Mode ${mode}`,
  }));
  tick(1);
  const nodes = [...overlay.children] as HTMLSpanElement[],
    transforms = nodes.map((node) => node.style.transform);
  expect(new Set(nodes.map((node) => node.style.top)).size).toBe(3);
  tick(2);
  expect(nodes.map((node) => node.style.transform)).toEqual(transforms);
  const tops = nodes.map((node) => node.style.top);
  for (const area of [0.5, 0.25, 1]) {
    renderer.area = area;
    tick(2);
    expect([...overlay.children]).toEqual(nodes);
    expect(nodes.map((node) => node.style.top)).toEqual(tops);
    expect(nodes.map((node) => node.style.transform)).toEqual(transforms);
  }
  tick(7);
  expect(overlay.children).toHaveLength(0);
});
test('selection resolves only canonical IDs and exact parts without forwarding pasted credentials', () => {
  expect(
    parseSelection(
      'https://www.bilibili.com/video/BV1TESTaaaaa?p=2&token=synthetic',
      1,
    ),
  ).toEqual({ bvid: 'BV1TESTaaaaa', part: 2 });
  expect(parseSelection('BV1TESTaaaaa', 3)).toEqual({
    bvid: 'BV1TESTaaaaa',
    part: 3,
  });
  for (const input of [
    'ss9000000000022',
    'https://www.bilibili.com/bangumi/play/ss9000000000022?from=search',
    'https://www.bilibili.com/bangumi/play/ss9000000000021',
  ])
    expect(parseSelection(input, 2)).toEqual({
      seasonId: input.includes('9000000000021')
        ? '9000000000021'
        : '9000000000022',
      part: 1,
    });
  expect(parseSelection('ep9000000000011', 1)).toEqual({
    episodeId: '9000000000011',
    part: 1,
  });
  expect(
    parseSelection('https://www.bilibili.com/bangumi/play/ep9000000000011', 1),
  ).toEqual({ episodeId: '9000000000011', part: 1 });
  for (const input of [
    'https://b23.tv/example',
    'https://www.bilibili.com.evil.invalid/video/BV1TESTaaaaa',
    'https://user:secret@www.bilibili.com/video/BV1TESTaaaaa',
    'https://www.bilibili.com/video/BV1TESTaaaaa?p=0',
    'https://www.bilibili.com.evil.invalid/bangumi/play/ss9000000000021',
    'https://user:secret@www.bilibili.com/bangumi/play/ep9000000000011',
    'https://www.bilibili.com/bangumi/play/ss0',
    'ep01',
    'ss-1',
  ])
    expect(() => parseSelection(input, 1)).toThrow();
});
test('SIDX decoding accepts the full reference size and rejects truncated, nested, and unsafe indexes', () => {
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
  // Premium AVC qualities can exceed 4 MiB per fragment without changing codec.
  for (const length of [64 * 1024 * 1024 + 1, 0x7fffffff]) {
    v.setUint32(32, length);
    expect(parseIndex(data, 100)).toEqual([
      { offset: 144, length, time: 0, end: 5 },
    ]);
  }
  expect(() => parseIndex(data.slice(0, 43), 100)).toThrow();
  expect(() => parseIndex(data, -1)).toThrow();
  expect(() => parseIndex(data, Number.MAX_SAFE_INTEGER)).toThrow();
  for (const size of [0, 0x80000400]) {
    v.setUint32(32, size);
    expect(() => parseIndex(data, 100)).toThrow();
  }
});
test('helper metadata and display comments reject foreign payload fields and script modes', () => {
  const first = { bvid: 'BV1TESTaaaaa', part: 1, title: 'First' },
    second = {
      bvid: 'BV1TESTaaaab',
      part: 1,
      title: '<script>Second</script>',
    },
    playlist = { title: 'Collection', episodes: [first, second] };
  const preview = {
    bvid: first.bvid,
    cid: '1',
    part: 1,
    duration: 10,
    title: 'First',
    parts: 1,
    quality: 32,
    qualities: [32],
    tracks: [
      {
        id: 32,
        codec: 'avc1.64001E',
        mime: 'video/mp4',
        init: [0, 31],
        index: [32, 63],
      },
      {
        id: 30216,
        codec: 'mp4a.40.2',
        mime: 'audio/mp4',
        init: [0, 31],
        index: [32, 63],
      },
    ],
  };
  expect(decodePreview(preview, first)).toEqual(preview);
  const statistics = {
    ...preview,
    tracks: [
      { ...preview.tracks[0], bitrate: 2183000, frameRate: 60000 / 1001 },
      preview.tracks[1],
    ],
  };
  expect(decodePreview(statistics, first)).toEqual(statistics);
  for (const fields of [
    { bitrate: -1 },
    { bitrate: 1073741825 },
    { bitrate: '2183000' },
    { frameRate: NaN },
    { frameRate: 0 },
    { frameRate: 1001 },
    { host: 'credential.invalid' },
  ])
    expect(() =>
      decodePreview(
        {
          ...preview,
          tracks: [{ ...preview.tracks[0], ...fields }, preview.tracks[1]],
        },
        first,
      ),
    ).toThrow();
  const bangumi = {
    ...preview,
    episodeId: '9000000000011',
    playlist: {
      ...playlist,
      episodes: [
        { ...first, episodeId: '9000000000011' },
        { ...second, episodeId: '9000000000012' },
      ],
    },
  };
  expect(
    decodePreview(bangumi, { seasonId: '9000000000021', part: 1 }),
  ).toEqual(bangumi);
  expect(
    decodePreview(bangumi, { episodeId: '9000000000011', part: 1 }),
  ).toEqual(bangumi);
  expect(
    decodeInfo(
      { ...bangumi, handle: 'h1-1234' },
      first.bvid,
      1,
      '9000000000011',
    ).episodeId,
  ).toBe('9000000000011');
  expect(() =>
    decodePreview(preview, { seasonId: '9000000000021', part: 1 }),
  ).toThrow();
  expect(() =>
    decodePreview(bangumi, { episodeId: '9000000000012', part: 1 }),
  ).toThrow();
  expect(() =>
    decodePreview(
      { ...bangumi, playlist },
      { episodeId: '9000000000011', part: 1 },
    ),
  ).toThrow();
  expect(decodeInfo({ ...preview, handle: 'h1-1234' }, first.bvid, 1)).toEqual({
    ...preview,
    handle: 'h1-1234',
  });
  for (const codec of [
    'av01.0.08M.08',
    'av01.0.08M.10.0.110.01.01.01.0',
    'hvc1.1.6.L120.90',
    'hev1.1.6.L120.90',
    'avc3.64001E',
  ]) {
    const candidate = {
      ...preview,
      tracks: [{ ...preview.tracks[0], codec }, preview.tracks[1]],
    };
    expect(decodePreview(candidate, first)).toEqual(candidate);
  }
  for (const codec of [
    'vp09.00.10.08',
    'av01',
    'hvc1.',
    'avc1..64001E',
    'av01.0.08M.08"; injected="x',
    `hvc1.${'1'.repeat(60)}`,
  ]) {
    expect(() =>
      decodePreview(
        {
          ...preview,
          tracks: [{ ...preview.tracks[0], codec }, preview.tracks[1]],
        },
        first,
      ),
    ).toThrow();
  }
  for (const invalid of [
    { ...preview, handle: 'h1-1234' },
    { ...preview, signedURL: 'synthetic' },
    { ...preview, cid: '0' },
    { ...preview, duration: 0 },
    { ...preview, part: 2 },
  ])
    expect(() => decodePreview(invalid, first)).toThrow();
  expect(decodePlaylist(playlist, first.bvid, 1)).toEqual(playlist);
  for (const episodes of [
    [first, first],
    [first, { ...second, signedURL: 'synthetic' }],
    [first, { ...second, part: 0 }],
    [first, { ...second, bvid: 'https://example.invalid' }],
    [first, { ...second, title: 'x'.repeat(161) }],
    Array(501).fill(first),
  ])
    expect(() =>
      decodePlaylist({ ...playlist, episodes }, first.bvid, 1),
    ).toThrow();
  expect(() => decodePlaylist(playlist, first.bvid, 2)).toThrow();
  const comment = {
    time: 1,
    mode: 1,
    color: 0xffffff,
    text: '<script>synthetic</script>',
  };
  expect(decodeComments({ comments: [comment] }, 10)).toEqual([comment]);
  const { renderer, overlay, tick } = commentRenderer();
  renderer.comments = decodeComments({ comments: [comment] }, 10);
  tick(1.5);
  expect(overlay.textContent).toBe(comment.text);
  expect(overlay.querySelector('script')).toBeNull();
  tick(30);
  expect(overlay.textContent).toBe('');
  renderer.dispose();

  expect(() =>
    decodeComments({ comments: [{ ...comment, mode: 8 }] }, 10),
  ).toThrow();
  expect(() =>
    decodeComments({ comments: [{ ...comment, cookie: 'synthetic' }] }, 10),
  ).toThrow();
  expect(() =>
    decodeInfo(
      { bvid: 'BV1TESTaaaaa', part: 1, signedURL: 'synthetic' },
      'BV1TESTaaaaa',
      1,
    ),
  ).toThrow();
});
