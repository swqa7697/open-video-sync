<script setup lang="ts">
import { t } from '../../i18n';
import type { RoomSettings } from '../../transport/contracts';

const settings = defineModel<RoomSettings>({ required: true });
defineProps<{ disabled: boolean }>();
</script>
<template>
  <fieldset :disabled="disabled">
    <legend>{{ t('settings.preferences') }}</legend>
    <label for="playback-controls">{{ t('settings.controls') }}</label>
    <select id="playback-controls" v-model="settings.controllers">
      <option value="host">{{ t('settings.hostOnly') }}</option>
      <option value="everyone">{{ t('settings.everyone') }}</option>
    </select>
    <label class="checkbox"
      ><input v-model="settings.waitForAll" type="checkbox" />{{
        t('settings.wait')
      }}</label
    >
    <p class="hint">{{ t('settings.waitHint') }}</p>
  </fieldset>
</template>
