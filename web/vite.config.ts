import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:8080',
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
