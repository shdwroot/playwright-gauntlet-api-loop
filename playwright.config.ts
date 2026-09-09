import { defineConfig } from '@playwright/test';

const artifactDir = process.env.GAUNTLET_ATTEMPT_DIR ?? '.gauntlet/playwright';

export default defineConfig({
  testDir: process.env.GAUNTLET_GENERATED_DIR ?? '.gauntlet/generated',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  timeout: Number(process.env.GAUNTLET_TEST_TIMEOUT_MS ?? 30_000),
  outputDir: `${artifactDir}/test-results`,
  reporter: [
    ['json', { outputFile: `${artifactDir}/playwright-report.json` }],
    ['junit', { outputFile: `${artifactDir}/junit.xml` }],
    ['html', { outputFolder: `${artifactDir}/html`, open: 'never' }],
    ['line'],
  ],
  use: {
    baseURL: process.env.GAUNTLET_BASE_URL,
    trace: 'retain-on-failure',
  },
});
