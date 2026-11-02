<script setup lang="ts">
import { t } from '../i18n';
import { languageOptions, useLanguageStore } from '../stores/language';

const language = useLanguageStore();
</script>

<template>
  <div class="language-panel">
    <p class="hint">{{ t('language.hint') }}</p>
    <fieldset class="appearance-options">
      <legend>{{ t('language.label') }}</legend>
      <div class="appearance-grid">
        <label
          v-for="option in languageOptions"
          :key="option"
          class="appearance-choice"
        >
          <input
            type="radio"
            name="language"
            :value="option"
            :checked="language.selected === option"
            @change="language.setLanguage(option)"
          />
          <span
            class="appearance-tile"
            :lang="option === 'system' ? undefined : option"
            >{{
              option === 'system'
                ? t('language.system')
                : option === 'zh-CN'
                  ? '简体中文'
                  : 'English'
            }}</span
          >
        </label>
      </div>
    </fieldset>
    <p class="hint" role="status">
      {{ language.saved ? t('language.saved') : t('appearance.unsaved') }}
    </p>
  </div>
</template>
