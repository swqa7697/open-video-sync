import { defineStore } from 'pinia';
import { ref } from 'vue';

export const appearanceModes = [
  { value: 'dark', label: 'appearance.dark', icon: 'moon' },
  { value: 'light', label: 'appearance.light', icon: 'sun' },
] as const;
export const appearanceAccents = [
  { value: 'slate', label: 'appearance.slate' },
  { value: 'iris', label: 'appearance.iris' },
  { value: 'neutral', label: 'appearance.neutral' },
  { value: 'teal', label: 'appearance.teal' },
  { value: 'sage', label: 'appearance.sage' },
  { value: 'rose', label: 'appearance.rose' },
  { value: 'amber', label: 'appearance.amber' },
  { value: 'ocean', label: 'appearance.ocean' },
  { value: 'clay', label: 'appearance.clay' },
] as const;
type Mode = (typeof appearanceModes)[number]['value'];
type Accent = (typeof appearanceAccents)[number]['value'];

export const useAppearanceStore = defineStore('appearance', () => {
  const root = document.documentElement;
  const mode = ref<Mode>(
    appearanceModes.find((option) => option.value === root.dataset.mode)
      ?.value ?? 'dark',
  );
  const accent = ref<Accent>(
    appearanceAccents.find((option) => option.value === root.dataset.accent)
      ?.value ?? 'slate',
  );
  const saved = ref(true);

  function apply(): void {
    root.dataset.mode = mode.value;
    root.dataset.accent = accent.value;
    try {
      localStorage.setItem(
        'ovs.appearance',
        JSON.stringify({ mode: mode.value, accent: accent.value }),
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
