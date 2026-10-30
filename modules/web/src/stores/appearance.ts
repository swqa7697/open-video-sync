import { defineStore } from 'pinia';
import { ref } from 'vue';

export const appearanceModes = [
  { value: 'system', label: 'System', icon: 'screen' },
  { value: 'light', label: 'Light', icon: 'sun' },
  { value: 'dark', label: 'Dark', icon: 'moon' },
] as const;
export const appearanceAccents = [
  { value: 'slate', label: 'Slate blue' },
  { value: 'iris', label: 'Soft iris' },
  { value: 'neutral', label: 'Graphite' },
] as const;
type Mode = (typeof appearanceModes)[number]['value'];
type Accent = (typeof appearanceAccents)[number]['value'];

export const useAppearanceStore = defineStore('appearance', () => {
  const root = document.documentElement;
  const mode = ref<Mode>(
    appearanceModes.find((option) => option.value === root.dataset.mode)
      ?.value ?? 'system'
  );
  const accent = ref<Accent>(
    appearanceAccents.find((option) => option.value === root.dataset.accent)
      ?.value ?? 'slate'
  );
  const saved = ref(true);

  function apply(): void {
    root.dataset.mode = mode.value;
    root.dataset.accent = accent.value;
    try {
      localStorage.setItem(
        'ovs.appearance',
        JSON.stringify({ mode: mode.value, accent: accent.value })
      );
      saved.value = true;
    } catch {
      saved.value = false;
    }
  }
  function setMode(value: Mode): void {
    mode.value = value;
    apply();
  }
  function setAccent(value: Accent): void {
    accent.value = value;
    apply();
  }
  return { mode, accent, saved, setMode, setAccent };
});
