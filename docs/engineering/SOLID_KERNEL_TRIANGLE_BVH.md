# Triangle BVH acceleration

The solid kernel now exposes a median-split triangle BVH for repeated ray queries.

## API
- `createTriangleBvh(mesh)`: builds a reusable hierarchy over triangle AABBs.
- `pointInsideMeshWithBvh(bvh, origin, direction)`: traverses only ray-overlapping BVH nodes, then uses the existing Möller–Trumbore triangle predicate.
- `createRobustInsideTester(mesh)`: builds once and reuses the hierarchy for the three-direction majority test.
- `pointInsideMesh` and `isInsideRobust` remain compatibility helpers for one-off calls.

The general Boolean kernel now constructs one robust tester per operand and reuses it for all fragment probes. This avoids rebuilding an acceleration structure for each probe.

## Correctness and limits
The triangle intersection predicate and crossing parity are unchanged. BVH traversal only prunes triangles whose bounding boxes cannot intersect the ray. The current hierarchy uses median splits on the longest node axis and leaves of at most eight triangles.

This is a ray-query acceleration step, not a replacement for the Boolean kernel's global plane-arrangement splitting. Repeated calls to the compatibility helpers still build temporary trees; batch callers should use the reusable tester API.

## Boolean fragment cut broad phase

`general-csg.ts` now filters the global cut list once for each original source triangle, before any fragment is generated. A cut is retained if the source triangle is split by that plane or lies on it within the existing split tolerance; both conditions are evaluated with the same signed-distance thresholds and classification order as `splitPoly`.

This is conservative because every generated fragment is contained in its source triangle. A plane that places all three source vertices strictly on the same side cannot split any descendant or create a coplanar tag. Retained cuts preserve their original order, including face-plane ownership, so the coplanar resolution rules remain unchanged.

The filter intentionally does not approximate an infinite plane with a finite cutter bounding box. In worst-case geometry, many planes may still intersect many source triangles; the gain comes from avoiding rescanning irrelevant planes for every fragment after subdivision has multiplied the fragment count.

Correctness is guarded by the existing `test:v70` general Boolean fixtures (overlapping, disjoint, stacked and side-by-side solids, non-convex operands, coplanar ownership, watertightness and volume checks). The full CI suite must pass before merge.