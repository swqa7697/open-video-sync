<script setup lang="ts">
import { t } from '../i18n';

import Icon from '../components/Icon.vue';
import {
  appearanceModes,
  appearanceAccents,
  useAppearanceStore,
} from '../stores/appearance';

const appearance = useAppearanceStore();
</script>

<template>
  <div class="appearance-panel">
    <p class="hint">{{ t('appearance.hint') }}</p>
    <fieldset class="appearance-options">
      <legend>{{ t('appearance.mode') }}</legend>
      <div class="appearance-grid">
        <label
          v-for="option in appearanceModes"
          :key="option.value"
          class="appearance-choice"
        >
          <input
            type="radio"
            name="color-mode"
            :value="option.value"
            :checked="appearance.mode === option.value"
            @change="appearance.setMode(option.value)"
          />
          <span class="appearance-tile"
            ><Icon :name="option.icon" /><span>{{
              t(option.label)
            }}</span></span
          >
        </label>
      </div>
      <p class="hint">{{ t('appearance.systemHint') }}</p>
    </fieldset>
    <fieldset class="appearance-options">
      <legend>{{ t('appearance.accent') }}</legend>
      <div class="appearance-grid">
        <label
          v-for="option in appearanceAccents"
          :key="option.value"
          class="appearance-choice"
        >
          <input
            type="radio"
            name="accent-color"
            :value="option.value"
            :checked="appearance.accent === option.value"
            @change="appearance.setAccent(option.value)"
          />
          <span class="appearance-tile">
            <span class="accent-swatch" :data-accent="option.value"
              ><Icon
                v-if="appearance.accent === option.value"
                name="check"
                :size="16"
            /></span>
            <span>{{ t(option.label) }}</span>
          </span>
        </label>
      </div>
    </fieldset>
    <p class="hint" role="status">
      {{ appearance.saved ? t('appearance.saved') : t('appearance.unsaved') }}
    </p>
  </div>
</template>
