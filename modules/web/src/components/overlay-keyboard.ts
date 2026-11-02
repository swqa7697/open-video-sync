import { onMounted, onUnmounted, type ObjectDirective } from 'vue';

const boundaries = new Map<HTMLElement, () => void>();

function topBoundary(): HTMLElement | undefined {
  return [...boundaries.keys()].reverse().find((element) => {
    if (!element.isConnected) return false;
    if (element instanceof HTMLDialogElement) return element.open;
    return !element.hasAttribute('popover') || element.matches(':popover-open');
  });
}

export function hasKeyboardOverlay(): boolean {
  return !!topBoundary();
}

export function dismissKeyboardOverlay(): void {
  const boundary = topBoundary();
  if (boundary) boundaries.get(boundary)?.();
}

function stop(event: Event): void {
  event.stopPropagation();
  if (!(event instanceof KeyboardEvent) || event.type !== 'keydown') return;
  if (event.key === 'Escape') {
    const handled = event.defaultPrevented;
    event.preventDefault();
    if (
      !handled &&
      !event.repeat &&
      !event.isComposing &&
      event.keyCode !== 229 &&
      event.currentTarget instanceof HTMLElement
    )
      boundaries.get(event.currentTarget)?.();
  } else if (
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === 'k'
  )
    event.preventDefault();
}

// Keep native editing, navigation, and button activation inside each surface.
export const vKeyboardBoundary: ObjectDirective<HTMLElement, () => void> = {
  mounted(element, binding) {
    boundaries.set(element, binding.value);
    for (const type of ['keydown', 'keypress', 'keyup'])
      element.addEventListener(type, stop);
  },
  updated(element, binding) {
    boundaries.set(element, binding.value);
  },
  unmounted(element) {
    boundaries.delete(element);
    for (const type of ['keydown', 'keypress', 'keyup'])
      element.removeEventListener(type, stop);
  },
};

export function useOverlayKeyboard(): void {
  const held = new Map<string, HTMLElement>();
  function keyboard(event: KeyboardEvent): void {
    const boundary = topBoundary();
    const inside = boundary && event.composedPath().includes(boundary);
    const key = event.code || event.key;
    const owner = held.get(key);
    if (event.type === 'keyup') held.delete(key);
    if (event.type === 'keydown') {
      document.documentElement.dataset.input = 'keyboard';
      if (boundary && !owner) held.set(key, boundary);
    }
    // A closing key can repeat or be released after focus returns underneath.
    if ((boundary && !inside) || (owner && owner !== boundary)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (owner && owner !== boundary) return;
    }
    if (
      !boundary ||
      inside ||
      event.type !== 'keydown' ||
      event.key !== 'Escape'
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!event.repeat && !event.isComposing && event.keyCode !== 229)
      boundaries.get(boundary)?.();
  }
  function blur(): void {
    held.clear();
  }
  onMounted(() => {
    for (const type of ['keydown', 'keypress', 'keyup'] as const)
      document.addEventListener(type, keyboard, true);
    window.addEventListener('blur', blur);
  });
  onUnmounted(() => {
    for (const type of ['keydown', 'keypress', 'keyup'] as const)
      document.removeEventListener(type, keyboard, true);
    window.removeEventListener('blur', blur);
    held.clear();
  });
}
