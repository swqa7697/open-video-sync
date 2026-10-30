<script setup lang="ts">
import type { RoomSettings } from '../../transport/contracts';
const settings = defineModel<RoomSettings>({ required: true });
defineProps<{ disabled: boolean }>();
</script>
<template>
  <fieldset :disabled="disabled">
    <legend>Room preferences</legend>
    <label for="playback-controls">Playback controls</label>
    <select id="playback-controls" v-model="settings.controllers">
      <option value="host">Host only</option>
      <option value="everyone">Everyone</option>
    </select>
    <label class="checkbox"
      ><input v-model="settings.waitForAll" type="checkbox" />Wait for
      everyone</label
    >
    <p class="hint">
      Wait for everyone to load media and recover from buffering. Changing this
      preference pauses the room.
    </p>
  </fieldset>
</template>
