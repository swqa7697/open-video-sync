import { mount } from '@vue/test-utils';
import { afterEach, expect, test, vi } from 'vite-plus/test';
import { nextTick } from 'vue';
import { i18n } from '../i18n';
import HomeIntro from './HomeIntro.vue';

afterEach(() => {
  i18n.global.locale.value = 'en';
});

test('keeps a greeting through language changes and chooses again on the next home visit', async () => {
  const random = vi.spyOn(Math, 'random').mockReturnValue(0);
  const home = mount(HomeIntro);
  const greeting = home.get('h1').text();
  const hint = home.get('p').text();
  random.mockReturnValue(0.99);

  i18n.global.locale.value = 'zh-CN';
  await nextTick();
  expect(home.get('h1').text()).not.toBe(greeting);
  expect(home.get('p').text()).not.toBe(hint);
  i18n.global.locale.value = 'en';
  await nextTick();
  expect(home.get('h1').text()).toBe(greeting);
  home.unmount();

  const nextHome = mount(HomeIntro);
  expect(nextHome.get('h1').text()).not.toBe(greeting);
  nextHome.unmount();
});
