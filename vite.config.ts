import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// 프런트엔드는 Vite로 dist/client 에 빌드하고, Worker(wrangler)가 Static Assets로 서빙한다.
// 개발 중에는 /api 요청을 wrangler dev(8787)로 넘긴다.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: { outDir: 'dist/client', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
});
