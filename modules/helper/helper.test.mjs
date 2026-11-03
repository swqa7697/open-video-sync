// Fault fixtures complement, and do not replace, live Tampermonkey experiments.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { parseBridgeJSON } from './bridge-json.js';

const release = JSON.parse(
  await readFile(new URL('./dist/release.json', import.meta.url), 'utf8'),
);
const code = (
  await readFile(new URL('./dist/helper.user.js', import.meta.url), 'utf8')
)
  .replaceAll('{{ORIGIN}}', 'http://127.0.0.1:18090')
  .replaceAll('{{MATCH}}', 'http://127.0.0.1/*');
const origin = 'http://127.0.0.1:18090',
  CANARY = 'SYNTHETIC_B0_CREDENTIAL_CANARY';
function fixture(options = {}) {
  const listeners = {},
    replies = [],
    requests = [],
    held = [],
    unwrap = new WeakMap();
  let id = 0,
    aborted = 0,
    mediaCalls = 0;
  const page = {};
  page.MediaSource = options.noMediaSource
    ? undefined
    : { isTypeSupported: options.supports || (() => true) };
  page.self = page;
  page.top = options.frame ? {} : page;
  page.addEventListener = (name, callback) =>
    (listeners[name] ??= []).push(callback);
  page.postMessage = (raw) => replies.push(JSON.parse(raw));
  const view = {
    bvid: 'BV1hf4y1N75G',
    title: 'fixture',
    pages: [{ cid: 400306737, page: 1 }],
    cookie: CANARY,
    ...options.view,
  };
  const track = {
    id: 32,
    codecs: 'avc1.64001E',
    mimeType: 'video/mp4',
    baseUrl: `https://cdn.bilivideo.com/upgcxcode/fixture.m4s?deadline=1&upsig=${CANARY}`,
    SegmentBase: { Initialization: '0-31', indexRange: '32-63' },
    ...options.track,
  };
  const play = {
    timelength: 100000,
    dash: {
      video: options.videos
        ? options.videos.map((t) => ({ ...track, ...t }))
        : [track, { ...track, id: 64 }],
      audio: [
        { ...track, id: 30216, codecs: 'mp4a.40.2', mimeType: 'audio/mp4' },
      ],
    },
    token: CANARY,
  };
  function respond(details) {
    if (details.cancelled) return;
    const url = new URL(details.url);
    let value,
      status = 200,
      finalUrl = url.href,
      contentRange = '';
    if (url.pathname.endsWith('/view'))
      value = options.badJSON
        ? `invalid-json-${CANARY}`
        : JSON.stringify({
            code: options.accessCode || 0,
            data: options.unsafeCDN ? { ...view } : view,
          });
    else if (url.pathname.endsWith('/playurl'))
      value = JSON.stringify({
        code: 0,
        data: options.unsafeCDN
          ? {
              ...play,
              dash: {
                ...play.dash,
                video: [
                  {
                    ...track,
                    baseUrl: `https://bilivideo.com.evil.invalid/upgcxcode/${CANARY}`,
                  },
                ],
              },
            }
          : play,
      });
    else if (url.pathname.endsWith('/nav'))
      value = JSON.stringify({
        code: options.loggedOut ? -101 : 0,
        data: { isLogin: true, credential: CANARY },
      });
    else if (url.pathname.endsWith('/videoshot'))
      value = JSON.stringify({
        code: 0,
        data: {
          img_x_len: 2,
          img_y_len: 2,
          img_x_size: 160,
          img_y_size: 90,
          index: [0, 0, 10, 20, 30, 40],
          image: [
            '//i0.hdslb.com/bfs/videoshot/fixture.jpg',
            '//i1.hdslb.com/bfs/videoshot/fixture-1.jpg',
          ],
          credential: CANARY,
          ...options.thumbnails,
        },
      });
    else if (url.hostname.endsWith('.hdslb.com')) {
      value = new Uint8Array(options.thumbnailBytes ?? 300000).fill(42);
      if (options.thumbnailRedirect)
        finalUrl = `https://evil.invalid/${CANARY}`;
    } else if (url.pathname.endsWith('/seg.so')) {
      const varint = (n) => {
        const bytes = [];
        do {
          const b = n % 128;
          n = Math.floor(n / 128);
          bytes.push(b + (n ? 128 : 0));
        } while (n);
        return bytes;
      };
      const comment = (mode, text) => {
        const bytes = new TextEncoder().encode(text);
        const record = [
          16,
          ...varint(1000),
          24,
          mode,
          40,
          ...varint(0xffffff),
          58,
          ...varint(bytes.length),
          ...bytes,
        ];
        return [10, ...varint(record.length), ...record];
      };
      value = new Uint8Array([
        ...comment(1, '<script>text only</script>'),
        ...comment(8, CANARY),
        ...comment(5, 'top comment'),
      ]);
    } else {
      mediaCalls++;
      const match = details.headers.Range.match(/bytes=(\d+)-(\d+)/);
      status = 206;
      value = new Uint8Array(Number(match[2]) - Number(match[1]) + 1).fill(42);
      contentRange = `\r\nContent-Range: bytes ${match[1]}-${match[2]}/9007199254740991`;
      const change = options.media?.(details, value);
      if (change?.timeout) {
        details.ontimeout();
        return;
      }
      if (change?.error) {
        details.onerror();
        return;
      }
      if (change?.bytes) value = change.bytes;
      if (change?.status) status = change.status;
      if (change?.contentRange !== undefined)
        contentRange = change.contentRange;
      if (options.expired && mediaCalls === 1) {
        status = 403;
        value = new Uint8Array();
      }
      if (options.oversize) value = new Uint8Array(256 * 1024 + 1);
      if (options.redirect) finalUrl = `https://evil.invalid/${CANARY}`;
    }
    const bytes =
      typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const response = {
      status,
      finalUrl,
      readyState: 2,
      responseHeaders: `Content-Length: ${bytes.length}${contentRange}`,
      response: bytes.buffer,
      responseText: typeof value === 'string' ? value : undefined,
    };
    details.onreadystatechange?.(response);
    if (details.cancelled) return;
    details.onprogress?.({
      loaded: bytes.length,
      total: bytes.length,
      lengthComputable: true,
    });
    if (details.cancelled) return;
    response.readyState = 4;
    details.onload(response);
  }
  const context = {
    window: page,
    unsafeWindow: page,
    location: { origin: options.origin || origin },
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Uint32Array,
    Map,
    Set,
    crypto,
    performance: { now: options.now || (() => 0) },
    setTimeout,
    clearTimeout,
    btoa,
    atob,
    GM_xmlhttpRequest(details) {
      requests.push(details);
      if (options.hold) held.push(details);
      else if (options.delay)
        setTimeout(
          () => respond(details),
          options.delay(new URL(details.url).pathname),
        );
      else queueMicrotask(() => respond(details));
      return {
        abort() {
          aborted++;
          details.cancelled = true;
          details.onabort();
        },
      };
    },
  };
  if (options.firefox)
    context.XPCNativeWrapper = Object.assign(function () {}, {
      unwrap: (source) => unwrap.get(source) || source,
    });
  vm.runInNewContext(code, context);
  let ready = Promise.resolve();
  async function call(op, args = {}, eventOptions = {}) {
    if (op !== 'hello') await ready;
    const number = ++id;
    const event = {
      source: page,
      origin,
      data: JSON.stringify({
        channel: 'ovs-bilibili-request',
        client: 'a'.repeat(32),
        id: number,
        op,
        ...args,
      }),
      ...eventOptions,
    };
    await Promise.all(
      (listeners.message || []).map((listener) => listener(event)),
    );
    return replies.find((r) => r.id === number);
  }
  ready = call('hello', { version: 1 });
  return {
    call,
    page,
    unwrap,
    listeners,
    replies,
    requests,
    held,
    play,
    get aborted() {
      return aborted;
    },
    open: () => call('open', { bvid: 'BV1hf4y1N75G', part: 1, generation: 1 }),
  };
}
test('exact activation and source checks reject origins, frames, and forged window wrappers', async () => {
  for (const options of [
    { origin: 'https://127.0.0.1:18090' },
    { origin: 'http://localhost:18090' },
    { origin: 'http://127.0.0.1:18091' },
    { frame: true },
  ]) {
    const f = fixture(options);
    assert.equal(f.listeners.message, undefined);
    assert.equal(f.requests.length, 0);
  }
  for (const firefox of [false, true]) {
    const f = fixture({ firefox });
    assert.equal(
      (await f.call('probe', { version: 1 })).value.build,
      release.build,
    );
    assert.equal(
      await f.call('hello', { version: 1 }, { origin: 'https://evil.invalid' }),
      undefined,
    );
    assert.equal(
      await f.call(
        'hello',
        { version: 1 },
        { source: { wrappedJSObject: f.page } },
      ),
      undefined,
    );
    assert.equal(
      await f.call('hello', { version: 1 }, { data: 'x'.repeat(2049) }),
      undefined,
    );
    assert.equal((await f.call('hello', { version: 1 })).ok, true);
    if (firefox) {
      const source = {};
      f.unwrap.set(source, f.page);
      assert.equal(
        (await f.call('hello', { version: 1 }, { source })).ok,
        true,
      );
    }
  }
});
test('thumbnail delivery validates boundaries and isolates source concurrency', async () => {
  const options = {};
  const f = fixture(options),
    opened = await f.open();
  const identity = { handle: opened.value.handle, generation: 1 };
  const requestsBeforeInvalid = f.requests.length;
  assert.equal(
    (await f.call('thumbnail', { ...identity, sheet: 0, offset: 1 })).error,
    'invalid-request',
  );
  assert.equal(f.requests.length, requestsBeforeInvalid);
  const info = await f.call('thumbnails', identity);
  assert.equal(info.ok, true);
  assert.deepEqual(info.value.times, [0, 10, 20, 30, 40]);
  assert.deepEqual(info.value.sources, [0, 1]);
  assert(!JSON.stringify(info).includes(CANARY));
  assert(!JSON.stringify(info).includes('hdslb'));
  const head = await f.call('thumbnail', { ...identity, sheet: 0, offset: 0 });
  const tail = await f.call('thumbnail', {
    ...identity,
    sheet: 0,
    offset: 256 * 1024,
  });
  assert.equal(head.value.total, 300000);
  assert.equal(atob(head.value.base64).length, 256 * 1024);
  assert.equal(atob(tail.value.base64).length, 300000 - 256 * 1024);
  assert.equal(
    f.requests.filter((r) => r.url.includes('/bfs/videoshot/')).length,
    1,
  );
  assert.equal(
    (await f.call('thumbnail', { ...identity, sheet: 2, offset: 0 })).error,
    'invalid-request',
  );
  assert.equal(
    (await f.call('thumbnail', { ...identity, sheet: 0, offset: 1 })).error,
    'invalid-request',
  );

  options.hold = true;
  const thumbnail = f.call('thumbnail', { ...identity, sheet: 1, offset: 0 });
  await new Promise(setImmediate);
  const video = f.call('bytes', {
    ...identity,
    track: 0,
    offset: 0,
    length: 32,
  });
  await new Promise(setImmediate);
  const audio = f.call('bytes', {
    ...identity,
    track: 1,
    offset: 0,
    length: 32,
  });
  await new Promise(setImmediate);
  const otherImage = f.call('thumbnail', { ...identity, sheet: 0, offset: 0 });
  await new Promise(setImmediate);
  try {
    // Separate CDNs progress together, including a long-running thumbnail.
    const image = f.requests.find((r) => r.url.includes('fixture-1.jpg'));
    assert.notEqual(image.cancelled, true);
    assert.equal(f.held.filter((r) => r.headers.Range).length, 2);
    const independent = f.held.find((r) => r.url.endsWith('/fixture.jpg'));
    independent.onload({
      status: 200,
      finalUrl: independent.url,
      response: new Uint8Array(32).buffer,
    });
    assert.equal((await otherImage).ok, true);
    image.onload({
      status: 200,
      finalUrl: image.url,
      response: new Uint8Array(300000).buffer,
    });
    assert.equal((await thumbnail).ok, true);
    assert.equal((await f.call('metrics')).value.peakRequests, 4);
  } finally {
    await f.call('dispose', { generation: 2 });
    await Promise.all([video, audio, otherImage]);
  }

  const quota = fixture(),
    selected = await quota.open();
  let limited = false;
  for (let i = 0; i < 40 && !limited; i++)
    limited =
      (
        await quota.call('thumbnails', {
          handle: selected.value.handle,
          generation: 1,
        })
      ).error === 'rate-limited';
  assert(limited);
  assert.equal(
    (
      await quota.call('danmaku', {
        handle: selected.value.handle,
        generation: 1,
        segment: 1,
      })
    ).ok,
    true,
  );

  // Platform-owned CDN subdomains, paths, queries, geometry, and time spacing vary.
  for (const description of [
    {
      img_x_len: 10,
      img_y_len: 10,
      img_x_size: 480,
      img_y_size: 270,
      image: ['//bimp.hdslb.com/videoshotpvhdboss/43129635608_j9dm8b-0001.jpg'],
      index: [0, 0, 5, 11],
    },
    {
      img_x_len: 25,
      img_y_len: 2,
      img_x_size: 1024,
      img_y_size: 576,
      image: [
        `https://preview-next.hdslb.com/snapshots/v3/sprite?token=${CANARY}`,
      ],
      index: [0, 0.5, 1.25],
    },
  ]) {
    const varied = fixture({ thumbnails: description }),
      media = await varied.open();
    const identity = { handle: media.value.handle, generation: 1 };
    const metadata = await varied.call('thumbnails', identity);
    assert.equal(metadata.ok, true);
    assert.equal(metadata.value.width, description.img_x_size);
    assert.equal(metadata.value.height, description.img_y_size);
    assert(!JSON.stringify(metadata).includes(CANARY));
    assert(!JSON.stringify(metadata).includes('hdslb'));
    assert.equal(
      (await varied.call('thumbnail', { ...identity, sheet: 0, offset: 0 })).ok,
      true,
    );
  }

  for (const bad of [
    { thumbnails: { index: [0, 0, 20, 10] } },
    { thumbnails: { img_x_len: 0 } },
    { thumbnails: { img_x_len: Number.MAX_SAFE_INTEGER } },
    {
      thumbnails: {
        image: [
          `https://i0.hdslb.com.evil.invalid/bfs/videoshot/${CANARY}.jpg`,
        ],
      },
    },
    {
      thumbnails: {
        image: [`https://hdslb.com.evil.invalid/bfs/videoshot/${CANARY}.jpg`],
      },
    },
    { thumbnailRedirect: true },
    { thumbnailBytes: 4 * 1024 * 1024 + 1 },
  ]) {
    const boundary = fixture(bad),
      media = await boundary.open();
    const result = await boundary.call('thumbnail', {
      handle: media.value.handle,
      generation: 1,
      sheet: 0,
      offset: 0,
    });
    assert.equal(result.ok, false);
    assert(!JSON.stringify(result).includes(CANARY));
  }
});

