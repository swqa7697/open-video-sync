import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { consumeInvitation } from './transport/invitation';
import { i18n } from './i18n';

createApp(App, { initialInvitation: consumeInvitation() })
  .use(createPinia())
  .use(i18n)
  .mount('#app');
