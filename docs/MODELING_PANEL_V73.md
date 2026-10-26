# Intelligent Modeling, Dynamic Properties Panel, Justification & Smart Snapping — v0.73.0

Implementation record for the **MASTER PROMPT — OpenBIMStudio Intelligent Modeling,
Dynamic Properties Panel, Justification & Smart Snapping Engine**. Every item below
names the real module/function it lives in — nothing in this document describes a
planned-only behavior.

## 1. Dynamic Modeling Properties Panel (§2)

| Requirement | Where it lives |
|---|---|
| Panel opens automatically when a modeling tool activates | `features/property-palette.ts` — `onAuthoringChange` handler calls `openPropertyPalette()` when `isDrawToolActive()` (authoring.ts) becomes true |
| Context-sensitive parameters per tool | `features/tool-panels.ts` — declarative `TOOL_PANELS` registry; the palette renders from it (`renderToolPanel`) with zero per-tool UI code |
| Parameters apply to the NEXT element while placing | palette *defaults* mode → `authoring.setTypeDefault()` (`typeDefaults`), consumed by `createElement()` |
| Live preview update on parameter change (§2.3) | every panel write calls `authoring.refreshPreview()` which re-runs `updatePreview()` with the last pointer event |
| Validation (non-finite, min/max) with inline feedback | `tool-panels.validatePanelNumber` + palette `renderToolField` error row; invalid values never reach the model |
| Units & precision (§2.3) | length fields parse through `core/units.ts` `units.parseLengthInput` (`"500 mm"`, `"5'-6"` all work) and display through `units.formatLength` |
| Per-tool Reset | `renderToolPanel` Reset button → `authoring.resetTypeDefaults(type)` restores factory `DEFAULTS` + placement state |
| Switching tools preserves committed data (§2.4) | defaults are stored per element type (`typeDefaults` map) — switching tools never discards other tools' settings |
| Cancel discards only the preview | existing Escape path (`handleAuthoringCancel`) clears previews/chain; committed objects untouched |

**Covered tools (19):** wall, curtain-wall, slab, column, beam, brace, truss, footing,
strip, mline, duct, pipe, cable-tray, conduit, equipment, door, window, grid, level —
exactly the tools that exist in `authoring.ts` `DRAW_TOOLS`. Ribbon aliases
(`TOOL_ALIASES`, e.g. `roof → slab`, `pile → footing`) resolve to the internal tool's
panel, so no panel ever shows a parameter the engine does not use.

**Wall parameters** (§2.2): height, thickness, base elevation, location line (six
options), offset, chain, join status. **Beam:** depth/width, elevation, horizontal
justification, Z justification, end elevation. **MEP:** width/height, elevation,
horizontal justification, slope %. **Doors/windows:** width, height, sill height,
frame thickness. **Slab:** thickness + elevation + boundary hint. Columns/footings:
b/h/height + elevation. All are consumed by the real geometry builders
(`buildWallWithOpenings`, `buildDoor`/`buildWindow`, `createMesh`).

## 2. Justification & Location-Line System (§3)

Pure engine: **`modules/justification/index.ts`** (no DOM/three — Node-testable).

- `justificationShiftMeters(mode, width)` — Center / Outer Edge / Inner Edge
  (0 / +w⁄2 / −w⁄2 along the left normal).
- `wallShiftForLocationLine` — six Revit-style lines; core faces use the **core
  thickness** from the compound layer string (`coreThicknessFromLayers`).
- `applyJustificationToSegment` / `resolveWallJustification` — shift both endpoints
  along the segment's left normal so the chosen face lands on the drawn line; the
  reference path itself is preserved (switching modes re-solves the same input line).
- **Gate (§3.1):** core options are hidden unless `properties.layers` of the current
  wall type contains a core layer — verified in the palette (`coreLayersSupported`)
  and in the descriptor registry (`requiresCoreLayers`).

Integration in `features/authoring.ts`:

- `justifyLinearSegment()` runs on **every 3D chain commit** (the old code applied
  location lines only in the 2D plan path; the 3D path now honors them too).
- Walls/curtain walls record `properties.locationLine` on commit; wall-column binds
  reuse it when re-resolving endpoints.
- Beams/strip footings: horizontal justification across the profile + **Z
  justification** (`bottom` = historic behavior; `center`/`top` shift the placed
  elevation by −h/2 / −h).
- MEP: horizontal justification + slope via the existing `slopedElevations` chain
  state — 3D chains now accumulate elevation exactly like plan-drawn runs.
- **Reference-line visualisation (§3.3):** while placing with a face justification,
  the ghost draws at the justified position while a light dashed line shows the
  reference path and yellow ties show the offset to the aligned face
  (`updatePreview`, guide group).

## 3. Intelligent Snapping Engine (§4)

`features/snapping.ts` (the runtime engine every tool already consumes) upgraded:

