/**
 * Uniform 3D spatial hash for broadphase candidate lookup.
 *
 * Cell size is chosen from the median item diagonal. Each item is inserted
 * into every cell its AABB overlaps. Queries return the union of items in
 * the same cells — a superset of the true AABB-overlap set, so the caller
 * must still do the actual Box3 test (which is cheap).
 */
import * as THREE from "three";

export class SpatialHash {
  private readonly cellSize: number;
  private readonly buckets = new Map<string, number[]>();
  private readonly itemBoxes: THREE.Box3[] = [];

  constructor(cellSize: number) {
    this.cellSize = Math.max(cellSize, 1e-3);
  }

  get size(): number {
    return this.itemBoxes.length;
  }

  get cell(): number {
    return this.cellSize;
  }

  /** Insert an item's world-space AABB and get its index back. */
  insert(box: THREE.Box3): number {
    const idx = this.itemBoxes.length;
    this.itemBoxes.push(box.clone());

    const i0 = Math.floor(box.min.x / this.cellSize);
    const i1 = Math.floor(box.max.x / this.cellSize);
    const j0 = Math.floor(box.min.y / this.cellSize);
    const j1 = Math.floor(box.max.y / this.cellSize);
    const k0 = Math.floor(box.min.z / this.cellSize);
    const k1 = Math.floor(box.max.z / this.cellSize);

    const cells = (i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1);
    if (!Number.isFinite(cells) || cells > 4096) {
      const arr = this.buckets.get("*") ?? [];
      arr.push(idx);
      this.buckets.set("*", arr);
      return idx;
    }

    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (let k = k0; k <= k1; k++) {
          const key = `${i},${j},${k}`;
          const arr = this.buckets.get(key);
          if (arr) arr.push(idx);
          else this.buckets.set(key, [idx]);
        }
      }
    }
    return idx;
  }

  /**
   * Fill `out` with candidate indices whose cells overlap the query box.
   * `out` is cleared first. Excludes `selfIdx` if it appears.
   */
  query(box: THREE.Box3, out: Set<number>, selfIdx = -1): void {
    out.clear();

    const i0 = Math.floor(box.min.x / this.cellSize);
    const i1 = Math.floor(box.max.x / this.cellSize);
    const j0 = Math.floor(box.min.y / this.cellSize);
    const j1 = Math.floor(box.max.y / this.cellSize);
    const k0 = Math.floor(box.min.z / this.cellSize);
    const k1 = Math.floor(box.max.z / this.cellSize);

    const cells = (i1 - i0 + 1) * (j1 - j0 + 1) * (k1 - k0 + 1);
    if (!Number.isFinite(cells) || cells > 4096) {
      for (let i = 0; i < this.itemBoxes.length; i++) {
        if (i !== selfIdx) out.add(i);
      }
      return;
    }

    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        for (let k = k0; k <= k1; k++) {
          const arr = this.buckets.get(`${i},${j},${k}`);
          if (!arr) continue;
          for (const idx of arr) {
            if (idx !== selfIdx) out.add(idx);
          }
        }
      }
    }

    const global = this.buckets.get("*");
    if (global) {
      for (const idx of global) {
        if (idx !== selfIdx) out.add(idx);
      }
    }
  }

  boxAt(idx: number): THREE.Box3 | undefined {
    return this.itemBoxes[idx];
  }

  /** Choose a sensible cell size from a sample of item sizes. */
  static suggestCellSize(boxes: readonly THREE.Box3[], fallback = 2): number {
    if (boxes.length === 0) return fallback;
    const sample = boxes.slice(0, Math.min(boxes.length, 512));
    const diag = new THREE.Vector3();
    const sizes: number[] = [];
    for (const b of sample) {
      b.getSize(diag);
      const d = Math.hypot(diag.x, diag.y, diag.z);
      if (Number.isFinite(d) && d > 0) sizes.push(d);
    }
    if (!sizes.length) return fallback;
    sizes.sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    return Math.max(0.25, Math.min(median * 1.5, 25));
  }
}
