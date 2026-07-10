import { defineConfig, devices } from '@playwright/test';

/**
 * E2E do Dashboard. Sobe a app (build de produção) e a exercita num Chromium.
 * O teste mocka a REST (via page.route) e sobe um broker MQTT-sobre-WS in-process,
 * de modo que roda sem backend nem Docker.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  timeout: 30_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run start',
    url: 'http://localhost:3001',
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
