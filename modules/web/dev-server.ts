import { readFile } from 'node:fs/promises';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { Plugin, ProxyOptions } from 'vite-plus';

const backendOrigin = 'http://127.0.0.1:8080';
const developmentOrigins = new Set([
  'http://127.0.0.1:5173',
  'http://localhost:5173',
]);

export function developmentProxy(websocket = false): ProxyOptions {
  return {
    target: backendOrigin,
    changeOrigin: true,
    ws: websocket,
    configure(proxy) {
      const rewrite = (outgoing: ClientRequest, incoming: IncomingMessage) => {
        if (developmentOrigins.has(incoming.headers.origin ?? ''))
          outgoing.setHeader('Origin', backendOrigin);
      };
      proxy.on('proxyReq', rewrite);
      proxy.on('proxyReqWs', rewrite);
    },
  };
}

export function developmentHelper(): Plugin {
  return {
    name: 'ovs-development-helper',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split('?')[0];
        if (!path?.startsWith('/userscripts/')) return next();
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        const origin = `http://${request.headers.host}`;
        if (!developmentOrigins.has(origin)) {
          response.writeHead(403).end();
          return;
        }
        const script = path === '/userscripts/ovs-bilibili.user.js';
        if (!script && path !== '/userscripts/ovs-bilibili.version.json') {
          response.writeHead(404).end();
          return;
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.writeHead(405, { Allow: 'GET, HEAD' }).end();
          return;
        }
        try {
          let body = await readFile(
            new URL(
              script
                ? '../helper/dist/helper.user.js'
                : '../helper/dist/release.json',
              import.meta.url,
            ),
            'utf8',
          );
          if (script)
            body = body
              .replaceAll("'{{ORIGIN}}'", JSON.stringify(origin))
              .replaceAll('{{ORIGIN}}', origin)
              .replaceAll('{{MATCH}}', `http://${new URL(origin).hostname}/*`);
          response.setHeader(
            'Content-Type',
            `${script ? 'application/javascript' : 'application/json'}; charset=utf-8`,
          );
          response.end(request.method === 'HEAD' ? undefined : body);
        } catch {
          response
            .writeHead(503)
            .end('Helper build unavailable. Run make helper-build.');
        }
      });
    },
  };
}
