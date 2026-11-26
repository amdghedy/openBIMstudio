import { defineConfig, devices } from '@playwright/test';

// Own-port config for the snap-race browser proof (tests/e2e/snap-race.spec.ts).
// The repo default config reuses any server already on :3000, so a sibling
// worktree's preview server would make this spec silently test the wrong
// build. This config has no webServer: start this branch's own build first:
//   npx vite build && npx vite preview --port 3121 --host 127.0.0.1 --strictPort
// Marker check before running (served page must be THIS build):
//   curl -s http://127.0.0.1:3121/ | grep -o 'assets/index-[^"]*\.js'
//   must equal the asset in dist/index.html
// Then:
//   npx playwright test --config playwright.snap-race.config.ts tests/e2e/snap-race.spec.ts --project=chromium
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240000,
  retries: 0,
  use: { baseURL: 'http://127.0.0.1:3121', video: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'],
      launchOptions: { args: ['--use-gl=swiftshader'] } } },
  ],
});
