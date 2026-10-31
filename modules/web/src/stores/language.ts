import { defineStore } from 'pinia';
import { ref } from 'vue';
import { i18n, t, type Locale } from '../i18n';

export const languageOptions = ['system', 'zh-CN', 'en'] as const;
export type LanguagePreference = (typeof languageOptions)[number];
const storageKey = 'ovs.language';

function preference(value: unknown): LanguagePreference {
  return languageOptions.find((option) => option === value) ?? 'system';
}
function systemLocale(): Locale {
  const language = navigator.languages[0] ?? navigator.language;
  return /^zh(?:-|$)/i.test(language) ? 'zh-CN' : 'en';
}

export const useLanguageStore = defineStore('language', () => {
  const selected = ref<LanguagePreference>('system');
  const saved = ref(true);
  try {
    selected.value = preference(localStorage.getItem(storageKey));
  } catch {
    saved.value = false;
  }

  function apply(): void {
    const locale =
      selected.value === 'system' ? systemLocale() : selected.value;
    i18n.global.locale.value = locale;
    document.documentElement.lang = locale;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', t('app.description'));
  }
  function setLanguage(value: LanguagePreference): void {
    selected.value = value;
    apply();
    try {
      localStorage.setItem(storageKey, value);
      saved.value = true;
    } catch {
      saved.value = false;
    }
  }
  function storageChanged(event: StorageEvent): void {
    if (event.key === storageKey || event.key === null) {
      selected.value = preference(event.newValue);
      apply();
    }
  }
  // The application owns these listeners and releases them on unmount.
  function listen(): () => void {
    window.addEventListener('languagechange', apply);
    window.addEventListener('storage', storageChanged);
    return () => {
      window.removeEventListener('languagechange', apply);
      window.removeEventListener('storage', storageChanged);
    };
  }
  apply();
  return { selected, saved, setLanguage, listen };
});