- **Real generators for previously phantom types:** perpendicular (foot of the
  perpendicular from the chain base onto nearby lines), parallel (cursor projected
  onto the base-parallel companion), intersection (segment × segment near cursor).
  Math lives in the pure **`modules/snapping/magnetic.ts`**.
- **MEP connector snapping:** free connector origins from `__obsMepConnectors`
  appear as orange connector markers (priority 93) and bind a persistent
  `mep-connection` on commit.
- **Snap priority** unified through `rankCandidates` (endpoint 100 → … → grid 15,
  connector 93); per-category toggles remain in the snap settings panel.
- **Hysteresis** (tolerance × 1.15) keeps the current target instead of flickering
  between overlapping candidates.
- **Tab cycling (§4.3):** Tab / Shift+Tab cycles overlapping candidates; the pinned
  candidate keeps winning until the pointer leaves it. Alt **temporarily suspends**
  snapping (Shift stays the orthogonal lock; Shift+S is the global toggle).
- **Zoom-independent tolerance (§4.2):** `worldTolerance()` converts the pixel
  tolerance to world metres at the cursor's depth (perspective + orthographic).
- **Performance:** AABB prefilter (`aabbNearCursor`) skips far elements before any
  per-point work; the corner pass walks an endpoint map instead of comparing every
  element pair; segment-intersection pairs are capped at 32 prefiltered elements.
- **Element identity:** every snap result now carries `elementId` + `refKind` —
  snap feedback stays fully separate from selection (DOM overlay + guide group,
  unchanged), but placement knows *what* it snapped to.

## 4. Persistent Relationships & Dependent Updates (§5/§6)

`features/authoring.ts`:

- `recordSnapRelationships()` — runs after each committed linear element:
  - endpoint/corner snap onto another linear element → **`endpoint-constraint`**
    (follow-source) relationship;
  - snap onto a column/footing face → **wall-column endpoint-constraint** via
    `modules/snapping/wall-column.ts` (`getColumnReferenceGeometry`,
    `findWallColumnContactCandidates`, `createWallColumnRelationship`), including the
    compound clearance pull-back for oblique approaches;
  - connector snap → **`mep-connection`** relationship.
- `collectDependentPatches()` — when a referenced object moves (click-move **and**
  gizmo drag), bound dependents update in the **same undo transaction**:
  - plain endpoint constraints translate the bound endpoint by the move delta
    (coincident corners stay coincident; the other endpoint stays put);
  - wall-column constraints re-resolve the wall endpoint against the column's new
    footprint (`calculateWallEndpoint`); if the column moved clear of the wall the
    bind is left for repair instead of guessing an endpoint;
  - patches are folded into the same `history.push` and reference positions are
    refreshed in the registry (`refreshDependentRefs`).
- Temporary snap candidates remain non-persistent by design — only the conversions
  above reach the registry (mirrors spec 2B.5).

## 5. Verification

| Suite | Assertions | Focus |
|---|---|---|
| `tests/v73-justification.test.cjs` | 22 | face shifts (axis-aligned + rotated), path preservation, core parsing, gating, offset composition |
| `tests/v73-snap-magnetic.test.cjs` | 22 | perpendicular/parallel/intersection closed forms, priority ranking, hysteresis, cycling, screen↔world tolerance, prefilter |
| `tests/v73-tool-panels.test.cjs` | 15 | per-tool coverage, binding completeness, core gating, validation |
| `tests/v73-relationships.test.cjs` | 12 | registry validation, follow-source propagation, wall-column bind + re-resolution + honest refusal |
| `scripts/verify-v73.mjs` | 46 | wiring shape: every feature exists in the real source path |

`npm run typecheck`, the full historical test set, and `npm run build` all pass;
the four suites + verify script are wired into `.github/workflows/unit-tests.yml`.

## 6. Documented deviations & scope decisions

1. **Panel auto-open supersedes the earlier "closed by default" fix** — the master
   prompt (§2.1) explicitly requires automatic opening on tool activation. Selection
   changes and manual open/close behave exactly as before.
2. **Tangential snapping** remains unimplemented: the platform has no arc/curve
   authored elements yet, so there is no geometry it could apply to (§4.1 "where
   geometrically applicable"). It stays in the settings panel as a reserved toggle.
3. **M2 boot (`setupBimGaps`) remains unwired** — the stairs/railing/ramp/roof/ceiling
   module + room tool exist in the repo but their bootstrap is dead code. Wiring it
   changes ribbon routing for several tools and is a separate integration task; the
   master prompt's tool list is fully covered by the wired tools above.
4. **Rotation propagation** for endpoint-constrained walls: translation moves are
   applied to dependents; rotation keeps the existing registry-eval reporting path
   (consistent with the v71 Group-1 behavior).
5. ** justification side convention** — exterior/outer = the right side of the draw
   direction (matches the pre-existing plan-path behavior; reverse the draw
   direction to flip sides, exactly like BIM).
