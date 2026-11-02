<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

import { i18n, t } from '../i18n';
import Icon from './Icon.vue';

const stars = ref<number>();
const controller = new AbortController();
let timeout: ReturnType<typeof setTimeout> | undefined;
const count = computed(() =>
  stars.value === undefined
    ? '—'
    : stars.value.toLocaleString(i18n.global.locale.value),
);
const label = computed(() =>
  stars.value === undefined
    ? t('app.githubStar')
    : t('app.githubStarCount', { count: count.value }),
);
onMounted(async () => {
  timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(
      'https://api.github.com/repos/swqa7697/open-video-sync',
      {
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        headers: { Accept: 'application/vnd.github+json' },
      },
    );
    if (!response.ok) return;
    const data: unknown = await response.json();
    if (
      !controller.signal.aborted &&
      typeof data === 'object' &&
      data !== null &&
      'stargazers_count' in data &&
      typeof data.stargazers_count === 'number' &&
      Number.isSafeInteger(data.stargazers_count) &&
      data.stargazers_count >= 0
    )
      stars.value = data.stargazers_count;
  } catch {
    // The repository link remains usable when GitHub is unavailable or rate limited.
  } finally {
    clearTimeout(timeout);
  }
});
onUnmounted(() => {
  clearTimeout(timeout);
  controller.abort();
});
</script>

<template>
  <a
    class="button quiet repo-stars"
    href="https://github.com/swqa7697/open-video-sync"
    target="_blank"
    rel="noopener noreferrer"
    :aria-label="label"
    :title="label"
  >
    <Icon name="github" :size="18" /><Icon name="star" :size="16" />
    <span class="repo-star-count">{{ count }}</span>
  </a>
</template>
