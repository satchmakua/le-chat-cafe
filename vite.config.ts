/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vite + React for the app; Vitest config lives here too (single source).
// M0 tests are pure logic, so the Node test environment is enough; switch to
// 'jsdom' when component-render tests arrive (see ROADMAP M5).
export default defineConfig({
  plugins: [react()],
  // Honor a port injected by the launcher (e.g. the preview harness via PORT),
  // otherwise default to Vite's usual 5173.
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
