import { defineConfig } from 'vite';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    environmentMatchGlobs: [['test/ui.test.ts', 'jsdom']],
    environment: 'node',
  },
} as never);
