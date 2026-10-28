<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useConnectionStore } from './stores/connection';

const connection = useConnectionStore();
const controller = new AbortController();
onMounted(() => connection.checkReadiness(controller.signal));
onUnmounted(() => controller.abort());
</script>

<template>
  <main>
    <p class="eyebrow">Development template</p>
    <h1>Open Video Sync</h1>
    <p>A foundation for private, synchronized viewing.</p>
    <p role="status">Server: {{ connection.status }}</p>
    <section aria-labelledby="scope">
      <h2 id="scope">Application framework</h2>
      <p>The application serves this Vue shell from Go and initializes a local SQLite database.</p>
      <p>Identity, rooms, playback, Bilibili, and danmaku are not implemented.</p>
      <p>Each participant will use their own media. OVS will carry control state only.</p>
    </section>
  </main>
</template>
