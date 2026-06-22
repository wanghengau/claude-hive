import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4001,
    proxy: {
      '/ws': { target: 'ws://localhost:4000', ws: true },
      '/sessions': { target: 'http://localhost:4000' },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
  },
});
