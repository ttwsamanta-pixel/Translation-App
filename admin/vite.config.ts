import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: resolve('admin'),
  plugins: [tailwindcss()],
  server: {
    host: '127.0.0.1',
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/assets/ttw': 'http://127.0.0.1:3000',
      '/ready': 'http://127.0.0.1:3000',
    },
  },
});
