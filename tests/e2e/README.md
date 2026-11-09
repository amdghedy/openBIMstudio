# Browser tests

These run the real app in a browser (Playwright). They are **not** part of `npm test` or the unit-test CI job,
and `@playwright/test` is not a dependency yet (adding it needs a lockfile update on a machine with registry access).

```bash
npm i -D @playwright/test
npx playwright install chromium
npx playwright test --project=chromium tests/e2e/smoke.spec.ts
```

- `smoke.spec.ts` - boots the app, opens the 2D plan, and checks the command line and Esc. Uses visible UI only.
- `edit-undo-save.spec.ts` - `fixme`: it needs `data-testid` hooks the app does not have yet.

CI runs `smoke.spec.ts` and `orbit-rtl.spec.ts` in Chromium via `.github/workflows/browser-smoke.yml` (informational, non-blocking). Nothing else in the UI has been verified in a browser.