test('bridge returns opaque metadata and bounded bytes while excluding credentials and signed URLs', async () => {
  const f = fixture(),
    open = await f.open();
  assert.equal(open.ok, true);
  assert.equal(open.value.tracks.length, 2);
  assert.equal(open.value.quality, 64);
  assert.deepEqual(Array.from(open.value.qualities), [64, 32]);
  // A different inspection channel must not invalidate the active media owner.
  const inspection = {
    channel: 'ovs-bilibili-request',
    client: 'b'.repeat(32),
    id: 999,
    op: 'probe',
    version: 1,
  };
  await f.call('probe', { version: 1 }, { data: JSON.stringify(inspection) });
  assert.equal(
    f.replies.find((r) => r.id === 999).value.helper,
    release.version,
  );
  const preview = await f.call('preview', {
    client: inspection.client,
    bvid: 'BV17Jx76CEje',
    part: 1,
  });
  assert.equal(preview.ok, true);
  assert.equal(preview.value.bvid, 'BV17Jx76CEje');
  assert.equal(preview.value.handle, undefined);
  assert.equal(f.aborted, 0);
  assert(!JSON.stringify(preview).includes(CANARY));
  assert(!JSON.stringify(preview).includes('https://'));
  assert.equal(
    (
      await f.call('preview', {
        client: inspection.client,
        bvid: 'invalid',
        part: 1,
      })
    ).error,
    'invalid-media',
  );
  assert.equal(
    (
      await f.call('preview', {
        client: inspection.client,
        bvid: 'BV17Jx76CEje',
        part: 2,
      })
    ).error,
    'part-unavailable',
  );
  assert(!JSON.stringify(open).includes(CANARY));
  assert(!JSON.stringify(open).includes('https://'));
  assert.equal(open.value.playlist, undefined);
  const pages = [
    { cid: 400306737, page: 1, part: 'Opening' },
    {
      cid: 400306738,
      page: 2,
      part: '<script>Finale</script>',
      cookie: CANARY,
    },
  ];
  const multipart = await fixture({ view: { pages } }).open();
  assert.deepEqual(multipart.value.playlist, {
    title: 'fixture',
    episodes: pages.map((p) => ({
      bvid: 'BV1hf4y1N75G',
      part: p.page,
      title: p.part,
    })),
  });
  const episodes = [
    { bvid: 'BV1hf4y1N75G', title: 'First', pages: [pages[0]], token: CANARY },
    {
      bvid: 'BV17Jx76CEje',
      title: 'Second',
      pages,
      signedURL: `https://example.invalid/${CANARY}`,
    },
  ];
  const collection = await fixture({
    view: {
      ugc_season: {
        title: 'Collection',
        sections: [{ episodes: [...episodes, episodes[0]] }],
        cookie: CANARY,
      },
    },
  }).open();
  assert.deepEqual(collection.value.playlist, {
    title: 'Collection',
    episodes: [
      { bvid: 'BV1hf4y1N75G', part: 1, title: 'First' },
      { bvid: 'BV17Jx76CEje', part: 1, title: 'Second · Opening' },
      {
        bvid: 'BV17Jx76CEje',
        part: 2,
        title: 'Second · <script>Finale</script>',
      },
    ],
  });
  assert(!JSON.stringify(collection).includes(CANARY));
  assert(!JSON.stringify(collection).includes('https://'));
  const oversized = await fixture({
    view: {
      ugc_season: {
        title: 'Too many',
        sections: [{ episodes: Array(501).fill(episodes[0]) }],
      },
    },
  }).open();
  assert.equal(oversized.ok, true);
  assert.equal(oversized.value.playlist, undefined);
  const data = await f.call('bytes', {
    handle: open.value.handle,
    track: 0,
    offset: 0,
    length: 32,
    generation: 1,
  });
  assert.equal(atob(data.value.base64).length, 32);
  for (const args of [
    { url: 'https://evil.invalid', headers: { Cookie: CANARY } },
    {
      handle: open.value.handle,
      track: 0,
      offset: 0,
      length: 999999,
      generation: 1,
    },
    {
      handle: open.value.handle,
      track: 0,
      offset: -1,
      length: 32,
      generation: 1,
    },
    {
      handle: open.value.handle,
      track: 0,
      offset: Number.MAX_SAFE_INTEGER,
      length: 32,
      generation: 1,
    },
  ]) {
    const r = await f.call('bytes', args);
    assert.equal(r.ok, false);
  }
  assert.equal(
    f.requests.filter((r) => r.url.includes('/upgcxcode/')).length,
    1,
  );
  const switched = await f.call('open', {
    bvid: 'BV1hf4y1N75G',
    part: 1,
    generation: 2,
    quality: 32,
  });
  assert.equal(switched.value.quality, 32);
  assert.equal(switched.value.tracks[0].id, 32);
  assert.equal(
    new URL(
      f.requests.filter((r) => r.url.includes('/playurl')).at(-1).url,
    ).searchParams.get('qn'),
    '32',
  );
  assert(!JSON.stringify(switched).includes(CANARY));
  const unavailable = await f.call('open', {
    bvid: 'BV1hf4y1N75G',
    part: 1,
    generation: 3,
    quality: 120,
  });
  assert.equal(unavailable.value.quality, 64);
});
test('unapproved primary media locations use reviewed backups without exposing URLs', async () => {
  const backup = `https://backup.bilivideo.com/upgcxcode/fixture.m4s?upsig=${CANARY}`;
  const denied = [
    `https://peer.mcdn.bilivideo.cn:4483/upgcxcode/${CANARY}`,
    `http://cdn.bilivideo.com/upgcxcode/${CANARY}`,
    `https://cdn.bilivideo.com:4483/upgcxcode/${CANARY}`,
    `https://bilivideo.com.evil.invalid/upgcxcode/${CANARY}`,
    `https://user:${CANARY}@cdn.bilivideo.com/upgcxcode/fixture.m4s`,
    `https://cdn.bilivideo.com/other/${CANARY}`,
    `https://cdn.bilivideo.com/upgcxcode/fixture.m4s#${CANARY}`,
    `not-a-url-${CANARY}`,
  ];
  for (const [index, primary] of denied.entries()) {
    const selected =
      index % 2
        ? backup
        : `https://upos-hz-mirrorakam.akamaized.net/upgcxcode/fixture.m4s?upsig=${CANARY}`;
    // Both provider naming styles occur in DASH responses.
    const track =
      index % 2
        ? {
            baseUrl: undefined,
            base_url: primary,
            backup_url: [...denied, selected],
          }
        : { baseUrl: primary, backupUrl: [...denied, selected] };
    const f = fixture({ track }),
      opened = await f.open();
    assert.equal(opened.ok, true, primary);
    for (const track of [0, 1]) {
      const data = await f.call('bytes', {
        handle: opened.value.handle,
        track,
        offset: 0,
        length: 32,
        generation: 1,
      });
      assert.equal(data.ok, true);
      assert.equal(atob(data.value.base64).length, 32);
    }
    assert.deepEqual(
      f.requests.filter((r) => r.headers.Range).map((r) => r.url),
      [selected, selected],
    );
    assert(!JSON.stringify(f.replies).includes(CANARY));
    assert(!JSON.stringify(f.replies).includes('https://'));
  }
  const preferred = fixture({ track: { backupUrl: [backup] } });
  const opened = await preferred.open();
  await preferred.call('bytes', {
    handle: opened.value.handle,
    track: 0,
    offset: 0,
    length: 32,
    generation: 1,
  });
  assert.equal(
    new URL(preferred.requests.at(-1).url).hostname,
    'cdn.bilivideo.com',
  );
  for (const backupUrl of [denied, 'invalid-backup-list', [null, 123, {}]]) {
    const f = fixture({ track: { baseUrl: denied[0], backupUrl } });
    const result = await f.open();
    assert.equal(result.error, 'destination-denied');
    assert.equal(f.requests.filter((r) => r.headers.Range).length, 0);
    assert(!JSON.stringify(result).includes(CANARY));
  }
});
test('provider failures and restricted access cannot leak raw canaries', async () => {
  for (const options of [
    { badJSON: true },
    { unsafeCDN: true },
    { accessCode: -10403 },
    { accessCode: -404 },
    { accessCode: -101 },
  ]) {
    const f = fixture(options),
      r = await f.open();
    assert.equal(r.ok, false);
    assert(!JSON.stringify(r).includes(CANARY));
  }
  const f = fixture({ loggedOut: true });
  assert.equal((await f.call('session')).value.loggedIn, false);
});
test('network windows preserve byte order, stay bounded, and cancel only obsolete media reads', async () => {
  const chunk = 256 * 1024,
    options = {
      media: (details, bytes) => {
        const start = Number(details.headers.Range.match(/bytes=(\d+)/)[1]);
        return { bytes: bytes.map((_, i) => (start + i) % 251) };
      },
    },
    f = fixture(options),
    opened = await f.open(),
    read = {
      handle: opened.value.handle,
      track: 0,
      generation: 1,
      seek: 0,
      offset: 64,
      length: chunk,
      end: 64 + 2 * 1024 * 1024 - 1,
      rate: 4 * 1024 * 1024,
    };
  for (let i = 0; i < 8; i++) {
    const offset = 64 + i * chunk,
      reply = await f.call('bytes', { ...read, offset });
    assert.equal(reply.ok, true);
    const bytes = Uint8Array.from(atob(reply.value.base64), (c) =>
      c.charCodeAt(0),
    );
    assert(bytes.every((byte, at) => byte === (offset + at) % 251));
  }
  assert.equal(f.requests.filter((request) => request.headers.Range).length, 1);
  assert.equal(
    (await f.call('metrics')).value.maxResponseBytes,
    2 * 1024 * 1024,
  );
  options.hold = true;
  const old = f.call('bytes', {
      ...read,
      offset: read.end + 1,
      end: read.end + 2 * 1024 * 1024,
    }),
    session = f.call('session');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.held.length, 2);
  // An invalid request must not cancel work or advance the cursor.
  assert.equal(
    (await f.call('bytes', { ...read, seek: 1, length: chunk + 1 })).error,
    'invalid-range',
  );
  assert.equal(f.aborted, 0);
  assert.equal(
    (await f.call('seek', { handle: read.handle, generation: 1, seek: 1 })).ok,
    true,
  );
  assert.equal((await old).error, 'cancelled');
  assert.equal(f.aborted, 1);
  assert.equal((await f.call('bytes', read)).error, 'cancelled');
  const api = f.held.find((request) => !request.headers.Range);
  api.onload({
    status: 200,
    finalUrl: api.url,
    responseText: JSON.stringify({ code: 0, data: { isLogin: true } }),
  });
  assert.equal((await session).value.loggedIn, true);
  options.hold = false;
  assert.equal((await f.call('bytes', { ...read, seek: 1 })).ok, true);
  assert.equal(f.requests.filter((request) => request.headers.Range).length, 3);
  assert(!JSON.stringify(f.replies).includes(CANARY));
});

