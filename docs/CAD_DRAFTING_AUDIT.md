# 2D CAD Engine — Professional Drafting Audit and Upgrade Record

Scope: the standalone 2D CAD drawing editor (`src/features/cad-viewer.ts` over the
`DxfDocument`/`DxfEntity` model in `src/modules/drawings/dxf-types.ts`, with math in
`src/modules/cad-viewer/*`). Audit performed before any change; every claim below was
verified against the code at HEAD before implementation.

## 1. Audit findings (pre-change state)

### 1.1 Architecture facts

| Subsystem | State | Location |
|---|---|---|
| Entity model | `DxfEntity` discriminated union: LINE, RAY, XLINE, CIRCLE, ARC, LWPOLYLINE (+hatch data), TEXT/MTEXT, POINT | `dxf-types.ts:87-165` |
| Spatial index | Uniform grid rebuilt on every mutation; viewport culling for repaint and picking | `viewer-math.ts:490-554` |
| Command engine | 169-command catalog + single dispatcher `executeDrawingCommand` + staged tool state machines | `cad-viewer.ts:169-349`, `:8084+` |
| Rendering | Single Canvas2D, rAF-coalesced full repaint, DPR-correct, spatial culling, sub-pixel skip | `cad-viewer.ts:2718-2726` |
| Keyboard | Type-anywhere dynamic prompt, F3/F7/F8/F10/F12, Ctrl combos, Esc reset, BIM registry stand-down via `__obsCadOwnsKeys` | `cad-viewer.ts:7501-7767` |
| Window/crossing | Drag direction decides mode (L→R window, R→L crossing), bbox-inside vs touch test | `cad-viewer.ts:7305-7316`, `viewer-math.ts:823-846` |
| Grips | Per-entity grips, drag = one undoable `modify`, hatch boundaries excluded by design | `viewer-math.ts:1141-1229` |
| Layers | Full DXF layer table (on/freeze/lock/colour/linetype/lineweight/transparency/plot), LAYISO/LAYOFF/LAYMRG/LAYDEL | `cad-viewer.ts:4980-5153` |
| Undo/redo | Per-command transactional entity stack (`add`/`delete`/`modify`/`replace`/`order`), N→M ops recorded atomically | `cad-viewer.ts:1502-1527` |
| Hide/isolate | Per-entity + per-layer sets with 20-deep visibility history | `cad-viewer.ts:4844-4883` |
| Zoom | Zoom extents / window / previous / to-selection (`ZS`) / to-layer | `cad-viewer.ts:2733-2739`, `:4827-4842` |
| Context menu | Full right-click menu (zoom, selection, visibility, clipboard, modify, layers) | `cad-viewer.ts:4885-4972` |
| Import/export | DWG R12-R2018 + DXF via WASM reader, DXF/PDF/SVG/GEOJSON/PS writers, CTB/STB plot styles | `acad-engine.ts`, `dxf-writer.ts` |

### 1.2 Requested command inventory at audit time

All 25 requested commands existed. Status of the weaker ones:

| Command | Audit verdict |
|---|---|
| line, polyline, arc, circle, rectangle, hatch, text, offset, trim, extend, fillet, chamfer, move, copy, rotate, mirror, scale, array (rect/polar/path), stretch, measurement (DIST/AREA/ANGLE/ID/LIST/MEASURE/DIVIDE) | Complete, tested |
| **ellipse** | **Bug**: the tool computed the picked major-axis angle but built an axis-aligned loop — picked rotation was silently discarded |
| **dimensions** | DIMLINEAR/DIMALIGNED were first-class (styles + associativity); DIMRADIUS, DIMDIAMETER, DIMANGULAR, DIMARC, DIMCENTER, DIMCONTINUE, DIMBASELINE drew **transient canvas markups** — not saved, not selectable, not undoable, not exported |
| **explode** | Only LWPOLYLINE→LINE; dropped `ltScale`/`transparency` and gave no hatch-loss feedback |

### 1.3 Dormant mechanisms found

- `typeFilter` was honoured by the visibility predicate but **no command or UI ever set
  it** — i.e. selection filters did not exist in practice.
- Native `RAY`/`XLINE` entities (which imported files contain) could not serve as TRIM
  cutting edges because `entitySegments` returned no geometry for them.

