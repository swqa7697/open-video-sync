<script setup lang="ts">
import { t } from '../i18n';
import {
  notificationPositions,
  useNotificationStore,
} from '../stores/notifications';

const notifications = useNotificationStore();
</script>
<template>
  <p class="hint">{{ t('notifications.hint') }}</p>
  <fieldset class="appearance-options">
    <legend>{{ t('notifications.position') }}</legend>
    <div class="appearance-grid">
      <label
        v-for="value in notificationPositions"
        :key="value"
        class="appearance-choice"
      >
        <input
          type="radio"
          name="notification-position"
          :value="value"
          :checked="notifications.position === value"
          @change="notifications.setPosition(value)"
        />
        <span class="appearance-tile">{{ t(`notifications.${value}`) }}</span>
      </label>
    </div>
  </fieldset>
  <p class="hint" role="status">
    {{ t(notifications.saved ? 'appearance.saved' : 'appearance.unsaved') }}
  </p>
</template>
