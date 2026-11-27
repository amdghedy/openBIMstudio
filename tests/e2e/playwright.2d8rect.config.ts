import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  // 180 s: booting the app plus two calibrations takes ~60 s on this
  // 1.5-CPU box even when it is quiet.
  timeout: 180000,
  retries: 0,
  // No webServer: serve this branch's own build yourself, e.g.
  //   npx vite build && python3 -m http.server 3138 --directory dist
  // then run this spec with this config (SOLO — never alongside other
  // browser specs on this 1.5-CPU box). Port 3138 is this item's own:
  // 3134 belongs to the 2D-30 repair work copy, 3137 to the 2D-7 spec —
  // do not reuse either.
  use: { baseURL: 'http://127.0.0.1:3138', video: 'retain-on-failure' },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions: { args: ['--use-gl=swiftshader'] } } },
  ],
});