test('slow or failed CDN locations switch only to mirrors with matching initialization and index bytes', async () => {
  for (const failure of [
    'slow',
    'network',
    'range',
    'unusable',
    'timeout',
    'deadline',
    'expired',
    'rate-limited',
    404,
    408,
    501,
    503,
    599,
  ]) {
    let clock = 0;
    let expire = true;
    const f = fixture({
        now: () => clock,
        track: {
          backupUrl: [
            'https://wrong.bilivideo.com/upgcxcode/wrong.m4s',
            'https://fast.bilivideo.com/upgcxcode/match.m4s',
          ],
        },
        media(details, bytes) {
          const url = new URL(details.url),
            start = Number(details.headers.Range.match(/bytes=(\d+)/)[1]);
          if (
            url.hostname === 'wrong.bilivideo.com' ||
            (['unusable', 'expired'].includes(failure) &&
              url.hostname === 'fast.bilivideo.com')
          )
            return { bytes: bytes.fill(43) };
          if (url.hostname === 'cdn.bilivideo.com' && start >= 64) {
            if (Number.isInteger(failure)) return { status: failure };
            if (failure === 'rate-limited') return { status: 429 };
            if (failure === 'expired' && expire) {
              expire = false;
              return { status: 403 };
            }
            if (failure === 'timeout') {
              clock += 4000;
              return { timeout: true };
            }
            if (failure === 'deadline') {
              clock += 13000;
              return { error: true };
            }
            if (failure === 'network') return { error: true };
            if (failure === 'range')
              return { contentRange: '\r\nContent-Range: bytes 0-31/100' };
            clock += 1000;
          }
        },
      }),
      opened = await f.open(),
      read = { handle: opened.value.handle, track: 0, generation: 1, seek: 0 };
    for (const offset of [0, 32])
      assert.equal(
        (await f.call('bytes', { ...read, offset, length: 32 })).ok,
        true,
      );
    const count = ['slow', 'unusable'].includes(failure) ? 3 : 1;
    for (let i = 0; i < count; i++) {
      const reply = await f.call('bytes', {
        ...read,
        offset: 64 + i * 2 * 1024 * 1024,
        length: 32,
        end: 64 + 6 * 1024 * 1024 - 1,
        rate: 4 * 1024 * 1024,
      });
      if (failure === 'deadline') {
        assert.equal(reply.error, 'request-timeout');
        break;
      }
      if (failure === 'rate-limited') {
        assert.equal(reply.error, 'http-429');
        break;
      }
      assert.equal(reply.ok, true, reply.error);
      assert.equal(atob(reply.value.base64), '*'.repeat(32));
    }
    const media = f.requests.filter((request) => request.headers.Range);
    if (['deadline', 'rate-limited'].includes(failure)) {
      assert.equal(media.length, 3);
      continue;
    }
    assert.equal(
      new URL(media.at(-1).url).hostname,
      ['unusable', 'expired'].includes(failure)
        ? 'cdn.bilivideo.com'
        : 'fast.bilivideo.com',
    );
    assert(
      media.some(
        (request) =>
          new URL(request.url).hostname === 'wrong.bilivideo.com' &&
          request.headers.Range === 'bytes=0-63',
      ),
    );
    assert(
      !media.some(
        (request) =>
          new URL(request.url).hostname === 'wrong.bilivideo.com' &&
          request.headers.Range !== 'bytes=0-63',
      ),
    );
    assert(!JSON.stringify(f.replies).includes(CANARY));
  }
});
test('later CDN failures can reuse a recovered source without cycling within a read', async () => {
  let failing = 'cdn.bilivideo.com';
  const f = fixture({
      track: {
        backupUrl: ['https://backup.bilivideo.com/upgcxcode/match.m4s'],
      },
      media(details) {
        if (failing === 'all' || new URL(details.url).hostname === failing)
          return { error: true };
      },
    }),
    opened = await f.open(),
    args = { handle: opened.value.handle, track: 0, generation: 1, length: 32 };
  assert.equal((await f.call('bytes', { ...args, offset: 0 })).ok, true);
  failing = 'backup.bilivideo.com';
  assert.equal((await f.call('bytes', { ...args, offset: 32 })).ok, true);
  assert.equal(new URL(f.requests.at(-1).url).hostname, 'cdn.bilivideo.com');
  failing = 'all';
  // Both sources fail on the next operation. Each must be tried only once.
  const before = f.requests.length;
  assert.equal(
    (await f.call('bytes', { ...args, offset: 64 })).error,
    'network-or-permission-denied',
  );
  assert.equal(f.requests.length - before, 2);
  assert(!JSON.stringify(f.replies).includes(CANARY));
});

