import { defineConfig, devices } from '@playwright/test';

// Browser-level smoke suite for the free dashboard. Runs the real CLI server
// (see e2e/serve.mjs) against the built ui/ — so run `npm run build:ui`
// first if you've changed trimwares-dashboard/ source. One-time setup:
//   npx playwright install chromium
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,       // one shared server + one seeded session; tests mutate it (clear)
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:7790',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node e2e/serve.mjs',
    url: 'http://localhost:7790/api/data',
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
