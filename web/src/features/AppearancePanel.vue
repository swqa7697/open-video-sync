<script setup lang="ts">
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
    <p class="hint">
      Make this space your own. Changes apply only to this browser.
    </p>
    <fieldset class="appearance-options">
      <legend>Color mode</legend>
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
            ><Icon :name="option.icon" /><span>{{ option.label }}</span></span
          >
        </label>
      </div>
      <p class="hint">System follows your device’s light or dark setting.</p>
    </fieldset>
    <fieldset class="appearance-options">
      <legend>Accent color</legend>
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
            <span>{{ option.label }}</span>
          </span>
        </label>
      </div>
    </fieldset>
    <p class="hint" role="status">
      {{
        appearance.saved
          ? 'Your preferences are saved on this device.'
          : 'Browser storage is unavailable. Changes last until you reload this page.'
      }}
    </p>
  </div>
</template>
