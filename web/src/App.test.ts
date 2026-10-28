import { createPinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import App from './App.vue';

afterEach(() => vi.unstubAllGlobals());

test.each([true, false])('shows server readiness (ready=%s)', async (ready) => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(null, { status: ready ? 200 : 503 })),
  );
  const wrapper = mount(App, { global: { plugins: [createPinia()] } });
  await flushPromises();
  expect(wrapper.get('[role="status"]').text()).toBe(`Server: ${ready ? 'ready' : 'unavailable'}`);
  wrapper.unmount();
});

test('aborts the health request when the shell is disposed', async () => {
  let requestSignal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, options: RequestInit) => {
      requestSignal = options.signal ?? undefined;
      return new Promise<Response>(() => {});
    }),
  );
  const wrapper = mount(App, { global: { plugins: [createPinia()] } });
  wrapper.unmount();
  expect(requestSignal?.aborted).toBe(true);
});