test('timed-out high-bitrate read-ahead shrinks and regrows after recovery', async () => {
  let clock = 0;
  let recovered = false;
  const chunk = 256 * 1024,
    f = fixture({
      now: () => clock,
      media(details, bytes) {
        if (!recovered && bytes.length > chunk) {
          clock += details.timeout;
          return { timeout: true };
        }
        if (!recovered) clock += details.timeout / 2;
      },
    }),
    opened = await f.open(),
    args = {
      handle: opened.value.handle,
      track: 0,
      generation: 1,
      offset: 64,
      length: chunk,
      end: 64 + 20 * 1024 * 1024 - 1,
      rate: 4 * 1024 * 1024,
    };
  let reply;
  for (let attempt = 0; attempt < 4; attempt++) {
    reply = await f.call('bytes', args);
    if (reply.ok) break;
    assert.equal(reply.error, 'request-timeout');
  }
  assert.equal(reply.ok, true);
  assert.equal(atob(reply.value.base64).length, chunk);
  assert.equal(
    (await f.call('bytes', { ...args, offset: 64 + chunk })).ok,
    true,
  );
  recovered = true;
  for (let i = 0; i < 7; i++)
    assert.equal(
      (
        await f.call('bytes', {
          ...args,
          offset: 64 + (i + 2) * 2 * 1024 * 1024,
        })
      ).ok,
      true,
    );
  const range = f.requests.at(-1).headers.Range.match(/bytes=(\d+)-(\d+)/);
  assert.equal(Number(range[2]) - Number(range[1]) + 1, 2 * 1024 * 1024);
  assert(!JSON.stringify(f.replies).includes(CANARY));
});

