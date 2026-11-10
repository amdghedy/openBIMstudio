# Conservative finite-support BVH for Boolean cuts

## Problem

The general Boolean kernel previously visited the complete global cut-object list for every source triangle. A cut object is an infinite support plane, so a finite plane AABB is not a valid pruning bound. That made the obvious spatial-index optimization unsafe.

## Change

Each face-plane cut retains the finite triangle patch that generated it. Each edge-perpendicular cut retains the finite source triangle bounds containing its edge. When equal cut objects are deduplicated, every generating support patch is retained.

A median-split AABB BVH indexes those finite patches. For each source triangle, the kernel queries overlapping support bounds, deduplicates and sorts cut-object indices, then applies the existing signed-distance candidate predicate. The predicate, tolerance, plane order, coplanar tagging, fragment splitting, and inside/outside classification are unchanged.

## Conservative correctness argument

A real intersection between a source triangle and a finite cutter triangle/edge must lie inside both objects' axis-aligned bounding boxes. Therefore their 3D AABBs overlap (including boundary contact). The BVH query is inclusive and uses a small tolerance. It returns every cut object having at least one overlapping finite support patch. The exact signed-distance test then decides whether that plane can split or coplanarly tag the source triangle.

The index never bounds or clips an infinite plane. If a support bound is non-finite or invalid, its cut object is placed in an overflow list and included in every query. A malformed query falls back to all cut objects. Multiple disjoint patches generating the same deduplicated plane are all indexed.

## Complexity and limits

BVH construction is approximately O(S log S), where S is the number of finite support patches. A query is typically O(log S + K), where K is the number of overlapping support patches, followed by the exact cut-plane predicate for the unique candidate cuts. Highly overlapping bounds can still approach a full scan. This does not claim subquadratic behavior for pathological dense intersections.

## Validation

- Deterministic randomized query parity against a brute-force AABB scan.
- Multiple disjoint support patches for one deduplicated plane.
- Invalid-bound and invalid-query conservative fallbacks.
- Existing v0.70 Boolean integration fixtures for union, intersection, and subtraction.
- Existing coplanar, non-convex, watertightness and volume tests remain in the CI suite.
