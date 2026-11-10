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
