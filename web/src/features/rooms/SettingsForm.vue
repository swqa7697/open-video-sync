<script setup lang="ts">
import type { RoomSettings } from '../../transport/contracts';
const settings = defineModel<RoomSettings>({ required: true });
defineProps<{ disabled: boolean }>();
</script>
<template>
  <fieldset :disabled="disabled">
    <legend>Room preferences</legend>
    <div class="settings-grid">
      <label
        >Playback controls<select v-model="settings.controllers">
          <option value="host">Host only</option>
          <option value="everyone">Everyone</option>
        </select></label
      >
      <label
        >Drift correction<select v-model="settings.syncMode">
          <option value="adaptive">Adaptive</option>
          <option value="seek">Seek</option>
        </select></label
      >
      <label
        >Wait for participants<select v-model="settings.waitMode">
          <option value="all">All participants</option>
          <option value="none">Do not wait</option>
        </select></label
      >
      <label
        >Late joining<select v-model="settings.lateJoin">
          <option value="catch_up">Catch up</option>
          <option value="wait_at_next_play">Wait at next play</option>
        </select></label
      >
      <label
        >Wait timeout (ms)<input
          v-model.number="settings.waitTimeoutMs"
          type="number"
          min="5000"
          max="120000"
          required
      /></label>
      <label
        >Soft drift (ms)<input
          v-model.number="settings.softDriftMs"
          type="number"
          min="50"
          max="500"
          required
      /></label>
      <label
        >Hard drift (ms)<input
          v-model.number="settings.hardDriftMs"
          type="number"
          min="250"
          max="2000"
          required
      /></label>
    </div>
    <label class="checkbox"
      ><input v-model="settings.waitOnBuffering" type="checkbox" /> Wait when a participant
      buffers</label
    >
    <p class="hint">
      Startup waiting and drift correction are available. Buffering and late-join policies remain in
      development.
    </p>
  </fieldset>
</template>
