// Fault fixtures complement, and do not replace, live Tampermonkey experiments.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { parseBridgeJSON } from './bridge-json.js';
import { readFile } from 'node:fs/promises';
const code = (await readFile(new URL('./helper.user.js', import.meta.url), 'utf8'))
  .replace(
    '/* OVS_BRIDGE_JSON */',
    (await readFile(new URL('./bridge-json.js', import.meta.url), 'utf8')).replace(/^export /, ''),
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
  page.self = page;
  page.top = options.frame ? {} : page;
  page.addEventListener = (name, callback) => (listeners[name] ??= []).push(callback);
  page.postMessage = (raw) => replies.push(JSON.parse(raw));
  const view = {
    bvid: 'BV1hf4y1N75G',
    title: 'fixture',
    pages: [{ cid: 400306737, page: 1 }],
    cookie: CANARY,
  };
  const track = {
    id: 32,
    codecs: 'avc1.64001E',
    mimeType: 'video/mp4',
    baseUrl: `https://cdn.bilivideo.com/upgcxcode/fixture.m4s?deadline=1&upsig=${CANARY}`,
    SegmentBase: { Initialization: '0-31', indexRange: '32-63' },
  };
  const play = {
    timelength: 100000,
    dash: {
      video: [track],
      audio: [{ ...track, id: 30216, codecs: 'mp4a.40.2', mimeType: 'audio/mp4' }],
    },
    token: CANARY,
  };
  function respond(details) {
    const url = new URL(details.url);
    let value,
      status = 200,
      finalUrl = url.href;
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
                  { ...track, baseUrl: `https://bilivideo.com.evil.invalid/upgcxcode/${CANARY}` },
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
    else if (url.pathname.endsWith('/seg.so')) {
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
      if (options.expired && mediaCalls === 1) {
        status = 403;
        value = new Uint8Array();
      }
      if (options.oversize) value = new Uint8Array(256 * 1024 + 1);
      if (options.redirect) finalUrl = `https://evil.invalid/${CANARY}`;
    }
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const response = {
      status,
      finalUrl,
      readyState: 2,
      responseHeaders: `Content-Length: ${bytes.length}`,
      response: bytes.buffer,
      responseText: typeof value === 'string' ? value : undefined,
    };
    details.onreadystatechange?.(response);
    if (details.cancelled) return;
    details.onprogress?.({ loaded: bytes.length, total: bytes.length, lengthComputable: true });
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
    performance: { now: () => 0 },
    setTimeout,
    clearTimeout,
    btoa,
    atob,
    GM_xmlhttpRequest(details) {
      requests.push(details);
      if (options.hold) held.push(details);
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
    await Promise.all((listeners.message || []).map((listener) => listener(event)));
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
      await f.call('hello', { version: 1 }, { origin: 'https://evil.invalid' }),
      undefined,
    );
    assert.equal(
      await f.call('hello', { version: 1 }, { source: { wrappedJSObject: f.page } }),
      undefined,
    );
    assert.equal(await f.call('hello', { version: 1 }, { data: 'x'.repeat(2049) }), undefined);
    assert.equal((await f.call('hello', { version: 1 })).ok, true);
    if (firefox) {
      const source = {};
      f.unwrap.set(source, f.page);
      assert.equal((await f.call('hello', { version: 1 }, { source })).ok, true);
    }
  }
});
test('bridge returns opaque metadata and bounded bytes while excluding credentials and signed URLs', async () => {
  const f = fixture(),
    open = await f.open();
  assert.equal(open.ok, true);
  assert.equal(open.value.tracks.length, 2);
  assert(!JSON.stringify(open).includes(CANARY));
  assert(!JSON.stringify(open).includes('https://'));
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
    { handle: open.value.handle, track: 0, offset: 0, length: 999999, generation: 1 },
    { handle: open.value.handle, track: 0, offset: -1, length: 32, generation: 1 },
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
  assert.equal(f.requests.filter((r) => r.url.includes('/upgcxcode/')).length, 1);
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
test('expired ranges refresh once through the same identity and return media bytes', async () => {
  const f = fixture({ expired: true }),
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
    request.onload({ status: 200, finalUrl: request.url, responseText: CANARY });
  assert(!JSON.stringify(f.replies).includes(CANARY));
  const flood = fixture();
  for (let i = 0; i < 100; i++) await flood.call('hello', { version: 1 });
  assert(flood.replies.filter((r) => r.error === 'rate-limited').length >= 68);
});

test('a replacement player channel cancels old work and refuses stale owners', async () => {
  const f = fixture(),
    opened = await f.open();
  const client = 'b'.repeat(32);
  const hello = await f.call('hello', { version: 1, client });
  assert.equal(hello.ok, true);
  const stale = await f.call('bytes', {
    handle: opened.value.handle,
    track: 0,
    offset: 0,
    length: 32,
    generation: 1,
  });
  assert.equal(stale.error, 'stale-generation');
  const next = await f.call('open', { bvid: 'BV1hf4y1N75G', part: 1, generation: 1, client });
  assert.equal(next.ok, true);
  assert.notEqual(next.value.handle, opened.value.handle);
});

test('danmaku strips provider fields and executable modes while preserving plain text', async () => {
  const f = fixture(),
    opened = await f.open();
  const reply = await f.call('danmaku', { handle: opened.value.handle, segment: 1, generation: 1 });
  assert.equal(reply.ok, true);
  assert.deepEqual(
    reply.value.comments.map((c) => c.mode),
    [1, 5],
  );
  assert.equal(reply.value.comments[0].text, '<script>text only</script>');
  assert(!JSON.stringify(reply).includes(CANARY));
});

test('bridge JSON rejects duplicate keys, nesting, invalid scalars, and oversized UTF-8', async () => {
  assert.deepEqual(parseBridgeJSON('{"duration":10.25,"comments":[{"time":1.5}]}', 2048), {
    duration: 10.25,
    comments: [{ time: 1.5 }],
  });
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
