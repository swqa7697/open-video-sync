<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue';

import { t } from '../i18n';
import Icon from './Icon.vue';
import { vKeyboardBoundary } from './overlay-keyboard';

const props = withDefaults(
  defineProps<{
    text: string;
    tone?: 'hint' | 'success' | 'error';
    announce?: boolean;
    reserve?: boolean;
  }>(),
  { tone: 'hint', announce: true, reserve: false },
);
const expanded = ref(false),
  overflowing = ref(false),
  summary = ref<HTMLElement>(),
  toggle = ref<HTMLButtonElement>(),
  details = ref<HTMLElement>(),
  closeButton = ref<HTMLButtonElement>();
const detailsId = useId();
let observer: ResizeObserver | undefined;
let disposed = false;
function measure(): void {
  if (disposed || !summary.value) return;
  overflowing.value = summary.value.scrollWidth > summary.value.clientWidth + 1;
  if (
    !overflowing.value &&
    !expanded.value &&
    document.activeElement === toggle.value
  )
    summary.value.focus({ preventScroll: true });
}
function positionDetails(): void {
  const element = details.value,
    anchor = toggle.value;
  if (!element || !anchor || !element.matches(':popover-open')) return;
  const bounds = anchor.getBoundingClientRect();
  element.style.left = `${Math.max(12, Math.min(bounds.right - element.offsetWidth, innerWidth - element.offsetWidth - 12))}px`;
  const below = bounds.bottom + 8;
  element.style.top = `${Math.max(12, Math.min(below + element.offsetHeight <= innerHeight - 12 ? below : bounds.top - element.offsetHeight - 8, innerHeight - element.offsetHeight - 12))}px`;
}
function closeDetails(restore = true): void {
  const focused = details.value?.contains(document.activeElement);
  details.value?.hidePopover();
  expanded.value = false;
  if (restore && focused)
    (overflowing.value ? toggle.value : summary.value)?.focus({
      preventScroll: true,
    });
}
async function toggleDetails(): Promise<void> {
  if (expanded.value) {
    closeDetails();
    return;
  }
  expanded.value = true;
  await nextTick();
  if (disposed || !expanded.value) return;
  details.value?.showPopover();
  positionDetails();
  closeButton.value?.focus({ preventScroll: true });
}
function syncPopover(): void {
  if (details.value && !details.value.matches(':popover-open'))
    expanded.value = false;
}
function resize(): void {
  measure();
  positionDetails();
}
watch(
  () => props.text,
  async () => {
    closeDetails();
    await nextTick();
    measure();
  },
  { flush: 'post' },
);
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(resize);
    if (summary.value) observer.observe(summary.value);
  }
  window.addEventListener('resize', resize);
  measure();
  void document.fonts?.ready.then(resize);
});
onUnmounted(() => {
  disposed = true;
  observer?.disconnect();
  window.removeEventListener('resize', resize);
});
</script>
<template>
  <div
    v-show="text || reserve"
    class="form-feedback"
    :class="`feedback-${tone}`"
  >
    <div class="feedback-summary">
      <Icon
        v-if="text && tone !== 'hint'"
        :name="tone === 'success' ? 'check' : 'info'"
        :size="16"
      />
      <p
        ref="summary"
        class="feedback-text"
        tabindex="-1"
        :role="
          announce && text ? (tone === 'error' ? 'alert' : 'status') : undefined
        "
        aria-atomic="true"
      >
        {{ text }}
      </p>
      <button
        ref="toggle"
        type="button"
        class="quiet icon-button feedback-toggle"
        :class="{ 'feedback-toggle-hidden': !overflowing && !expanded }"
        :aria-hidden="(!overflowing && !expanded) || undefined"
        :tabindex="!overflowing && !expanded ? -1 : undefined"
        :aria-label="
          t(expanded ? 'common.collapseDetails' : 'common.expandDetails')
        "
        :aria-expanded="expanded"
        :aria-controls="detailsId"
        @click="toggleDetails"
      >
        <Icon name="chevron" :size="15" />
      </button>
    </div>
    <div
      v-if="expanded"
      :id="detailsId"
      ref="details"
      v-keyboard-boundary="closeDetails"
      popover="auto"
      class="feedback-details"
      role="region"
      :aria-label="t('common.details')"
      @toggle="syncPopover"
    >
      <div class="feedback-details-heading">
        <strong>{{ t('common.details') }}</strong
        ><button
          ref="closeButton"
          type="button"
          class="quiet icon-button"
          :aria-label="t('common.collapseDetails')"
          @click="closeDetails()"
        >
          <Icon name="close" :size="16" />
        </button>
      </div>
      <p>{{ text }}</p>
    </div>
  </div>
</template>
<style scoped>
.form-feedback {
  min-width: 0;
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.5;
  color: var(--muted);
}
.feedback-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
}
.feedback-summary > svg {
  flex-shrink: 0;
}
.feedback-success .feedback-summary > svg {
  color: var(--primary);
}
.feedback-error {
  color: var(--danger);
}
.feedback-text {
  flex: 1;
  min-width: 0;
  block-size: 1.5em;
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.feedback-toggle,
.feedback-details .icon-button {
  width: 32px;
  min-height: 32px;
  padding: 6px;
  flex-shrink: 0;
}
.feedback-toggle-hidden {
  visibility: hidden;
}
.feedback-details {
  position: fixed;
  inset: auto;
  width: min(360px, calc(100vw - 24px));
  max-height: min(360px, calc(100dvh - 24px));
  margin: 0;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 12px 40px var(--shadow);
  font-size: 0.85rem;
  overflow: auto;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  user-select: text;
}
.feedback-details-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 6px;
}
.feedback-details p {
  margin: 0;
}
</style>
