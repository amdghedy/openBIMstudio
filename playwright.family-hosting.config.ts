import { defineConfig, devices } from '@playwright/test';

// Own-port config for the family-hosting audit specs
// (tests/e2e/family-hosting-ribbon.spec.ts, tests/e2e/type-propagation.spec.ts).
// The repo default config reuses any server already on :3000, so a sibling
// worktree's preview server would make these specs silently test the wrong
// build. This config has no webServer: start this branch's own build first:
//   npx vite build && npx vite preview --port 3122 --host 127.0.0.1 --strictPort
// Marker check before running (served page must be THIS build):
//   curl -s http://127.0.0.1:3122/ | grep -o 'assets/index-[^"]*\.js'
//   must equal the asset in dist/index.html
// Then, one spec at a time (1.5-CPU VM — never run browser specs concurrently):
//   npx playwright test --config playwright.family-hosting.config.ts tests/e2e/family-hosting-ribbon.spec.ts --project=chromium
//   npx playwright test --config playwright.family-hosting.config.ts tests/e2e/type-propagation.spec.ts --project=chromium
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240000,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:3122', video: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'],
      launchOptions: { args: ['--use-gl=swiftshader'] } } },
  ],
});
