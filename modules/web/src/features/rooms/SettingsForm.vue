<script setup lang="ts">
import { t } from '../../i18n';
import type { RoomSettings } from '../../transport/contracts';

const settings = defineModel<RoomSettings>({ required: true });
defineProps<{ disabled: boolean }>();
</script>
<template>
  <fieldset :disabled="disabled">
    <legend>{{ t('settings.preferences') }}</legend>
    <label class="checkbox"
      ><input
        id="playback-controls"
        v-model="settings.everyoneCanControl"
        type="checkbox"
      />{{ t('settings.controls') }}</label
    >
    <label class="checkbox"
      ><input
        id="media-controls"
        v-model="settings.everyoneCanSelectMedia"
        type="checkbox"
      />{{ t('settings.mediaControls') }}</label
    >
    <label class="checkbox"
      ><input v-model="settings.waitForAll" type="checkbox" />{{
        t('settings.wait')
      }}</label
    >
    <p class="hint">{{ t('settings.waitHint') }}</p>
  </fieldset>
</template>
