import { defineConfig } from 'vite';

export default defineConfig({
  /**
   * GitHub Pages serves a project site from /<repo>/, so assets need that
   * prefix — without it the built page 404s on every script. Left as '/' for
   * local dev and any root-hosted deploy.
   */
  base: process.env['GITHUB_ACTIONS'] ? '/coreward/' : '/',
  server: {
    port: 5199,
    watch: {
      /**
       * This project lives on /mnt/c — a 9p mount of the Windows filesystem
       * inside WSL2, which does NOT deliver inotify events to Linux. Vite's
       * watcher therefore never sees a save and HMR silently never fires; the
       * only symptom is having to restart the dev server for every change.
       *
       * Polling is the standard fix. It costs a little CPU, which is the price
       * of the source living on the Windows side of the mount.
       */
      usePolling: true,
      interval: 300,
    },
  },
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    environmentMatchGlobs: [['test/ui.test.ts', 'jsdom']],
    environment: 'node',
  },
} as never);
