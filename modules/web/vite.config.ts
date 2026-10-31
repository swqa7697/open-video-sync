import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite-plus';
import { readVersions } from '../../scripts/versions.mjs';

export default defineConfig({
  plugins: [
    vue(),
    {
      name: 'ovs-web-version',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'release.json',
          source: JSON.stringify({ version: readVersions().web }),
        });
      },
      transformIndexHtml() {
        return [
          {
            tag: 'meta',
            attrs: { name: 'ovs-web-version', content: readVersions().web },
            injectTo: 'head',
          },
        ];
      },
    },
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (outgoing, incoming) => {
            if (incoming.headers.origin === 'http://127.0.0.1:5173')
              outgoing.setHeader('Origin', 'http://127.0.0.1:8080');
          });
        },
      },
      '/ws': {
        target: 'ws://127.0.0.1:8080',
        ws: true,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReqWs', (outgoing, incoming) => {
            if (incoming.headers.origin === 'http://127.0.0.1:5173')
              outgoing.setHeader('Origin', 'http://127.0.0.1:8080');
          });
        },
      },
      '/health': 'http://127.0.0.1:8080',
      '/userscripts': 'http://127.0.0.1:8080',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    plugins: ['typescript', 'vue'],
    categories: { correctness: 'error' },
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      'typescript/no-explicit-any': 'error',
    },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
