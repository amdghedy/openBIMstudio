/**
 * Per-element triangle BVH.
 *
 * Purpose: replace the O(n·m) double loop in meshFaceClash with an
 * O(n log n + k) traversal where k is the number of candidate pairs that
 * actually overlap in space. On two 2,500-triangle elements this is
 * typically a 100–1,000× reduction in tri-tri tests.
 *
 * Median split on the longest centroid axis. Iterative traversal.
 * Node bounds are NOT expanded by tolerance — the caller expands when
 * comparing, because tolerance is a per-query parameter, not a per-tree one.
 */
import * as THREE from "three";
import type { Tri } from "./geometry";

interface BVHNode {
  box: THREE.Box3;
  left: BVHNode | null;
  right: BVHNode | null;
  /** Leaf range: [start, end). Internal nodes have start === end === 0. */
  start: number;
  end: number;
}

const MAX_LEAF = 8;

/** Scratch — used only inside build and traversal; never escapes. */
const _tmpA = new THREE.Box3();
const _tmpB = new THREE.Box3();
const _v = new THREE.Vector3();

export class TriangleBVH {
  /** Public so meshFaceClashBVH can index triangles without a copy. */
  readonly tris: Tri[];
  private order: number[];
  private root: BVHNode;

  constructor(tris: Tri[]) {
    this.tris = tris;
    this.order = new Array(tris.length);
    for (let i = 0; i < tris.length; i++) this.order[i] = i;
    this.root = this.build(0, tris.length);
  }

  get triCount(): number {
    return this.tris.length;
  }

  /** Depth-first triple count — useful for diagnostics. */
  stats(): { triangles: number; depth: number; nodes: number; leaves: number } {
    let depth = 0, nodes = 0, leaves = 0;
    const walk = (n: BVHNode, d: number) => {
      nodes++;
      if (d > depth) depth = d;
      if (!n.left && !n.right) {
        leaves++;
        return;
      }
      if (n.left) walk(n.left, d + 1);
      if (n.right) walk(n.right, d + 1);
    };
    walk(this.root, 0);
    return { triangles: this.tris.length, depth, nodes, leaves };
  }

  /**
   * Visit every candidate (i, j) triangle pair whose world-space AABBs
   * overlap within `tolerance` (expanded symmetrically on each side).
   *
   * `cb` returns true to continue, false to stop immediately.
   */
  visitCandidatePairs(
    other: TriangleBVH,
    tolerance: number,
    cb: (i: number, j: number) => boolean,
  ): void {
    const half = tolerance > 0 ? tolerance / 2 : 0;
    const stack: Array<[BVHNode | null, BVHNode | null]> = [[this.root, other.root]];

    while (stack.length) {
      const top = stack.pop()!;
      const a = top[0];
      const b = top[1];
      if (!a || !b) continue;

      // Bounds-overlap test with tolerance on each side.
      _tmpA.copy(a.box);
      _tmpB.copy(b.box);
      if (half > 0) {
        _tmpA.expandByScalar(half);
        _tmpB.expandByScalar(half);
      }
      if (!_tmpA.intersectsBox(_tmpB)) continue;

      const aLeaf = !a.left && !a.right;
      const bLeaf = !b.left && !b.right;

      if (aLeaf && bLeaf) {
        // Emit every pair; per-triangle AABB test is cheap and further
        // prunes before Möller.
        for (let i = a.start; i < a.end; i++) {
          const ia = this.order[i];
          const ta = this.tris[ia];
          const aMinX = Math.min(ta[0], ta[3], ta[6]);
          const aMaxX = Math.max(ta[0], ta[3], ta[6]);
          const aMinY = Math.min(ta[1], ta[4], ta[7]);
          const aMaxY = Math.max(ta[1], ta[4], ta[7]);
          const aMinZ = Math.min(ta[2], ta[5], ta[8]);
          const aMaxZ = Math.max(ta[2], ta[5], ta[8]);
          for (let j = b.start; j < b.end; j++) {
            const ib = other.order[j];
            const tb = other.tris[ib];
            const bMinX = Math.min(tb[0], tb[3], tb[6]);
            const bMaxX = Math.max(tb[0], tb[3], tb[6]);
            if (bMaxX + half < aMinX - half || aMaxX + half < bMinX - half) continue;
            const bMinY = Math.min(tb[1], tb[4], tb[7]);
            const bMaxY = Math.max(tb[1], tb[4], tb[7]);
            if (bMaxY + half < aMinY - half || aMaxY + half < bMinY - half) continue;
            const bMinZ = Math.min(tb[2], tb[5], tb[8]);
            const bMaxZ = Math.max(tb[2], tb[5], tb[8]);
            if (bMaxZ + half < aMinZ - half || aMaxZ + half < bMinZ - half) continue;
            if (!cb(ia, ib)) return;
          }
        }
      } else if (aLeaf) {
        stack.push([a, b.left]);
        stack.push([a, b.right]);
      } else if (bLeaf) {
        stack.push([a.left, b]);
        stack.push([a.right, b]);
      } else {
        // Descend the larger node first to balance work.
        const volA = a.box.getSize(_v).lengthSq();
        const volB = b.box.getSize(_v).lengthSq();
        if (volA >= volB) {
          stack.push([a.left, b]);
          stack.push([a.right, b]);
        } else {
          stack.push([a, b.left]);
          stack.push([a, b.right]);
        }
      }
    }
  }

