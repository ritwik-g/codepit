import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = 'http://127.0.0.1:7890';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    port: 5280,
    strictPort: true,
    proxy: {
      // The proxy reaches the server over loopback, so the dev page is trusted like the host
      '/api': { target: API, changeOrigin: true },
      '/ws': { target: API, ws: true },
    },
  },
});
