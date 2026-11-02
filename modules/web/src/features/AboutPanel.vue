<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';

import Icon from '../components/Icon.vue';
import { t } from '../i18n';
import { object, request, shape } from '../transport/api';

const modules = ['sync', 'web', 'helper'] as const;
const versions = ref<
  Record<(typeof modules)[number], string> & {
    image: string;
    release: boolean;
    commit: string;
    dirty: boolean;
  }
>();
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
      await request('/version', 'GET', '', undefined, current.signal),
    );
    shape(value, [...modules, 'image', 'release', 'commit', 'dirty', 'tag']);
    if (
      typeof value.image !== 'string' ||
      !value.image ||
      value.image.length > 512 ||
      /[\p{Cc}\s]/u.test(value.image) ||
      typeof value.release !== 'boolean' ||
      typeof value.commit !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})?$/.test(value.commit) ||
      typeof value.dirty !== 'boolean' ||
      typeof value.tag !== 'string' ||
      value.tag.length > 256 ||
      /[\p{Cc}\s]/u.test(value.tag) ||
      (!value.commit && (value.dirty || value.tag || value.release))
    )
      throw new Error('Invalid build metadata.');
    const release = {
      sync: releaseVersion(value.sync),
      web: releaseVersion(value.web),
      helper: releaseVersion(value.helper),
      image: value.image,
      release: value.release,
      commit: value.commit,
      dirty: value.dirty,
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
    <header class="about-header">
      <div class="about-brand">
        <span class="brand-mark"><Icon name="play" :size="18" /></span
        ><strong>Open Video Sync</strong>
      </div>
      <div v-if="versions" class="about-build">
        <p class="about-build-label">{{ t('about.build') }}</p>
        <code class="about-image">{{ versions.image }}</code>
        <div v-if="!versions.release && versions.commit" class="about-commit">
          <span>{{ t('about.commit') }}</span>
          <code :title="versions.commit">{{
            versions.commit.slice(0, 12)
          }}</code>
          <span
            v-if="versions.dirty"
            class="about-dirty"
            :title="t('about.dirtyHint')"
            >dirty</span
          >
        </div>
      </div>
    </header>
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
