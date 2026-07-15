import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Dev proxy keeps the browser same-origin with the Hub API (ADR-002 topology:
// static frontend + backend behind one hostname in production).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8790', changeOrigin: true },
    },
  },
});
