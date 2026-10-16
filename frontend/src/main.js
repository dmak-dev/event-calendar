// Этот файл создаёт и монтирует Vue-приложение и подключает глобальные стили.
import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';

createApp(App).mount('#app');