test('previews and opens select the best supported codec at the preferred or highest playable quality', async () => {
  const av1 = 'av01.0.08M.08',
    hevc = 'hev1.1.6.L120.90',
    avc = 'avc1.64001E';
  const videos = [
    { id: 64, codecs: avc },
    { id: 64, codecs: hevc },
    { id: 64, codecs: av1 },
    { id: 32, codecs: avc },
    { id: 32, codecs: av1 },
    { id: 80, codecs: 'av01.0.12M.10' },
    { id: 127, codecs: 'vp09.00.10.08' },
  ];
  for (const [supported, expected, qualities] of [
    [[av1, hevc, avc], av1, [64, 32]],
    [[hevc, avc], hevc, [64, 32]],
    [[avc], avc, [64, 32]],
  ]) {
    const f = fixture({
      videos,
      supports: (mime) =>
        mime.startsWith('audio/mp4;') ||
        supported.some((codec) => mime === `video/mp4; codecs="${codec}"`),
    });
    const preview = await f.call('preview', { bvid: 'BV1hf4y1N75G', part: 1 });
    const opened = await f.open();
    for (const reply of [preview, opened]) {
      assert.equal(reply.ok, true);
      assert.equal(reply.value.quality, 64);
      assert.equal(reply.value.tracks[0].codec, expected);
      assert.deepEqual(reply.value.qualities, qualities);
      assert(!JSON.stringify(reply).includes(CANARY));
    }
    const selected = await f.call('open', {
      bvid: 'BV1hf4y1N75G',
      part: 1,
      generation: 2,
      quality: 32,
    });
    assert.equal(selected.value.quality, 32);
    assert.equal(
      selected.value.tracks[0].codec,
      supported.includes(av1) ? av1 : avc,
    );
    const query = new URL(
      f.requests.find((r) => r.url.includes('/playurl')).url,
    ).searchParams;
    assert.equal(Number(query.get('fnval')) & 2048, 2048);
    assert.equal(Number(query.get('fnval')) & 16, 16);
  }
  // A higher quality still wins when its only supported representation is AVC.
  const f = fixture({
    videos: [
      { id: 32, codecs: av1 },
      { id: 64, codecs: avc },
    ],
  });
  const opened = await f.open();
  assert.equal(opened.value.quality, 64);
  assert.equal(opened.value.tracks[0].codec, avc);
  for (const codec of ['hvc1.1.6.L120.90', hevc, 'avc3.64001E', av1]) {
    const opened = await fixture({ videos: [{ codecs: codec }] }).open();
    assert.equal(opened.ok, true);
    assert.equal(opened.value.tracks[0].codec, codec);
  }
  for (const options of [
    { noMediaSource: true },
    { supports: () => false },
    { supports: (mime) => !mime.startsWith('audio/mp4;') },
    {
      supports: () => {
        throw Error(CANARY);
      },
    },
    { videos: [{ codecs: 'av01.0.08M.08"; injected="x' }] },
  ]) {
    const f = fixture(options),
      opened = await f.open();
    assert.equal(opened.error, 'unsupported-codec');
    assert.equal(f.requests.filter((r) => r.headers.Range).length, 0);
    assert(!JSON.stringify(opened).includes(CANARY));
  }
});
test('expired ranges refresh once through the same identity and return media bytes', async () => {
  const backup = `https://backup.bilivideo.com/upgcxcode/fixture.m4s?upsig=${CANARY}`;
  const f = fixture({
      expired: true,
      track: {
        baseUrl: `https://peer.mcdn.bilivideo.cn:4483/upgcxcode/${CANARY}`,
        backupUrl: [backup],
      },
    }),
    open = await f.open();
  const r = await f.call('bytes', {
    handle: open.value.handle,
    track: 0,
    offset: 0,
    length: 32,
    generation: 1,
  });
  assert.equal(r.ok, true);
  assert.equal((await f.call('metrics')).value.refreshes, 1);
  assert.deepEqual(
    f.requests.filter((r) => r.headers.Range).map((r) => r.url),
    [backup, backup],
  );
  assert(!JSON.stringify(f.replies).includes(CANARY));
  // The same quality can acquire a preferred codec after open. Refresh must keep
  // the original representation because the page already owns its byte index.
  for (const keepOriginal of [true, false]) {
    const videos = [{ id: 64, codecs: 'hvc1.1.6.L120.90' }];
    const f = fixture({ expired: true, videos }),
      opened = await f.open();
    f.play.dash.video.unshift({
      ...f.play.dash.video[0],
      codecs: 'av01.0.08M.08',
    });
    f.play.dash.audio.unshift({ ...f.play.dash.audio[0], id: 30280 });
    if (!keepOriginal) f.play.dash.video.pop();
    const reply = await f.call('bytes', {
      handle: opened.value.handle,
      track: 0,
      offset: 0,
      length: 32,
      generation: 1,
    });
    assert.equal(reply.ok, keepOriginal);
    if (!keepOriginal) assert.equal(reply.error, 'media-changed');
    assert.equal(
      f.requests.filter((r) => r.headers.Range).length,
      keepOriginal ? 2 : 1,
    );
  }
  for (const cancel of [true, false]) {
    let expired = false;
    const options = {
        media(details, bytes) {
          const offset = Number(details.headers.Range.match(/bytes=(\d+)/)[1]);
          if (offset >= 64 && !expired) {
            expired = true;
            options.hold = cancel;
            return { status: 403 };
          }
          if (expired && !cancel && offset === 0)
            return { bytes: bytes.fill(43) };
        },
      },
      f = fixture(options),
      opened = await f.open(),
      args = {
        handle: opened.value.handle,
        track: 0,
        generation: 1,
        length: 32,
      };
    for (const offset of [0, 32])
      assert.equal((await f.call('bytes', { ...args, offset })).ok, true);
    const reading = f.call('bytes', { ...args, offset: 64 });
    if (cancel) {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(f.held.length, 1);
      assert.equal(
        (await f.call('bytes', { ...args, offset: 64 })).error,
        'busy',
      );
      assert.equal(
        (await f.call('seek', { handle: args.handle, generation: 1, seek: 1 }))
          .ok,
        true,
      );
      assert.equal((await reading).error, 'cancelled');
      options.hold = false;
      assert.equal(
        (await f.call('bytes', { ...args, offset: 64, seek: 1 })).ok,
        true,
      );
      assert.equal((await f.call('metrics')).value.refreshes, 0);
    } else assert.equal((await reading).error, 'media-changed');
  }
});
test('slow resolution completes while request and media-operation deadlines remain bounded', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const op of ['preview', 'open']) {
    let clock = 0;
    const options = { now: () => clock, delay: () => 11000 },
      f = fixture(options),
      resolving = f.call(op, {
        bvid: 'BV1hf4y1N75G',
        part: 1,
        ...(op === 'open' ? { generation: 1 } : {}),
      });
    const advance = async (milliseconds) => {
      clock += milliseconds;
      t.mock.timers.tick(milliseconds);
      await new Promise((resolve) => setImmediate(resolve));
    };
    await new Promise((resolve) => setImmediate(resolve));
    await advance(11000);
    await advance(11000);
    const reply = await resolving;
    assert.equal(reply.ok, true);
    assert.equal(reply.value.bvid, 'BV1hf4y1N75G');
    assert(!JSON.stringify(f.replies).includes(CANARY));
    // An individual request still cannot consume the full resolution budget.
    options.delay = () => 30000;
    const stalled = f.call('preview', { bvid: 'BV1hf4y1N75G', part: 1 });
    await new Promise((resolve) => setImmediate(resolve));
    await advance(12000);
    assert.equal((await stalled).error, 'request-timeout');
    assert.equal(f.aborted, 1);
  }
  let clock = 0;
  const options = { now: () => clock, expired: true },
    f = fixture(options),
    opened = await f.open();
  options.delay = () => 11000;
  const reading = f.call('bytes', {
    handle: opened.value.handle,
    track: 0,
    offset: 0,
    length: 32,
    generation: 1,
  });
  await new Promise((resolve) => setImmediate(resolve));
  clock += 11000;
  t.mock.timers.tick(11000);
  await new Promise((resolve) => setImmediate(resolve));
  // Expiry refresh has only the remaining second of the byte-operation budget.
  clock += 1000;
  t.mock.timers.tick(1000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await reading).error, 'request-timeout');
  assert.equal(f.requests.filter((request) => request.headers.Range).length, 1);
  assert.equal((await f.call('metrics')).value.refreshes, 0);
  assert(!JSON.stringify(f.replies).includes(CANARY));
});
test('oversized streams and unapproved final destinations fail without exposing bytes', async () => {
  for (const options of [{ oversize: true }, { redirect: true }]) {
    const f = fixture(options),
      open = await f.open(),
      r = await f.call('bytes', {
        handle: open.value.handle,
        track: 0,
        offset: 0,
        length: 32,
        generation: 1,
      });
    assert.equal(r.ok, false);
    assert.equal(r.value, undefined);
    assert(!JSON.stringify(r).includes(CANARY));
    assert(f.aborted > 0 || options.redirect);
  }
});
test('bounded concurrency, flood rejection, disposal, and late callbacks preserve ownership', async () => {
  const f = fixture({ hold: true }),
    one = f.call('session'),
    two = f.call('session');
  const busy = await f.call('session');
  assert.equal(busy.error, 'busy');
  assert.equal(f.requests.length, 2);
  const disposed = await f.call('dispose', { generation: 1 });
  assert.equal(disposed.ok, true);
  await Promise.all([one, two]);
  assert.equal(f.aborted, 2);
  for (const request of f.held)
    request.onload({
      status: 200,
      finalUrl: request.url,
      responseText: CANARY,
    });
  assert(!JSON.stringify(f.replies).includes(CANARY));
  const flood = fixture();
  for (let i = 0; i < 100; i++) await flood.call('hello', { version: 1 });
  assert(flood.replies.filter((r) => r.error === 'rate-limited').length >= 68);
  const media = fixture(),
    opened = await media.open();
  for (let i = 0; i < 140; i++)
    await media.call('bytes', {
      handle: opened.value.handle,
      track: 0,
      offset: 64,
      length: 1,
      generation: 1,
    });
  assert.equal(
    media.replies.filter((reply) => reply.error === 'rate-limited').length,
    12,
  );
});

