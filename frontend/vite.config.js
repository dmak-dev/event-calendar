import { fileURLToPath, URL } from 'node:url';

import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    // Запросы к API уходят на сервер Express: для браузера это тот же источник,
    // поэтому CORS в режиме разработки не нужен.
    proxy: {
      '/events': 'http://localhost:3000',
    },
  },
});
