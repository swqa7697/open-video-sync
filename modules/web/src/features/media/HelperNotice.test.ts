import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, expect, test, vi } from 'vite-plus/test';

import { i18n } from '../../i18n';
import HelperNotice from './HelperNotice.vue';

const { handshake } = vi.hoisted(() => ({ handshake: vi.fn() }));
vi.mock('../../player/bilibili/bridge', async (importOriginal) => {
  const bridge =
    await importOriginal<typeof import('../../player/bilibili/bridge')>();
  return {
    ...bridge,
    helperRelease: { version: '1.2.0', protocol: 1, build: 'a'.repeat(64) },
    HelperBridge: class {
      handshake = handshake;
      close() {}
    },
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  i18n.global.locale.value = 'en';
});

test.each([
  { helper: '1.1.0' },
  { helper: '1.2.0' },
  { helper: '1.2.0', build: 'b'.repeat(64) },
])(
  'an outdated helper notice handles $helper/$build and clears after an update',
  async (installed) => {
    let deployedBuild = 'a'.repeat(64);
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            version: '1.2.0',
            protocol: 1,
            build: deployedBuild,
          }),
        ),
    );
    handshake.mockResolvedValue({
      ...installed,
      version: 1,
      maxChunk: 262144,
    });
    i18n.global.locale.value = 'zh-CN';
    const wrapper = mount(HelperNotice, {
      global: {
        stubs: {
          Modal: { template: '<div role="dialog"><slot /></div>' },
          ToastNotice: { template: '<div><slot /></div>' },
        },
      },
    });
    try {
      await flushPromises();
      expect(wrapper.get('[role="dialog"]').text()).toContain(
        'OVS 播放助手需要更新',
      );
      expect(wrapper.get('[role="dialog"]').text()).toContain(
        `已安装 ${installed.helper} · 需要 1.2.0`,
      );
      expect(wrapper.get('aside a').text()).toBe('更新助手');
      const checks = handshake.mock.calls.length;
      i18n.global.locale.value = 'en';
      await flushPromises();
      expect(wrapper.get('[role="dialog"]').text()).toContain(
        'needs an update',
      );
      expect(wrapper.get('[role="dialog"]').text()).toContain(
        `Installed ${installed.helper} · Required 1.2.0`,
      );
      expect(wrapper.get('aside a').text()).toBe('Update helper');
      expect(handshake.mock.calls).toHaveLength(checks);
      handshake.mockResolvedValue({
        helper: '1.2.0',
        version: 1,
        maxChunk: 262144,
        build: 'a'.repeat(64),
      });
      // Focus probing can detect an already active replacement script. Installation itself
      // offers Reload because a newly installed userscript needs document startup.
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
      expect(wrapper.find('aside').exists()).toBe(false);
      expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
      expect(wrapper.emitted('ready')).toHaveLength(1);
      deployedBuild = 'c'.repeat(64);
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
      expect(wrapper.get('aside').text()).toContain('OVS has been updated');
      expect(wrapper.get('aside button').text()).toBe('Refresh application');
      expect(wrapper.find('aside a').exists()).toBe(false);
    } finally {
      wrapper.unmount();
    }
  },
);
