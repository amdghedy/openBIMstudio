# Solid-kernel spatial welding

## Implemented optimization

`weldVertices` previously compared every vertex against all accepted vertices, producing quadratic work for ordinary meshes. The new implementation uses a tolerance-sized 3D spatial hash and searches the current cell plus its 26 neighbours.

The exact component-wise tolerance predicate and earliest-accepted canonical vertex are preserved. Unsafe coordinate/tolerance ratios and non-positive or non-finite tolerances use a conservative linear fallback.

- Expected work: O(V + C), where C is the number of candidates in adjacent buckets.
- Memory: O(V).
- Worst case: dense buckets can still degrade toward O(V²).
- This is a performance improvement to vertex welding, not a complete CAD boundary-representation kernel and not a claim of exact Boolean robustness.

## Regression test

Run `node tests/solid-kernel-weld.test.cjs`. It covers cell-boundary matching, component-wise tolerance semantics, deterministic canonicalization, topology remapping, legacy tolerance edge cases, and a 60,000-vertex scale fixture.

## Next measured steps

1. Add a spatial plane index to `general-csg.ts` to avoid testing every face against every plane.
2. Accelerate point-in-solid probes with a triangle BVH.
3. Profile federated IFC model rendering, draw calls, memory, and frame time before changing viewport behavior.
