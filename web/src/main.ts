import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import './style.css';
import { consumeInvitation } from './transport/invitation';

createApp(App, { initialInvitation: consumeInvitation() })
  .use(createPinia())
  .mount('#app');
