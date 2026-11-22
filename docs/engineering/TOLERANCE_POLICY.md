# Unified Tolerance Policy (PE-10)

Status: normative for the geometric kernel. Code source of truth:
`src/modules/solid-kernel/tolerance.ts`. Every epsilon the kernel uses is
imported from that module; no per-module literal epsilon may be added.
This document replaces the old "spec 5.2" comment citations, which pointed
at a document that did not exist in the repo.

## 1. Why one policy

Before PE-10, epsilons were per-module absolute literals spanning 1e-15–
1e-6 (plus 20 px snap and 5 mm clash), with no stated relationship between
them and no answer to "what happens to degenerate input". The worst
consequence was scale: a 1e-9 m epsilon is below float64 spacing
(~2.4e-7 m) at the 1e9-scale coordinates the twin-writer property already
feeds, so classification decisions there were rounding noise. Degenerate
handling was also mixed: fail-closed in `forms.ts`/`csg.ts`, silent drop
in `general-csg.ts` (sub-1e-12 m² cells) and silent `null`/`[]` in
`poly-boolean.ts`.

## 2. Domains — do not conflate them

| Domain | Unit | Where it lives | Rule |
|---|---|---|---|
| Geometric tolerance | m / m² / rad | `solid-kernel/tolerance.ts` | Scale-relative (§3). Used for welding, classification, splitting, probes, plane matching. |
| Screen-space tolerance | px | `snapping/engine.ts` (`screenTolerancePx: 20`, `depthWindow: 2.0 m`, `hysteresis: 1.15`) | Interaction only. NEVER reused for boolean work. |
| User-facing tolerance | m | `features/clash.ts` (default clash tolerance 0.005 m = 5 mm) | A user preference, not a geometric fact. |
| Camera/zoom guards | m | `core/cursor-zoom.ts` (1e-9 / 1e-6) | View guards, not geometry. |

## 3. Scale rule

Every geometric tolerance is an absolute floor plus a scale-relative term:

```
tolerance(base, magnitude) = max(base, magnitude × Number.EPSILON × 8)
```

`Number.EPSILON` is float64 machine epsilon (2^-52); the factor 8 keeps a
working tolerance at least 8 ulps above float64 spacing at the coordinates
it is applied to. Area tolerances grow as the square of the length
tolerance (`scaledAreaTolerance`).

Float64 spacing vs. the coincident (weld) tolerance at representative
coordinate magnitudes:

| \|coordinate\| | float64 spacing (≈1 ulp) | coincident tolerance |
|---|---|---|
| 1 m | 2.2e-16 m | 1e-9 m (base) |
| 1e3 m | 2.2e-13 m | 1e-9 m (base) |
| 1e5 m | 2.2e-11 m | 1e-9 m (base) |
| 1e6 m | 2.2e-10 m | 1.8e-9 m (scaled) |
| 1e9 m | 2.2e-7 m | 1.8e-6 m (scaled) |

At ordinary BIM scales (≤ ~1e5 m) every historical value applies
unchanged (the crossover where the scale term passes the 1e-9 base is
~5.6e5 m). Above that the tolerance grows linearly instead of silently
going below representable precision.

Where scale-relative tolerances are applied today:

- `brep.weldVertices` — default tolerance is
  `coincidentTolerance(meshMagnitude(solid))`; an explicitly passed `tol`
  is honoured exactly.
- `csg.splitAgainstConvex` — classification epsilon scales with the
  operand mesh magnitude; `booleanOp` probe displacement and
  `pointInsideMeshWithBvh` ray epsilon scale likewise (magnitude cached
  on the BVH).
- `general-csg.generalBoolean` — one `ToleranceContext` per call, built
  from the larger operand magnitude, covers split / on-plane / probe /
  sliver-area tolerances.

