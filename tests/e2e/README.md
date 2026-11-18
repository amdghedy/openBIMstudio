# Browser tests

These run the real app in a browser (Playwright). They are **not** part of `npm test` or the unit-test CI job,
and `@playwright/test` is not a dependency yet (adding it needs a lockfile update on a machine with registry access).

```bash
npm i -D @playwright/test
npx playwright install chromium firefox webkit
npx playwright test tests/e2e/smoke.spec.ts
```

- `smoke.spec.ts` - boots the app, opens the 2D plan, and checks the command line and Esc. Uses visible UI only.
- `edit-undo-save.spec.ts` - `fixme`: it needs `data-testid` hooks the app does not have yet.

CI runs the smoke, orbit/RTL, native IFC, document-chain and save-flow specs in Chromium, Firefox and WebKit through `.github/workflows/unit-tests.yml`. The browser gate is blocking; traces, screenshots and reports are retained on every run.
