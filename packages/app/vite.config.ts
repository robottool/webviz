import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Let the dev server reach the hub's REST API without CORS friction.
      '/api': 'http://localhost:8080',
      '/assets': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
