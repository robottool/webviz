import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Served at root by the hub (and in dev); a static GitHub Pages deploy lives
  // under /<repo>/, so the Pages build sets WEBVIZ_BASE to override. Defaulting
  // to '/' keeps the hub-served build and dev server unchanged.
  base: process.env.WEBVIZ_BASE ?? '/',
  plugins: [react()],
  server: {
    port: 5173,
    // Bind all interfaces so the dev server is reachable from outside the host
    // (e.g. a browser on the Windows host when the stack runs in a VM).
    host: true,
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
