import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(
  new URL('./dist/helper.user.js', import.meta.url),
  'utf8',
);

// The launcher needs only shared DOM nodes and native link activation. The browser
// journey covers rendering and navigation; this fixture isolates script coexistence.
class Element extends EventTarget {
  constructor(tagName) {
    super();
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.style = {};
    this.attributes = {};
  }
  append(...children) {
    for (const child of children) {
      if (child.parentElement)
        child.parentElement.children = child.parentElement.children.filter(
          (node) => node !== child,
        );
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = undefined;
    this.children = [];
    this.append(...children);
  }
  setAttribute(key, value) {
    this.attributes[key] = value;
  }
  removeAttribute(key) {
    delete this.attributes[key];
    delete this[key];
  }
  find(predicate) {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const found = child.find(predicate);
      if (found) return found;
    }
    return null;
  }
  querySelector(selector) {
    if (selector === '[data-ovs-sites="1"]')
      return this.find((node) => node.dataset.ovsSites === '1');
    if (selector === '[data-ovs-status="1"]')
      return this.find((node) => node.dataset.ovsStatus === '1');
    throw Error(`Unsupported fixture selector: ${selector}`);
  }
}
function fixture({ frame = false, ready = true, language = 'en' } = {}) {
  const document = new EventTarget();
  document.body = ready ? new Element('body') : null;
  document.createElement = (tag) => new Element(tag);
  document.createElementNS = (_namespace, tag) => new Element(tag);
  document.getElementById = (id) =>
    document.body?.find((node) => node.id === id) ?? null;
  const page = new EventTarget();
  page.top = frame ? {} : page;
  page.self = page;
  const listeners = [];
  const addEventListener = page.addEventListener.bind(page);
  page.addEventListener = (name, callback) => {
    listeners.push(name);
    addEventListener(name, callback);
  };
  let location = new URL('https://www.bilibili.com/video/BV1TESTaaaaa/?p=2');
  let network = 0;
  function install(origin) {
    const context = {
      document,
      unsafeWindow: page,
      window: page,
      navigator: { language },
      location,
      URL,
      URLSearchParams,
      GM_xmlhttpRequest() {
        network++;
        throw Error('Launcher must not access the network.');
      },
    };
    vm.runInNewContext(source.replaceAll('{{ORIGIN}}', origin), context);
    return context;
  }
  const contexts = [];
  return {
    document,
    page,
    listeners,
    install(origin) {
      contexts.push(install(origin));
    },
    navigate(url) {
      location = new URL(url);
      for (const context of contexts) context.location = location;
    },
    get roots() {
      return document.body?.children ?? [];
    },
    get links() {
      return (
        document.body?.querySelector('[data-ovs-sites="1"]')?.children ?? []
      );
    },
    get network() {
      return network;
    },
  };
}

test('instance helpers merge their destinations without duplicating the Bilibili entry', () => {
  const f = fixture({ ready: false, language: 'zh-CN' });
  f.install('https://watch.example');
  f.install('http://watch.example:8080');
  f.install('https://watch.example');
  f.document.body = new Element('body');
  f.document.dispatchEvent(new Event('DOMContentLoaded'));
  assert.equal(f.roots.length, 1);
  assert.equal(f.links.length, 2);
  assert.deepEqual(
    f.links.map((link) => link.href),
    [
      'https://watch.example/import#v=1&bvid=BV1TESTaaaaa&part=2',
      'http://watch.example:8080/import#v=1&bvid=BV1TESTaaaaa&part=2',
    ],
  );
  for (const link of f.links) {
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
    assert.equal(link.referrerPolicy, 'no-referrer');
  }
});

test('links use the current SPA video and retain only canonical identifiers', () => {
  const f = fixture();
  f.install('https://watch.example');
  const link = f.links[0];
  for (const [path, fragment] of [
    [
      '/video/BV1TESTaaaab/?p=10000&spm_id_from=tracking&token=SYNTHETIC',
      'bvid=BV1TESTaaaab&part=10000',
    ],
    ['/video/BV1TESTaaaab/', 'bvid=BV1TESTaaaab&part=1'],
    [
      '/bangumi/play/ep9000000000011?from=tracking',
      'episodeId=9000000000011&part=1',
    ],
    ['/bangumi/play/ss9000000000021', 'seasonId=9000000000021&part=1'],
  ]) {
    f.navigate(`https://www.bilibili.com${path}`);
    const event = new Event('click', { cancelable: true });
    link.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    assert.equal(link.href, `https://watch.example/import#v=1&${fragment}`);
  }
});

test('unsupported routes and invalid or duplicate parts cannot launch a stale video', () => {
  const f = fixture();
  f.install('https://watch.example');
  const link = f.links[0];
  for (const path of [
    '/video/BV1TESTaaaab/?p=0',
    '/video/BV1TESTaaaab/?p=10001',
    '/video/BV1TESTaaaab/?p=2&p=3',
    '/video/BV1TESTaaaab/?p=1e2',
    '/video/BV0000000000',
    '/bangumi/play/ep0',
    '/bangumi/play/ss1234567890123456',
    '/video/BV1TESTaaaab/evil',
    '/account',
  ]) {
    f.navigate(`https://www.bilibili.com${path}`);
    const event = new Event('click', { cancelable: true });
    link.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true, path);
    assert.equal(link.href, undefined, path);
  }
  f.navigate('https://www.bilibili.com/bangumi/play/ep9000000000011');
  link.dispatchEvent(new Event('pointerdown'));
  assert.equal(
    link.href,
    'https://watch.example/import#v=1&episodeId=9000000000011&part=1',
  );
});

test('Bilibili never exposes the privileged playback bridge and frames stay inactive', () => {
  const f = fixture();
  f.install('https://watch.example');
  f.page.dispatchEvent(
    Object.assign(new Event('message'), {
      source: f.page,
      origin: 'https://www.bilibili.com',
      data: JSON.stringify({
        channel: 'ovs-bilibili-request',
        client: 'a'.repeat(32),
        id: 1,
        op: 'preview',
        bvid: 'BV1TESTaaaaa',
        part: 1,
      }),
    }),
  );
  assert.equal(f.network, 0);
  assert.equal(f.listeners.includes('message'), false);
  const framed = fixture({ frame: true });
  framed.install('https://watch.example');
  assert.equal(framed.roots.length, 0);
  assert.equal(framed.network, 0);
});
