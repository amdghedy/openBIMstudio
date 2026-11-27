# Browser tests

These run the real app in a browser (Playwright). They are **not** part of `npm test` or the unit-test CI job,
and `@playwright/test` is not a dependency yet (adding it needs a lockfile update on a machine with registry access).

```bash
npm i -D @playwright/test
npx playwright install chromium firefox webkit
npx playwright test tests/e2e/smoke.spec.ts
```

- `smoke.spec.ts` - boots the app, opens the 2D plan, and checks the command line and Esc. Uses visible UI only.
- `edit-undo-save.spec.ts` - new project, IFC import, move via the real Move path, Ctrl+Z, Ctrl+S, reload: boot auto-reopens the project and the state is identical. Uses the palette, the drop-import path and the authoring service, like the other specs.
- `import-timeout.spec.ts` - the browser IFC import timeout: a 17.9 MB real-world file with a 3 s total bound must fail with `timedOut`, then a small file must still import (queue recovery). Chromium only in CI (timing-sensitive, large-file); the mechanism is engine-agnostic JS timers.

CI runs the smoke, orbit/RTL, native IFC, document-chain and save-flow specs in Chromium, Firefox and WebKit through `.github/workflows/unit-tests.yml`. The browser gate is blocking; traces, screenshots and reports are retained on every run.
