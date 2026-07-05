import { defineConfig } from 'vitest/config';

// Kept separate from vite.config.ts (which roots at src/client for the app)
// so tests are discovered across the whole src tree.
export default defineConfig({
  test: {
    root: '.',
    include: ['src/**/*.test.ts'],
    globals: true,
    environment: 'node',
  },
});
