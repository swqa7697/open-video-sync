import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [vue()],
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
    },
  },
  build: {
    outDir: '../internal/web/dist',
    emptyOutDir: true,
  },
  fmt: { singleQuote: true, semi: true },
  lint: {
    plugins: ['typescript', 'vue'],
    categories: { correctness: 'error' },
    rules: { 'typescript/no-explicit-any': 'error' },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
