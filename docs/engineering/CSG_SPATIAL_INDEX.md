# CSG spatial-index optimization

This change accelerates support-plane deduplication in both the convex CSG and general Boolean paths. A four-dimensional tolerance-sized hash indexes the oriented plane tuple (normal X/Y/Z and plane offset). Candidate matches are checked in adjacent cells with the exact pre-existing component-wise tolerance predicate; the earliest matching plane remains canonical.

Unsafe coordinate-to-tolerance ratios are retained in an overflow list and checked linearly, preserving legacy behavior for large coordinate offsets. The polygon-soup `weldMesh` path now uses a 3D spatial hash with the same component-wise tolerance and deterministic first-match behavior.

## Scope and limitations

- Accelerates plane extraction/deduplication and plane-index lookup; it does not yet remove the general Boolean algorithm's global fragment-by-cut-plane workload.
- `trianglesOnPlane`, `edgesOnPlane`, and robust ray-based inside tests remain candidates for subsequent spatial acceleration.
- Dense buckets can still degrade toward linear scans.
- No Boolean semantics, probe tolerances, or topology-repair behavior are intentionally changed.

## Verification

Run `npm run test:csg-spatial-index` and `npm run test:v70`. The focused suite checks repeated coplanar faces, large-coordinate fallback, weld tolerance semantics, degenerate face removal, and a 50,000-vertex scale fixture.
