<script setup lang="ts">
import { t } from '../i18n';

const headlines = [
  'app.headlines.welcome',
  'app.headlines.rooms',
  'app.headlines.local',
  'app.headlines.sources',
  'app.headlines.invitation',
] as const;
// Choose once per home visit so form edits and language changes keep the same greeting.
const headline = headlines[Math.floor(Math.random() * headlines.length)]!;
</script>

<template>
  <div class="home-heading">
    <h1>{{ t(headline) }}</h1>
    <p>{{ t('app.heroHint') }}</p>
  </div>
</template>
