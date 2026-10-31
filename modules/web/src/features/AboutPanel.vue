<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import { t } from '../i18n';
import Icon from '../components/Icon.vue';
import { object, request, shape } from '../transport/api';

const modules = ['sync', 'web', 'helper'] as const;
const versions = ref<Record<(typeof modules)[number], string>>();
const loading = ref(false);
let controller: AbortController | undefined;

function releaseVersion(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length > 64 ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value)
  )
    throw new Error('Invalid release version.');
  return value;
}
async function load(): Promise<void> {
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  const timeout = setTimeout(() => current.abort(), 5000);
  try {
    const value = object(
      await request('/version', 'GET', '', undefined, current.signal)
    );
    shape(value, [...modules]);
    const release = {
      sync: releaseVersion(value.sync),
      web: releaseVersion(value.web),
      helper: releaseVersion(value.helper),
    };
    if (!current.signal.aborted) versions.value = release;
  } catch {
    // Keep provider and network errors out of the interface.
  } finally {
    clearTimeout(timeout);
    if (controller === current) loading.value = false;
  }
}
onMounted(() => void load());
onUnmounted(() => {
  controller?.abort();
  controller = undefined;
});
</script>

<template>
  <div class="about-panel">
    <div class="about-brand">
      <span class="brand-mark"><Icon name="play" :size="18" /></span
      ><strong>Open Video Sync</strong>
    </div>
    <p class="hint">{{ t('about.hint') }}</p>
    <p v-if="loading" role="status" class="hint">{{ t('about.loading') }}</p>
    <dl v-else-if="versions" class="about-versions">
      <div v-for="name in modules" :key="name">
        <dt>{{ t(`about.${name}`) }}</dt>
        <dd>{{ versions[name] }}</dd>
      </div>
    </dl>
    <div v-else class="about-error">
      <p role="status" class="hint">{{ t('about.unavailable') }}</p>
      <button type="button" class="quiet" @click="load">
        {{ t('about.retry') }}
      </button>
    </div>
  </div>
</template>
