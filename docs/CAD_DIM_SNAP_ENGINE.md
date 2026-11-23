# CAD 2D Dimension & Object Snap Engine

Complete AutoCAD-parity **object snap (OSNAP)** modes and **dimension tools** for the OpenBIMStudio CAD 2D editor.

## Modules

| File | Role |
|------|------|
| `src/modules/cad-viewer/cad-snap-engine.ts` | Full OSNAP modes, settings, polar / ortho / grid, resolve pipeline |
| `src/modules/cad-viewer/cad-dimension-engine.ts` | All dimension kinds, geometry, continue / baseline, scenarios |
| `src/modules/cad-viewer/viewer-math.ts` | Extended `SnapKind` + `findSnap` (extension, tangent, parallel, …) |

## Object snap modes

| Mode | Kind | Notes |
|------|------|-------|
| Endpoint | `endpoint` | Line / arc / polyline vertices |
| Midpoint | `midpoint` | Segment midpoints |
| Center | `center` | Circle / arc center |
| Node | `node` | POINT entities |
| Quadrant | `quadrant` | 0° / 90° / 180° / 270° on circles |
| Intersection | `intersection` | Segment–segment |
| Apparent Intersection | `apparent` | Infinite-line crossings |
| Extension | `extension` | Ray past endpoint (cursor projects onto line) |
| Insertion | `insertion` | TEXT insertion point |
| Perpendicular | `perpendicular` | Requires previous point (`fromPt`) |
| Tangent | `tangent` | From external point to circle / arc |
| Nearest | `nearest` | Closest point on entity |
| Parallel | `parallel` | Keeps new segment parallel to reference |
| Geometric Center | `geometric-center` | Polyline centroid / circle center |

### Keyboard / status

| Key | Behavior |
|-----|----------|
| **F3** | Toggle OSNAP master |
| **F8** | Ortho |
| **F9** | Grid snap |
| **F10** | Polar tracking |
| **F11** | Object snap tracking (OTRACK) |

### Settings API

```ts
import {
  DEFAULT_CAD_SNAP_SETTINGS,
  findCadSnap,
  resolveDraftPoint,
  toggleSnapMode,
  serializeSnapSettings,
  parseSnapSettings,
  ALL_CAD_SNAPS,
} from "../modules/cad-viewer/cad-snap-engine";
```

## Dimension tools

| Command | Aliases | Tool id | Picks |
|---------|---------|---------|-------|
| DIMLINEAR | DLI, DIMLIN | `dimlinear` | p1, p2, offset (H/V by side) |
| DIMALIGNED | DAL, DIMALI | `dimaligned` | p1, p2, offset |
| DIMANGULAR | DAN, DIMANG | `dimang` | vertex, ray1, ray2 |
| DIMRADIUS | DRA, DIMRAD | `dimradius` | center / edge, on-circle |
| DIMDIAMETER | DDI, DIMDIA | `dimdia` | circle edge |
| DIMARC | DAR | `dimarc` | arc entity |
| DIMORDINATE | DOR, DIMORD | `dimordinate` | feature, leader end |
| DIMCONTINUE | DCO, DIMCONT | `dimcont` | next point (chains from last) |
| DIMBASELINE | DBA, DIMBASE | `dimbase` | next point (same origin) |
| DIMCENTER | DCE | `dimcenter` | circle / arc |

### Scenarios

See `DIM_SCENARIOS` in `cad-dimension-engine.ts` for pick sequences and examples.

### Style

```ts
import { DEFAULT_CAD_DIM_STYLE, buildLinearMarkup, continueDimension } from "../modules/cad-viewer/cad-dimension-engine";
```

## Tests

```bash
node tests/cad-snap-dimension.test.cjs
```

## Integration into cad-viewer.ts

1. Import snap settings + dim helpers.
2. Replace `snapModes = new Set(M.ALL_SNAPS)` with `DEFAULT_SNAP_MODES` or persisted settings.
3. Register missing commands: `DIMLINEAR`, `DIMALIGNED`, `DIMRADIUS`, `DIMORDINATE`.
4. In pointer handler, route new tools through `buildLinearMarkup` / `buildAngularMarkup` / …
5. Status bar: OSNAP / POLAR / ORTHO / GRID already present — bind to `CadSnapSettings`.
6. Optional: OSNAP settings dialog listing all modes with checkboxes.

## Compatibility

- Pure TypeScript, no new npm packages.
- Extends existing `viewer-math` snap API without breaking callers that pass the original seven modes.
- Dimension markups remain plain data (`kind`, `pts`, `text`) compatible with the existing canvas painter.
