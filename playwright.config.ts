import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60000,
  retries: process.env.CI ? 1 : 0,
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1',
    port: 4173,
    timeout: 60000,
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: 'http://localhost:4173', video: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'],
      launchOptions: { args: ['--use-gl=swiftshader'] } } },
    { name: 'webkit',   use: { ...devices['Desktop Safari'] } },
    { name: 'firefox',  use: { ...devices['Desktop Firefox'] } },
  ],
});