### 1.4 Deliberate non-changes (documented, not gaps)

- Ellipse/spline/xline persistence as polyline/long-line is **self-consistent** across
  authoring, import, and export; a native `ELLIPSE` entity would be a cross-cutting
  rewrite of types/IO/math/grips/modify for marginal fidelity gain — not done.
- The 900-line dispatcher if-chain is monotonic and fully tested; a command-object
  rewrite was not justified.

## 2. Changes delivered (all tested in `tests/cad-drafting-completions.test.cjs`)

### 2.1 Persistable radial / diameter / angular / arc-length / centre-mark dimensions

- New pure builders in `dimension-tools.ts`: `buildRadialDimension`, `buildDiameterDimension`,
  `buildAngularDimension`, `buildArcLengthDimension`, `buildCenterMark` — all emit ordinary
  tagged LINE+TEXT groups (`meta {dimId, role}`) with the same architectural-tick idiom as
  linear dims.
- `dimension-system.ts`: `DimMode` union; `measureRecord` per mode (radial = |edge−centre|,
  diameter = 2×, angular = CCW sweep 0–360°, arclen = r×sweep); `buildDimEntities` dispatch;
  `dimPrefix` (R / ⌀); `formatAngleMeasurement` (DIMDEC precision).
- `cad-viewer.ts`: the seven markup-only pointer flows (`radius`, `dimdia`, `dimang`,
  `dimarc`, `dimcenter`, `dimcont`, `dimbase`) now commit **associative dimension records**
  through `createDimEntities`/`commitDimRecord` → `addEntities`. They are selectable,
  undoable, restyled by DIMSTYLE, exportable, and follow moved geometry.
- Associativity extended in `trackDimensionDefpoints`: centre-anchored kinds ride rigidly
  with their circle/arc; angular second-ray defpoints ride when they coincide with moved
  endpoints. Documented limitation: scaling a circle does not update radial dims (the
  defpoint model cannot see radius changes).

### 2.2 DIMCONTINUE / DIMBASELINE chaining

- `continuedDimRecord` / `baselineDimRecord` pure helpers; chain state (`lastLinearRecord`,
  `lastBaselineRecord`) in the engine. DIMCONTINUE inherits the previous second endpoint and
  offset (one click per continued dim, AutoCAD-style); DIMBASELINE measures from the root
  origin and staggers successive placements outward so texts do not overlap.

### 2.3 Selection filters (FILTER)

- New `FILTER` command + dialog: per-type checkboxes (with live counts) drive the
  previously-dormant `typeFilter`; picking and window/crossing selection both honour it;
  applying the filter deselects excluded entities; `FILTER CLEAR` resets.

### 2.4 Ellipse rotation fix

- `ellipseLoop(cx, cy, rx, ry, steps, rotationDeg)` now rotates the parametric loop; the
  ellipse tool passes the actual major-axis angle it already computed, so the drawn ellipse
  honours the axes the user picked. Default (0°) behaviour unchanged; DONUT unaffected.

### 2.5 Native RAY/XLINE cutting edges

- `entitySegments` emits finite representative segments for native RAY/XLINE, so imported
  construction lines now intersect, TRIM and EXTEND correctly. They remain excluded as
  trim/extend targets (guards unchanged).

### 2.6 EXPLODE parity

- Exploded LINE segments carry `ltScale`/`transparency` from the source polyline; the log
  reports hatch fill loss when hatched boundaries are exploded.

## 3. Verification

- `tests/cad-drafting-completions.test.cjs` (registered as `test:cad-drafting-completions`
  in `package.json` and `scripts/ci-unit-tests.mjs`): builder composition + meta tagging,
  per-mode measurement, dispatch, associativity (radial rigid follow, linear unchanged,
  angular defpoints), continue/baseline chaining math, rotated-ellipse parametric identity,
  ray/xline intersections + ray-as-trim-cutter, and source-level wiring assertions
  (FILTER registered, markup flows replaced by record commits, rotation argument passed).
- Full suite: `node scripts/ci-unit-tests.mjs` — all scripts pass (baseline 215 + new).
- `npx tsc --noEmit -p tsconfig.json` clean; `npm run build` clean.
