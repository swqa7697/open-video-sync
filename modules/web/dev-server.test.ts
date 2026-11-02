// @vitest-environment node
import type { IncomingHttpHeaders } from 'node:http';
import {
  createServer as createHTTPServer,
  request as httpRequest,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import { createServer, type ViteDevServer } from 'vite-plus';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';

import config from './vite.config';

const backend = createHTTPServer((request, response) => {
  response.end(request.headers.origin ?? '');
});
backend.on('upgrade', (request, socket) => {
  socket.end(
    `HTTP/1.1 403 Forbidden\r\nX-Observed-Origin: ${request.headers.origin}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
  );
});
let server: ViteDevServer;

beforeAll(async () => {
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const target = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  const proxy = Object.fromEntries(
    Object.entries(config.server!.proxy!).map(([path, options]) => [
      path,
      typeof options === 'string' ? target : { ...options, target },
    ]),
  );
  server = await createServer({
    ...config,
    configFile: false,
    logLevel: 'silent',
    appType: 'custom',
    server: {
      ...config.server,
      host: '127.0.0.1',
      port: 0,
      strictPort: false,
      watch: null,
      ws: false,
      proxy,
    },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
});
afterAll(async () => {
  await server?.close();
  await new Promise<void>((resolve, reject) =>
    backend.close((error) => (error ? reject(error) : resolve())),
  );
});

function request(
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: (server.httpServer!.address() as AddressInfo).port,
        path,
        method,
        headers: { Host: '127.0.0.1:5173', ...headers },
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (body += chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body,
          }),
        );
        response.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function probe(script: string, origin: string): Promise<unknown[]> {
  type Event = { source: unknown; origin: string; data: string };
  const listeners: ((event: Event) => Promise<void>)[] = [];
  const replies: unknown[] = [];
  const page = {
    get self() {
      return this;
    },
    get top() {
      return this;
    },
    addEventListener(name: string, listener: (event: Event) => Promise<void>) {
      if (name === 'message') listeners.push(listener);
    },
    postMessage(raw: string, target: string) {
      expect(target).toBe(origin);
      replies.push(JSON.parse(raw));
    },
  };
  runInNewContext(script, {
    window: page,
    unsafeWindow: page,
    location: { origin },
    TextEncoder,
    performance,
  });
  const event = {
    source: page,
    origin,
    data: JSON.stringify({
      channel: 'ovs-bilibili-request',
      client: 'a'.repeat(32),
      id: 1,
      op: 'probe',
      version: 1,
    }),
  };
  await Promise.all(listeners.map((listener) => listener(event)));
  return replies;
}

test.each(['127.0.0.1', 'localhost'])(
  'the helper downloaded through %s activates only on that development origin',
  async (host) => {
    const origin = `http://${host}:5173`;
    const headers = { Host: `${host}:5173` };
    const script = await request('/userscripts/ovs-bilibili.user.js', headers);
    const release = await request(
      '/userscripts/ovs-bilibili.version.json',
      headers,
    );
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toContain('application/javascript');
    expect(script.headers['cache-control']).toBe('no-store');
    expect(release.status).toBe(200);
    expect(release.headers['content-type']).toContain('application/json');
    expect(release.headers['cache-control']).toBe('no-store');
    const metadata = JSON.parse(release.body) as {
      version: string;
      protocol: number;
      build: string;
    };
    expect(await probe(script.body, origin)).toMatchObject([
      {
        ok: true,
        value: {
          helper: metadata.version,
          version: metadata.protocol,
          build: metadata.build,
        },
      },
    ]);
    for (const other of [
      'http://127.0.0.1:8080',
      'http://localhost:8080',
      'https://localhost:5173',
      `http://${host === 'localhost' ? '127.0.0.1' : 'localhost'}:5173`,
    ])
      expect(await probe(script.body, other)).toEqual([]);
    const head = await request(
      '/userscripts/ovs-bilibili.user.js',
      headers,
      'HEAD',
    );
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  },
);

test('helper delivery rejects unknown hosts, routes, and mutations', async () => {
  expect(
    (
      await request('/userscripts/ovs-bilibili.user.js', {
        Host: '127.0.0.2:5173',
      })
    ).status,
  ).toBe(403);
  expect((await request('/userscripts/unknown')).status).toBe(404);
  const mutation = await request(
    '/userscripts/ovs-bilibili.user.js',
    {},
    'POST',
  );
  expect(mutation.status).toBe(405);
  expect(mutation.headers.allow).toBe('GET, HEAD');
});

test('HTTP and WebSocket proxies map only the two allowed development origins', async () => {
  for (const origin of [
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://localhost:5174',
    'https://localhost:5173',
    'https://foreign.invalid',
  ]) {
    const expected = [
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ].includes(origin)
      ? 'http://127.0.0.1:8080'
      : origin;
    const http = await request('/api/v2/session', { Origin: origin }, 'POST');
    expect(http.body).toBe(expected);
    const websocket = await request('/ws/v2/rooms/test', {
      Origin: origin,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    });
    expect(websocket.headers['x-observed-origin']).toBe(expected);
  }
});
