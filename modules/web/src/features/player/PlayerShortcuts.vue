<script setup lang="ts">
import { onMounted, ref, useId } from 'vue';

import Icon from '../../components/Icon.vue';
import { vKeyboardBoundary } from '../../components/overlay-keyboard';
import { t } from '../../i18n';

defineProps<{ bilibili: boolean }>();
const emit = defineEmits<{ close: [] }>();
const titleId = useId();
const closeButton = ref<HTMLButtonElement>();
onMounted(() => closeButton.value?.focus({ preventScroll: true }));
</script>

<template>
  <section
    v-keyboard-boundary="() => emit('close')"
    class="player-shortcuts"
    role="dialog"
    :aria-labelledby="titleId"
    @click.stop
    @pointerdown.stop
    @pointermove.stop
    @focusin.stop
    @keydown.tab.prevent="closeButton?.focus({ preventScroll: true })"
  >
    <header>
      <strong :id="titleId">{{ t('player.keyboardHelp') }}</strong
      ><button
        ref="closeButton"
        type="button"
        class="icon-button quiet"
        :aria-label="t('player.closeKeyboardHelp')"
        @click="emit('close')"
      >
        <Icon name="close" :size="17" />
      </button>
    </header>
    <dl>
      <div>
        <dt>
          <kbd>{{ t('player.spaceKey') }}</kbd> / <kbd>K</kbd>
        </dt>
        <dd>{{ t('player.shortcutPlay') }}</dd>
      </div>
      <div>
        <dt><kbd>←</kbd> / <kbd>→</kbd></dt>
        <dd>{{ t('player.shortcutSeek') }}</dd>
      </div>
      <div>
        <dt><kbd>↑</kbd> / <kbd>↓</kbd></dt>
        <dd>{{ t('player.shortcutVolume') }}</dd>
      </div>
      <div>
        <dt><kbd>M</kbd></dt>
        <dd>{{ t('player.shortcutMute') }}</dd>
      </div>
      <div v-if="bilibili">
        <dt><kbd>D</kbd></dt>
        <dd>{{ t('player.shortcutDanmaku') }}</dd>
      </div>
      <div>
        <dt><kbd>S</kbd></dt>
        <dd>{{ t('player.shortcutWindowFullscreen') }}</dd>
      </div>
      <div>
        <dt><kbd>F</kbd></dt>
        <dd>{{ t('player.shortcutFullscreen') }}</dd>
      </div>
      <div>
        <dt><kbd>Shift + F10</kbd></dt>
        <dd>{{ t('player.shortcutContextMenu') }}</dd>
      </div>
      <div>
        <dt><kbd>Ctrl / ⌘ + K</kbd></dt>
        <dd>{{ t('player.shortcutQuickActions') }}</dd>
      </div>
      <div>
        <dt><kbd>Esc</kbd></dt>
        <dd>{{ t('player.shortcutClose') }}</dd>
      </div>
    </dl>
  </section>
</template>

<style scoped>
.player-shortcuts {
  position: absolute;
  z-index: 8;
  top: 12px;
  left: 12px;
  width: min(400px, calc(100% - 24px));
  max-height: calc(100% - 24px);
  overflow: auto;
  overscroll-behavior: contain;
  padding: 0 14px 12px;
  border: 1px solid #ffffff26;
  border-radius: 10px;
  background: #10141af5;
  color: #f0f2f5;
  font-size: 0.76rem;
}
header {
  position: sticky;
  top: 0;
  background: #10141a;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 45px;
}
header strong {
  font-size: 0.86rem;
}
header button {
  width: 28px;
  min-height: 28px;
  padding: 4px;
  color: inherit;
}
dl {
  margin: 2px 0;
}
dl > div {
  display: grid;
  grid-template-columns: minmax(110px, 0.9fr) minmax(0, 1.3fr);
  gap: 10px;
  padding: 5px 0;
}
dd {
  margin: 0;
  color: #b5becb;
}
kbd {
  font-family: inherit;
  font-size: 0.7rem;
}
</style>
