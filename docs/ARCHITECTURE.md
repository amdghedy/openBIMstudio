# Architecture

A short map of how OpenBIMStudio is put together and where to add things.
It describes the code as it is, including the parts that are still being consolidated.

## Layers

| Layer | Path | What lives there |
|-------|------|------------------|
| Boot | `src/main.ts` | Creates the viewer, then runs ~100 named `step(name, fn)` calls. A failing step is logged and skipped; it does not stop the rest. |
| Core | `src/core/` | The viewer context (`context.ts`), the typed service registry (`services.ts`), the input router, notifications, units, i18n, secure storage. No UI features. |
| Features | `src/features/` | User-facing tools and panels (authoring, clash, schedules, link tools, shortcut editor, dialogs). Most are one `setupX()` called from `main.ts`. |
| Modules | `src/modules/` | Logic that should not depend on the DOM where possible: parsers, geometry, engines (clash, wall detection, point-cloud parsers, magnet/join planning). Prefer putting new logic here so it can be unit-tested. |
| Shell | `src/shell/` | The ribbon, file menu, status bar, home screen. |
| Workers | `src/workers/`, `worker/` | Heavy work off the main thread; the `worker/` folder is the Cloudflare Worker. |

## Key pieces

- **`core/context.ts`** holds shared singletons (`ctx`): the 3D world, fragments manager, highlighter, clipper. Features read from it.
- **`core/services.ts`** is the typed registry. New cross-feature calls should go through `register(...)` and `services.*`, not through `window.__obs*`. The `ctx.features` bag and `window.__obs*` globals are legacy and are being retired.
- **`features/authoring.ts`** owns natively authored elements (walls, beams, ducts, ...). Edits go through `applyElementParamChange` (validated, atomic). Callers push undo steps; `withParamHistory` snapshots params for a single undo step.
- **`core/input-router.ts`** decides whether a pointer event is a viewport gesture or UI. Panels and menus need an `obs-` id, `data-obs-ui`, or must live outside the viewport host.
- **`features/form-modal.ts`** is the one place for dialogs: `openFormModal`, `promptLine`, `confirmDialog`, `showTableDialog`. Do not use `alert()`, `prompt()` or `confirm()`; use `uiAlert()` from `core/notify` for messages.
- **`features/feature-maturity.ts`** is the honest status of each capability (verified / limited / experimental / planned / unavailable) and is shown in the app under User Interface -> Feature Status.
- **`features/shortcuts.ts`** is the shortcut registry; users rebind keys in the Keyboard Shortcuts window (`KS`).

## Coordinates

World axes: X east, Y up, Z north. Element params such as `start`, `end` and `point` are `[x, z]` in metres.

## Adding a feature

1. Put the logic in `src/modules/<name>/` with no DOM access if you can.
2. Add a unit test in `tests/<name>.test.cjs` and a `test:<name>` script; add it to `scripts/ci-unit-tests.mjs`.
3. Add the UI in `src/features/` (or a ribbon item in `src/shell/ribbon.ts`).
4. Add an entry to `FEATURE_MATURITY` with honest limitations and an evidence path.
5. Run `npm run typecheck` and `npm run test:ui-honesty`.

## Known structural debt

- Several generations of the same feature exist in places (the per-release `scripts/verify-v*.mjs` gates and some parallel panels; the old `v40/v67/v68-register` files are now `module-globals`, `engineering-engines`, `authoring-core`). New work should reuse the current implementation rather than adding another.
- `window.__obs*` globals (about 818 references) are still used for cross-feature calls; `tests/ui-honesty.test.cjs` only lets the count go down.
- No native `prompt()`/`confirm()`/`alert()` calls remain; `tests/ui-honesty.test.cjs` keeps it that way.
- Unit tests cover logic. Browser-level coverage is one Playwright spec (`tests/e2e/edit-undo-save.spec.ts`) and needs to grow.


## Full engineering map

The concise overview above is supplemented by the [Engineering Architecture Map](engineering/ARCHITECTURE.md), which documents the actual boot lifecycle, domain boundaries, IFC/FRAG and collaboration flows, all top-level `src/modules/` directories, and current structural limitations. CI checks that the directory inventory remains synchronized with source.