Where they are deliberately NOT scale-relative (stated limitation):
2D profile tolerances in `forms.ts` (segment-parallel denominator,
parameter window) are absolute in profile-coordinate units — the
denominator is in m² and the parameter is dimensionless, so neither has a
meaningful linear scale law. Profiles beyond ~1e6 m are outside the
supported envelope. Exact arithmetic / derived error bounds are PE-11,
not this policy: nothing here claims exactness the float64 code cannot
back.

## 4. Degenerate-input policy

1. **Degenerate caller input fails closed with a typed error.**
   Too few points, non-finite coordinates, or a non-positive size throw
   `DegenerateInputError` (`code: "degenerate-input"`, with a `reason`:
   `too-few-points` | `non-finite-coordinate` | `non-positive-size` |
   `empty-polygon`). Applies to `poly-boolean.booleanPoly` /
   `booleanSolid` (previously silent `[]` / `null`) and, already before
   this policy, to `forms.validateProfile` (`FormError`) and the convex
   kernel's preconditions. Never coerce, never silently drop.
2. **A legitimately empty result is a value, not a failure.**
   Disjoint polygons under `intersect`, or a boolean whose operands do
   not overlap, return `[]` / `null` as before — but the `*Detailed`
   entry points (`booleanPolyDetailed`, `booleanSolidDetailed`,
   `generalBooleanDetailed`) report it as an `empty-result` diagnostic,
   so a caller can tell "empty because disjoint" from "empty because
   broken". `segIntersect` returning `null` for parallel / non-crossing
   segments is likewise a legitimate "no intersection" outcome.
3. **Algorithm-generated noise is recorded, never silently dropped.**
   General-CSG sliver cells (below the sliver-area cutoff) and degenerate
   input triangles skipped during plane extraction / splitting are
   recorded as `sliver-cell-dropped` / `degenerate-triangle-skipped`
   diagnostics (count + total area for slivers), aggregated per
   operation. `generalBoolean(op, a, b, { diagnostics })` collects them
   into a caller-supplied array; `generalBooleanDetailed` returns them.
   Callers that need fail-closed behaviour assert the diagnostics list
   is empty. Sliver drops are NOT errors: the fragments are artefacts of
   the plane-arrangement split itself (splitting creates arbitrarily thin
   fragments at near-coincident planes), not caller errors — failing
   closed on them would make ordinary coplanar booleans throw.
4. **Validation never silently repairs** (unchanged, `validate.ts`):
   diagnostics are reported; nothing is auto-healed.

## 5. Value table (base values at ordinary scales)

All values live in `src/modules/solid-kernel/tolerance.ts`.

