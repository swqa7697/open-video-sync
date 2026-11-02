import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite-plus';

import { readBuildInfo, readVersions } from '../../scripts/versions.mjs';
import { developmentHelper, developmentProxy } from './dev-server';

export default defineConfig({
  plugins: [
    vue(),
    developmentHelper(),
    {
      name: 'ovs-web-version',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'release.json',
          source: JSON.stringify({
            version: readVersions().web,
            ...readBuildInfo(),
          }),
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
      '/api': developmentProxy(),
      '/ws': developmentProxy(true),
      '/health': 'http://127.0.0.1:8080',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    plugins: ['typescript', 'vue', 'import'],
    categories: { correctness: 'error' },
    rules: {
      'import/newline-after-import': ['error', { considerComments: true }],
      'vite-plus/prefer-vite-plus-imports': 'error',
      'typescript/no-explicit-any': 'error',
    },
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts', 'dev-server.test.ts', 'build-info.test.ts'],
    restoreMocks: true,
    clearMocks: true,
  },
});
