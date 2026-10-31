<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
const paths: Record<string, string> = {
  info: 'M12 8h.01M11 12h1v5m-1 0h2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  language:
    'M3 5h12M9 3v2m4 0c-1 6-4 10-10 12m2-9c1 4 4 7 8 9m0 4 5-12 5 12m-8-4h6',
  appearance: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm0 0v18M12 6v12',
  sun: 'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5',
  moon: 'M20.5 13.5A9 9 0 0 1 10.5 3a9 9 0 1 0 10 10.5Z',
  play: 'm9 5 11 7-11 7Z',
  pause: 'M8 5v14M16 5v14',
  replay: 'M3 10a9 9 0 1 1 1 8M3 4v6h6',
  volume: 'm11 5-6 4H2v6h3l6 4ZM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14',
  mute: 'm11 5-6 4H2v6h3l6 4ZM16 9l6 6m0-6-6 6',
  fullscreen: 'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5',
  settings:
    'M9.5 3h5l.6 2.4 1.2.7 2.4-.7 2.5 4.2-1.8 1.7v1.4l1.8 1.7-2.5 4.2-2.4-.7-1.2.7-.6 2.4h-5l-.6-2.4-1.2-.7-2.4.7-2.5-4.2 1.8-1.7v-1.4L2.8 9.6l2.5-4.2 2.4.7 1.2-.7ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  users:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M5 12h14m-5-5 5 5-5 5',
  close: 'm6 6 12 12M6 18 18 6',
  link: 'M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l2-2',
  file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M9 13l6 3-6 3Z',
  screen: 'M3 4h18v14H3ZM8 22h8m-4-4v4',
  check: 'm5 12 4 4L19 6',
  leave: 'M9 4H3v16h6m5-13 5 5-5 5M8 12h13',
  chat: 'M21 15a3 3 0 0 1-3 3H8l-5 4V5a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3ZM7 7h10M7 12h7',
  chevron: 'm8 10 4 4 4-4',
  copy: 'M9 9h12v12H9ZM15 5V2H2v13h3',
  shield: 'm12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z',
};
</script>
<template>
  <svg
    :width="size ?? 20"
    :height="size ?? 20"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] ?? paths.screen" />
  </svg>
</template>
