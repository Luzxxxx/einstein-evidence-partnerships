import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  build: {
    outDir: fileURLToPath(new URL('./dist/web', import.meta.url)),
    emptyOutDir: true,
  },
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:3000' } },
  preview: { host: '127.0.0.1' },
});
