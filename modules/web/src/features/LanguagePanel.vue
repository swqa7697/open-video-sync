<script setup lang="ts">
import FormFeedback from '../components/FormFeedback.vue';
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
    <FormFeedback
      :text="t(language.saved ? 'language.saved' : 'appearance.unsaved')"
    />
  </div>
</template>