test('a replacement player channel cancels old work and refuses stale owners', async () => {
  const options = {},
    f = fixture(options),
    opened = await f.open();
  options.hold = true;
  const reading = f.call('bytes', {
    handle: opened.value.handle,
    track: 0,
    offset: 0,
    length: 32,
    generation: 1,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.held.length, 1);
  options.hold = false;
  const preview = await f.call('preview', {
    bvid: 'BV17Jx76CEje',
    part: 1,
    client: 'c'.repeat(32),
  });
  assert.equal(preview.ok, true);
  assert.equal(f.aborted, 0);
  const client = 'b'.repeat(32);
  const hello = await f.call('hello', { version: 1, client });
  assert.equal(hello.ok, true);
  assert.equal((await reading).error, 'cancelled');
  assert.equal(f.aborted, 1);
  const stale = await f.call('bytes', {
    handle: opened.value.handle,
    track: 0,
    offset: 0,
    length: 32,
    generation: 1,
  });
  assert.equal(stale.error, 'stale-generation');
  const next = await f.call('open', {
    bvid: 'BV1hf4y1N75G',
    part: 1,
    generation: 1,
    client,
  });
  assert.equal(next.ok, true);
  assert.notEqual(next.value.handle, opened.value.handle);
});

test('danmaku strips provider fields and executable modes while preserving plain text', async () => {
  const f = fixture(),
    opened = await f.open();
  const reply = await f.call('danmaku', {
    handle: opened.value.handle,
    segment: 1,
    generation: 1,
  });
  assert.equal(reply.ok, true);
  assert.deepEqual(
    reply.value.comments.map((c) => c.mode),
    [1, 5],
  );
  assert.equal(reply.value.comments[0].text, '<script>text only</script>');
  assert(!JSON.stringify(reply).includes(CANARY));
});

test('bridge JSON rejects duplicate keys, nesting, invalid scalars, and oversized UTF-8', async () => {
  assert.deepEqual(
    parseBridgeJSON('{"duration":10.25,"comments":[{"time":1.5}]}', 2048),
    {
      duration: 10.25,
      comments: [{ time: 1.5 }],
    },
  );
  for (const raw of [
    '{"op":"session","op":"session"}',
    '{"value":{"cid":"1","cid":"2"}}',
    '{"x":[[[[[[[[0]]]]]]]]}',
    '{"x":01}',
    '{"x":"\\ud800"}',
    '[]',
    '{"x":"' + '中'.repeat(1000) + '"}',
  ])
    assert.throws(() => parseBridgeJSON(raw, 2048));
  const f = fixture();
  await f.call('hello', { version: 1 });
  const before = f.requests.length;
  await f.call(
    'session',
    {},
    {
      data: JSON.stringify({
        channel: 'ovs-bilibili-request',
        client: 'a'.repeat(32),
        id: 999,
        op: 'session',
      }).replace('"op":"session"', '"op":"session","op":"session"'),
    },
  );
  assert.equal(f.requests.length, before);
});
