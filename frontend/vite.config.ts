/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Dev proxy keeps the browser same-origin with the Hub API (ADR-002 topology:
// static frontend + backend behind one hostname in production).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: 'http://localhost:8790', changeOrigin: true },
    },
  },
  test: {
    // Component tests opt into a DOM with `// @vitest-environment jsdom` at the
    // top of the file; the pure lib tests stay on the default node env. The
    // setup file registers jest-dom matchers (toBeInTheDocument, …).
    setupFiles: ['./src/test-setup.ts'],
  },
});