  // ── Build ─────────────────────────────────────────────────────────
  private triBox(i: number, out: THREE.Box3): THREE.Box3 {
    const t = this.tris[i];
    out.min.set(
      Math.min(t[0], t[3], t[6]),
      Math.min(t[1], t[4], t[7]),
      Math.min(t[2], t[5], t[8]),
    );
    out.max.set(
      Math.max(t[0], t[3], t[6]),
      Math.max(t[1], t[4], t[7]),
      Math.max(t[2], t[5], t[8]),
    );
    return out;
  }

  private build(start: number, end: number): BVHNode {
    const box = new THREE.Box3();
    const node: BVHNode = { box, left: null, right: null, start: 0, end: 0 };

    // Compute aggregate bounds and centroid extent.
    const centroidBox = new THREE.Box3();
    for (let i = start; i < end; i++) {
      const t = this.tris[this.order[i]];
      box.expandByPoint(_v.set(t[0], t[1], t[2]));
      box.expandByPoint(_v.set(t[3], t[4], t[5]));
      box.expandByPoint(_v.set(t[6], t[7], t[8]));
      _v.set(
        (t[0] + t[3] + t[6]) / 3,
        (t[1] + t[4] + t[7]) / 3,
        (t[2] + t[5] + t[8]) / 3,
      );
      centroidBox.expandByPoint(_v);
    }

    const count = end - start;
    if (count <= MAX_LEAF) {
      node.start = start;
      node.end = end;
      return node;
    }

    // Split on the longest centroid axis.
    const size = centroidBox.getSize(_v);
    let axis: 0 | 1 | 2 = 0;
    if (size.y > size.x) axis = 1;
    if (size.z > (axis === 0 ? size.x : size.y)) axis = 2;

    // Sort the subrange by centroid on `axis`. We only sort the slice
    // needed at this node, keeping the global `order` array mutated
    // in place. This is the standard approach for BVH build.
    const sub = this.order.slice(start, end);
    const key = (idx: number) => {
      const t = this.tris[idx];
      return (t[axis * 3] + t[axis * 3 + 3] + t[axis * 3 + 6]) / 3;
    };
    sub.sort((a, b) => key(a) - key(b));
    for (let i = 0; i < sub.length; i++) this.order[start + i] = sub[i];

    const mid = start + (count >> 1);
    node.left = this.build(start, mid);
    node.right = this.build(mid, end);
    return node;
  }
}