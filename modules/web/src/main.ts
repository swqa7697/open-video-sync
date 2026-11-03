import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import { consumeImport } from './features/import/entry';
import { i18n } from './i18n';
import { consumeInvitation } from './transport/invitation';

import './style.css';

const initialImport = consumeImport();
createApp(App, {
  initialImport,
  initialInvitation: initialImport ? undefined : consumeInvitation(),
})
  .use(createPinia())
  .use(i18n)
  .mount('#app');
