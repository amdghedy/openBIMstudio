# Universal Smart Snapping & Parametric Constraints (OpenBIMStudio)

## Architecture (existing + this release)

| Layer | Location | Role |
|-------|----------|------|
| Runtime snap manager | `src/features/snapping.ts` | Pointer query, markers, Tab cycle, Alt suspend, ortho |
| Pure ranking / hysteresis | `src/modules/snapping/magnetic.ts` | Screen-space rank, lock hysteresis |
| Spec engine pipeline | `src/modules/snapping/engine.ts` | Candidate query → rank → lock → temp constraint → persist |
| Modeling state machine | `src/modules/snapping/state-machine.ts` | Idle → snap → preview → validate → commit |
| Wall–column geometry | `src/modules/snapping/wall-column.ts` | Face contact, pull-back, relationships |
| Smart perp (grip drag) | `src/modules/snapping/smart-perp-snap.ts` | ±2° face snap + magnetize |
| Spatial broad-phase | `src/modules/snapping/spatial-index.ts` | AABB octree + plan quadtree |
| Visual smart feedback | `src/features/snap-feedback.ts` | Blue L-guide, anchor, End label |
| AccuDraw | `src/features/accudraw.ts` | Axis / angle / typed distance |
| Parametric solver | `src/modules/constraints/` | coincident, distance, perpendicular, … |
| Relationships | `src/modules/relationships/` | Persistent endpoint / host / MEP links |
| Authoring integration | `src/features/authoring.ts` | Draw + grip drag + `recordSnapRelationships` |

## Snap types (runtime)

Endpoint, midpoint, center, intersection, corner, perpendicular, parallel, tangent, quadrant, vertex, face, nearest, extension, grid, connector.

Engine kinds also include wall-core/finish faces, column-boundary, level, reference-plane, connector-origin/axis.

## Priority (default)

Higher wins before screen-distance tie-break (see `SNAP_PRIORITY` / `BASE_PRIORITY`):

1. Persistent relationships / hosts (application layer)
2. Intersection / grid
3. Endpoint / connector
4. Midpoint / center / faces
5. Perpendicular / parallel / extension
6. Nearest / free

## Keyboard modifiers

| Key | Behavior |
|-----|----------|
| **Shift** | Orthogonal / AccuDraw ortho |
| **Alt** | Suspend automatic snaps (`setSuspended`) |
| **Tab** | Cycle competing candidates |

## Screen tolerance

- Runtime object snap: configurable (`setPixelTolerance`); default historically 16 px.
- Engine default: `DEFAULT_SNAP_SETTINGS.screenTolerancePx` (12 historically).
- Master prompt target: **20 px search / ~15 px priority ring** — tune via settings; spatial index uses world radius derived from camera + pixels.

## Spatial indexing

```ts
import { AabbOctree, PlanQuadtree, aabbFromSegment2 } from "../modules/snapping";

const octree = new AabbOctree({ min: [-100,-5,-100], max: [100,50,100] });
octree.rebuild(items); // { id, aabb }[]
const near = octree.queryRadius([x,y,z], worldRadius);

const plan = new PlanQuadtree({ min: [-100,-100], max: [100,100] });
plan.rebuild(planItems);
const nearPlan = plan.queryRadius(x, z, worldRadius);
```

Broad-phase only — always run engine / magnetic validation afterward.

## Persistent constraints

- Temporary snap ≠ stored relationship (`createTemporarySnapConstraint` vs `convertSnapToPersistentRelationship`).
- Wall–column: `createWallColumnRelationship` + authoring `recordSnapRelationships`.
- Moving columns re-resolves dependents (`updateWallAfterColumnChange` / authoring patches).

## Known limitations

- Full IFC `IfcOpeningElement` authoring depends on the active web-ifc write path; openings may be represented in the app model first.
- Curved / non-rectangular columns: analytic wall–column path returns unsupported diagnostics.
- Spatial index must be rebuilt or incrementally updated by the view/authoring layer when elements change (API provided; not every tool is wired yet).
- 3D skew segment true intersection is not assumed from screen crossings — magnetic module uses plan/segment math; 3D special cases need explicit providers.

## Tests

```bash
npm run test:v73-mag
npm run test:snap-points
node tests/smart-perp-snap.test.cjs
node tests/spatial-index.test.cjs
npm run test:constraints
```
