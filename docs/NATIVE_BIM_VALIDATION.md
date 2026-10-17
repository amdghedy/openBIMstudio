# Native BIM Validation

## Purpose

`src/modules/native-bim/model-validation.ts` provides a pure validation layer for native authored elements. It is intentionally independent of Three.js, the browser UI, and project persistence so the same rules can be used by authoring tools, save/export commands, automated QA and AI-assisted operations.

The validator is additive. It does not mutate, repair, delete or block existing model data by itself.

## Current checks

- Stable, unique authored element IDs and non-empty categories/names.
- Finite elevation, height, thickness, width and depth values; positive dimensions.
- Linear element endpoints and zero-length detection for structural and MEP runs.
- Polygon point count, finite coordinates and non-zero area for area-based elements.
- Door/window host existence, wall host category, self-hosting and basic height bounds.
- Level references and grid identity/geometry.
- Native triangle-buffer integrity (complete triangles and finite coordinates).
- Imported/native transforms, including quaternion magnitude and non-zero scale.
- Duplicate IFC GlobalIds and explicit warnings when source and native IFC identity diverge.
- Fitting parent type and bend-radius sanity checks.

Diagnostics have stable machine-readable codes, severity, element references and parameter paths. Use `isNativeModelValid` for a blocking-error gate and `summarizeDiagnostics` for status indicators.

## Run the focused tests

```sh
node tests/native-bim-validation.test.mjs
```

The test imports TypeScript through the repository's installed TypeScript compiler and exercises valid and invalid model snapshots without starting the browser application.

## Integration guidance

1. Call `validateNativeModel({ elements: getElements(), levels: getLevels(), grids: getGrids() })` from a model QA command or before export.
2. Display errors and warnings in a diagnostic panel; allow users to navigate to `elementId`.
3. Do not silently auto-fix engineering geometry. Offer proposed repairs as explicit, undoable transactions.
4. Extend checks as the parametric constraint graph, view/documentation model and IFC round-trip tests mature.

## Scope limitations

This module is a validation foundation, not a complete constraint solver, IFC certification, collision engine or substitute for discipline-specific engineering review. Hosted-element bounds are deliberately warnings where wall opening/host geometry is not yet available to the validator.

## 2D documentation QA

The Sheets workspace Model QA panel also validates the drawing set using
`src/modules/native-bim/documentation-validation.ts`. Checks include duplicate
sheet numbers and IDs, unsupported sheet sizes, missing view references,
invalid viewport dimensions, viewports outside the physical sheet, invalid
scale notation, and viewport overlap. Overlap and sheet-bound conditions are
warnings so intentional layouts remain possible; missing view links and
invalid scales are errors. The report export includes both model and
documentation diagnostics. These checks do not replace drawing review or
verify discipline-specific annotation completeness.