| Constant | Value | Unit | Used by |
|---|---|---|---|
| COINCIDENT_TOLERANCE | 1e-9 | m | brep weld / profile closure, shell, hosting |
| CLASSIFICATION_TOLERANCE | 1e-9 | m | csg half-space classification |
| PLANE_MATCH_TOLERANCE | 1e-9 | m / — | csg + general-csg plane merge |
| SPLIT_TOLERANCE | 1e-9 | m | general-csg fragment splitting |
| ON_PLANE_TOLERANCE | 1e-8 | m | general-csg coplanar tagging |
| PROBE_TOLERANCE | 1e-6 | m | general-csg + csg inside/outside probes |
| COPLANAR_CHECK_TOLERANCE | 1e-6 | m | csg.coplanarWithAny |
| SLIVER_AREA_TOLERANCE | 1e-12 | m² | general-csg sliver cutoff (recorded, §4.3) |
| TRIANGLE_CROSS_TOLERANCE | 1e-12 | m² | degenerate-triangle detection |
| RAY_DETERMINANT_TOLERANCE | 1e-15 | — | csg ray casting |
| RAY_EPSILON | 1e-9 | m | csg point-in-mesh queries |
| FACE_NORMAL_TOLERANCE | 1e-15 | — | brep Newell normal magnitude |
| SEGMENT_PARALLEL_DENOMINATOR | 1e-15 | m² | forms profile intersection |
| SEGMENT_PARAMETER_TOLERANCE | 1e-12 | — | forms segment parameter window |
| REVOLUTION_ANGLE_TOLERANCE | 1e-9 | rad | forms revolve angle validity |
| REVOLUTION_AXIS_TOLERANCE | 1e-12 | m | forms zero-length axis |
| RADIAL_FRAME_TOLERANCE | 1e-12 | m | forms radial frame |
| RESAMPLE_DENOMINATOR | 1e-15 | m² | forms polar resample |
| ANGLE_DEDUPE_TOLERANCE | 1e-9 | rad | forms shared sample angles |
| WELD_MESH_TOLERANCE | 1e-7 | m | general-csg weldMesh default |
| EDGE_KEY_GRID | 1e-7 | m | general-csg on-plane edge keys |
| BARYCENTRIC_TOLERANCE | 1e-12 | — | general-csg point-in-triangle |
| EDGE_LENGTH_TOLERANCE | 1e-12 | m | general-csg cut-object edges |
| EDGE_NORMAL_TOLERANCE | 1e-12 | m² | general-csg cut-object normals |
| ROTATION_AXIS_TOLERANCE | 1e-15 | m | modify/transform zero-length axis |
| AABB_OVERLAP_TOLERANCE | 1e-12 | m | voids AABB overlap |
| TRIANGLE_PLANE_TOLERANCE | 1e-12 | m | voids triangle/triangle test |
| COPLANAR_DIRECTION_TOLERANCE | 1e-15 | — | voids coplanar direction |
| INTERVAL_OVERLAP_TOLERANCE | 1e-15 | m | voids interval overlap |
| SHELL_PARALLEL_DENOMINATOR | 1e-12 | m² | shell line intersection |
| SHELL_PARALLEL_SINE | 1e-9 | — | shell collinearity |
| SHELL_POINT_TOLERANCE | 1e-9 | m | shell ring cleanup |
| SNAP_GEOMETRIC_TOLERANCE | 1e-9 | m | snapping/magnetic |
| SNAP_PARAMETER_TOLERANCE | 1e-9 | — | snapping/magnetic parameter window |
| POLY_POINT_GUARD | 1e-15 | — | poly-boolean point-in-poly guard |
| POLY_SEGMENT_DENOMINATOR | 1e-12 | m² | poly-boolean segment intersection |
| POLY_PARAMETER_TOLERANCE | 1e-9 | — | poly-boolean parameter window |
| POLY_CLIP_TOLERANCE | 1e-9 | m² | poly-boolean clip half-plane |

## 6. What this policy does NOT claim

- No exact arithmetic and no derived error bounds anywhere (PE-11).
  "Robust" point-in-solid remains the 2-of-3 ray-cast majority vote in
  `csg.ts`, not exact predicates.
- No claim that a tolerance that is right at 1 m is right at 1e9 m for
  every operation — only that it stays above float64 spacing. Semantic
  correctness of booleans at extreme coordinates is not proven here.
- `extrudeMesh` (`poly-boolean.ts`) still returns an empty mesh for
  degenerate input: it is a preview-only mesh builder whose empty result
  is a renderable no-op, and its callers guard inputs upstream. It is a
  known exception, not an oversight.

## 7. Named follow-ups (not migrated in PE-10)

- `snapping/engine.ts:86-88,340` — screen tolerance 20 px, depth window
  2.0 m, hysteresis 1.15, reference-moved 1e-6 m: separate interaction
  domain (§2); migrate the 1e-6 m reference-moved check to the policy
  module when the snap engine is next touched.
- `features/clash.ts:1149` — default clash tolerance 0.005 m: user-facing
  preference; give it a named constant in the clash module.
- `core/cursor-zoom.ts:61,63,82` — camera guards 1e-9 / 1e-6: view domain;
  name them in the cursor-zoom module.
- `snapping/magnetic.ts:146` — `Math.max(1e-6, cameraDistance)` floor:
  camera-distance guard, not a geometric tolerance.
- `solid-kernel/loft.ts` — no epsilons of its own (only a comment citing
  the 1e-9 volume assertion tolerance, which is a test tolerance, not a
  kernel tolerance).
