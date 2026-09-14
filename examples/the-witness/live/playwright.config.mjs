import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'witness.live.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 240_000,
  outputDir: '.gauntlet/playwright-results',
  reporter: [
    ['line'],
    ['html', { outputFolder: '.gauntlet/playwright-report', open: 'never' }],
  ],
  use: {
    trace: 'retain-on-failure',
  },
});
