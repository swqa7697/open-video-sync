<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from 'vue';
import { t } from '../i18n';
import Icon from '../components/Icon.vue';
import Modal from '../components/Modal.vue';
import { vKeyboardBoundary } from '../components/overlay-keyboard';
import AppearancePanel from './AppearancePanel.vue';
import LanguagePanel from './LanguagePanel.vue';
import AboutPanel from './AboutPanel.vue';
import NotificationPanel from './NotificationPanel.vue';

const menuId = useId();
const menu = ref<HTMLElement>();
const trigger = ref<HTMLButtonElement>();
const menuOpen = ref(false);
const panel = ref<'appearance' | 'language' | 'notifications' | 'about'>();
const options = [
  { value: 'appearance', label: 'common.appearance', icon: 'appearance' },
  { value: 'language', label: 'common.language', icon: 'language' },
  { value: 'notifications', label: 'common.notifications', icon: 'bell' },
  { value: 'about', label: 'common.about', icon: 'info' },
] as const;
const title = computed(() =>
  t(options.find((option) => option.value === panel.value)!.label)
);

function positionMenu(): void {
  const bounds = trigger.value?.getBoundingClientRect();
  if (!bounds || !menu.value) return;
  menu.value.style.top = `${bounds.bottom + 8}px`;
  menu.value.style.right = `${Math.max(12, innerWidth - bounds.right)}px`;
}
function closeMenu(): void {
  menu.value?.hidePopover();
}
function dismissMenu(): void {
  closeMenu();
  trigger.value?.focus({ preventScroll: true });
}
function openMenu(last = false): void {
  menu.value?.showPopover();
  const items = menu.value?.querySelectorAll<HTMLButtonElement>('button');
  items?.[last ? items.length - 1 : 0]?.focus();
}
function navigate(event: KeyboardEvent): void {
  const items = Array.from(menu.value?.querySelectorAll('button') ?? []);
  const index = items.indexOf(document.activeElement as HTMLButtonElement);
  let next: number;
  switch (event.key) {
    case 'ArrowDown':
      next = (index + 1) % items.length;
      break;
    case 'ArrowUp':
      next = (index + items.length - 1) % items.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = items.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  items[next]?.focus();
}
function focusChanged(event: FocusEvent): void {
  if (
    event.relatedTarget instanceof Node &&
    !menu.value?.contains(event.relatedTarget) &&
    event.relatedTarget !== trigger.value
  )
    closeMenu();
}
function select(value: typeof panel.value): void {
  closeMenu();
  trigger.value?.focus();
  panel.value = value;
}
function openPanel(value: NonNullable<typeof panel.value>): void {
  closeMenu();
  panel.value = value;
}
defineExpose({ openPanel });
onMounted(() => window.addEventListener('resize', closeMenu));
onUnmounted(() => window.removeEventListener('resize', closeMenu));
</script>

<template>
  <button
    ref="trigger"
    class="quiet icon-button app-settings-trigger"
    :aria-label="t('common.appSettings')"
    :title="t('common.appSettings')"
    aria-haspopup="menu"
    :aria-expanded="menuOpen"
    :aria-controls="menuId"
    :popovertarget="menuId"
    @keydown.down.prevent="openMenu()"
    @keydown.up.prevent="openMenu(true)"
  >
    <Icon name="settings" />
  </button>
  <div
    :id="menuId"
    ref="menu"
    v-keyboard-boundary="dismissMenu"
    popover
    role="menu"
    class="app-menu"
    :aria-label="t('common.appSettings')"
    @beforetoggle="positionMenu"
    @toggle="menuOpen = menu?.matches(':popover-open') ?? false"
    @keydown="navigate"
    @focusout="focusChanged"
  >
    <button
      v-for="(option, index) in options"
      :key="option.value"
      type="button"
      role="menuitem"
      tabindex="-1"
      class="quiet"
      :autofocus="index === 0"
      @click="select(option.value)"
    >
      <Icon :name="option.icon" /><span>{{ t(option.label) }}</span
      ><Icon name="arrow" :size="16" class="menu-arrow" />
    </button>
  </div>
  <Modal v-if="panel" :title="title" @close="panel = undefined">
    <AppearancePanel v-if="panel === 'appearance'" />
    <LanguagePanel v-else-if="panel === 'language'" />
    <NotificationPanel v-else-if="panel === 'notifications'" />
    <AboutPanel v-else />
  </Modal>
</template>
