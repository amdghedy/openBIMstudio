/**
 * Spatial acceleration for the Universal Smart Snapping engine.
 *
 *   - AabbOctree  — 3D broad-phase over element AABBs
 *   - PlanQuadtree — 2D XZ index for plan / drafting queries
 *
 * Broad-phase only: candidates still pass screen-space and geometric
 * validation in the snap engine before selection.
 *
 * Pure module: no DOM, no three.js — unit-testable in Node.
 */

export interface Aabb3 {
  min: [number, number, number];
  max: [number, number, number];
}

export interface Aabb2 {
  min: [number, number];
  max: [number, number];
}

export interface SpatialItem3<T = string> {
  id: T;
  aabb: Aabb3;
}

export interface SpatialItem2<T = string> {
  id: T;
  aabb: Aabb2;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_ITEMS = 12;

function expandAabb3(a: Aabb3, b: Aabb3): Aabb3 {
  return {
    min: [
      Math.min(a.min[0], b.min[0]),
      Math.min(a.min[1], b.min[1]),
      Math.min(a.min[2], b.min[2]),
    ],
    max: [
      Math.max(a.max[0], b.max[0]),
      Math.max(a.max[1], b.max[1]),
      Math.max(a.max[2], b.max[2]),
    ],
  };
}

function intersectsAabb3(a: Aabb3, b: Aabb3): boolean {
  return (
    a.min[0] <= b.max[0] && a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] && a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] && a.max[2] >= b.min[2]
  );
}

function containsPoint3(a: Aabb3, p: [number, number, number], pad = 0): boolean {
  return (
    p[0] >= a.min[0] - pad && p[0] <= a.max[0] + pad &&
    p[1] >= a.min[1] - pad && p[1] <= a.max[1] + pad &&
    p[2] >= a.min[2] - pad && p[2] <= a.max[2] + pad
  );
}

function intersectsAabb2(a: Aabb2, b: Aabb2): boolean {
  return (
    a.min[0] <= b.max[0] && a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] && a.max[1] >= b.min[1]
  );
}

function sphereIntersectsAabb3(
  center: [number, number, number],
  radius: number,
  box: Aabb3,
): boolean {
  let d = 0;
  for (let i = 0; i < 3; i++) {
    if (center[i] < box.min[i]) {
      const t = box.min[i] - center[i];
      d += t * t;
    } else if (center[i] > box.max[i]) {
      const t = center[i] - box.max[i];
      d += t * t;
    }
  }
  return d <= radius * radius;
}

// ── Octree ───────────────────────────────────────────────────────────────

interface OctNode<T> {
  bounds: Aabb3;
  depth: number;
  items: SpatialItem3<T>[];
  children: OctNode<T>[] | null;
}

export class AabbOctree<T = string> {
  private root: OctNode<T>;
  private maxDepth: number;
  private maxItems: number;
  private count = 0;

  constructor(
    bounds: Aabb3,
    opts?: { maxDepth?: number; maxItems?: number },
  ) {
    this.maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxItems = opts?.maxItems ?? DEFAULT_MAX_ITEMS;
    this.root = { bounds, depth: 0, items: [], children: null };
  }

  size(): number {
    return this.count;
  }

  clear(): void {
    this.root.items = [];
    this.root.children = null;
    this.count = 0;
  }

  /** Rebuild from a full item list (preferred after bulk model load). */
  rebuild(items: SpatialItem3<T>[]): void {
    this.clear();
    if (!items.length) return;
    let bounds = items[0].aabb;
    for (let i = 1; i < items.length; i++) bounds = expandAabb3(bounds, items[i].aabb);
    // Pad slightly so boundary points stay inside
    const pad = 1e-3;
    this.root.bounds = {
      min: [bounds.min[0] - pad, bounds.min[1] - pad, bounds.min[2] - pad],
      max: [bounds.max[0] + pad, bounds.max[1] + pad, bounds.max[2] + pad],
    };
    for (const it of items) this.insert(it);
  }

  insert(item: SpatialItem3<T>): void {
    this.insertNode(this.root, item);
    this.count++;
  }

  /** Remove by id (linear within touched nodes; OK for incremental edits). */
  remove(id: T): boolean {
    const removed = this.removeNode(this.root, id);
    if (removed) this.count--;
    return removed;
  }

  /** Update AABB for an existing id. */
  update(id: T, aabb: Aabb3): void {
    this.remove(id);
    this.insert({ id, aabb });
  }

  /** All items whose AABB intersects the query box. */
  queryAabb(box: Aabb3): SpatialItem3<T>[] {
    const out: SpatialItem3<T>[] = [];
    this.queryAabbNode(this.root, box, out);
    return out;
  }

  /** Items near a world point within `radius` metres (sphere vs AABB). */
  queryRadius(center: [number, number, number], radius: number): SpatialItem3<T>[] {
    const box: Aabb3 = {
      min: [center[0] - radius, center[1] - radius, center[2] - radius],
      max: [center[0] + radius, center[1] + radius, center[2] + radius],
    };
    const broad = this.queryAabb(box);
    return broad.filter((it) => sphereIntersectsAabb3(center, radius, it.aabb));
  }

  private insertNode(node: OctNode<T>, item: SpatialItem3<T>): void {
    if (!intersectsAabb3(node.bounds, item.aabb)) return;
    if (!node.children) {
      node.items.push(item);
      if (node.items.length > this.maxItems && node.depth < this.maxDepth) {
        this.subdivide(node);
      }
      return;
    }
    for (const ch of node.children) {
      if (intersectsAabb3(ch.bounds, item.aabb)) this.insertNode(ch, item);
    }
  }

  private subdivide(node: OctNode<T>): void {
    const { min, max } = node.bounds;
    const mx = (min[0] + max[0]) / 2;
    const my = (min[1] + max[1]) / 2;
    const mz = (min[2] + max[2]) / 2;
    const mk = (lo: [number, number, number], hi: [number, number, number]): OctNode<T> => ({
      bounds: { min: lo, max: hi },
      depth: node.depth + 1,
      items: [],
      children: null,
    });
    node.children = [
      mk([min[0], min[1], min[2]], [mx, my, mz]),
      mk([mx, min[1], min[2]], [max[0], my, mz]),
      mk([min[0], my, min[2]], [mx, max[1], mz]),
      mk([mx, my, min[2]], [max[0], max[1], mz]),
      mk([min[0], min[1], mz], [mx, my, max[2]]),
      mk([mx, min[1], mz], [max[0], my, max[2]]),
      mk([min[0], my, mz], [mx, max[1], max[2]]),
      mk([mx, my, mz], [max[0], max[1], max[2]]),
    ];
    const migrating = node.items;
    node.items = [];
    for (const it of migrating) {
      for (const ch of node.children) {
        if (intersectsAabb3(ch.bounds, it.aabb)) this.insertNode(ch, it);
      }
    }
  }

  private queryAabbNode(node: OctNode<T>, box: Aabb3, out: SpatialItem3<T>[]): void {
    if (!intersectsAabb3(node.bounds, box)) return;
    for (const it of node.items) {
      if (intersectsAabb3(it.aabb, box)) out.push(it);
    }
    if (node.children) {
      for (const ch of node.children) this.queryAabbNode(ch, box, out);
    }
  }

  private removeNode(node: OctNode<T>, id: T): boolean {
    const before = node.items.length;
    node.items = node.items.filter((it) => it.id !== id);
    let removed = node.items.length < before;
    if (node.children) {
      for (const ch of node.children) {
        if (this.removeNode(ch, id)) removed = true;
      }
    }
    return removed;
  }
}

// ── Plan quadtree (XZ) ───────────────────────────────────────────────────

interface QuadNode<T> {
  bounds: Aabb2;
  depth: number;
  items: SpatialItem2<T>[];
  children: QuadNode<T>[] | null;
}

export class PlanQuadtree<T = string> {
  private root: QuadNode<T>;
  private maxDepth: number;
  private maxItems: number;
  private count = 0;

  constructor(
    bounds: Aabb2,
    opts?: { maxDepth?: number; maxItems?: number },
  ) {
    this.maxDepth = opts?.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxItems = opts?.maxItems ?? DEFAULT_MAX_ITEMS;
    this.root = { bounds, depth: 0, items: [], children: null };
  }

  size(): number {
    return this.count;
  }

  clear(): void {
    this.root.items = [];
    this.root.children = null;
    this.count = 0;
  }

  rebuild(items: SpatialItem2<T>[]): void {
    this.clear();
    if (!items.length) return;
    let minX = items[0].aabb.min[0], minZ = items[0].aabb.min[1];
    let maxX = items[0].aabb.max[0], maxZ = items[0].aabb.max[1];
    for (let i = 1; i < items.length; i++) {
      const a = items[i].aabb;
      minX = Math.min(minX, a.min[0]); minZ = Math.min(minZ, a.min[1]);
      maxX = Math.max(maxX, a.max[0]); maxZ = Math.max(maxZ, a.max[1]);
    }
    const pad = 1e-3;
    this.root.bounds = {
      min: [minX - pad, minZ - pad],
      max: [maxX + pad, maxZ + pad],
    };
    for (const it of items) this.insert(it);
  }

  insert(item: SpatialItem2<T>): void {
    this.insertNode(this.root, item);
    this.count++;
  }

  remove(id: T): boolean {
    const removed = this.removeNode(this.root, id);
    if (removed) this.count--;
    return removed;
  }

  update(id: T, aabb: Aabb2): void {
    this.remove(id);
    this.insert({ id, aabb });
  }

  queryAabb(box: Aabb2): SpatialItem2<T>[] {
    const out: SpatialItem2<T>[] = [];
    this.queryAabbNode(this.root, box, out);
    return out;
  }

  /** Circle query in plan (centre xz, radius metres). */
  queryRadius(cx: number, cz: number, radius: number): SpatialItem2<T>[] {
    const box: Aabb2 = {
      min: [cx - radius, cz - radius],
      max: [cx + radius, cz + radius],
    };
    const r2 = radius * radius;
    return this.queryAabb(box).filter((it) => {
      // Closest point on AABB to centre
      const px = Math.max(it.aabb.min[0], Math.min(cx, it.aabb.max[0]));
      const pz = Math.max(it.aabb.min[1], Math.min(cz, it.aabb.max[1]));
      const dx = px - cx, dz = pz - cz;
      return dx * dx + dz * dz <= r2;
    });
  }

  private insertNode(node: QuadNode<T>, item: SpatialItem2<T>): void {
    if (!intersectsAabb2(node.bounds, item.aabb)) return;
    if (!node.children) {
      node.items.push(item);
      if (node.items.length > this.maxItems && node.depth < this.maxDepth) {
        this.subdivide(node);
      }
      return;
    }
    for (const ch of node.children) {
      if (intersectsAabb2(ch.bounds, item.aabb)) this.insertNode(ch, item);
    }
  }

  private subdivide(node: QuadNode<T>): void {
    const { min, max } = node.bounds;
    const mx = (min[0] + max[0]) / 2;
    const mz = (min[1] + max[1]) / 2;
    const mk = (lo: [number, number], hi: [number, number]): QuadNode<T> => ({
      bounds: { min: lo, max: hi },
      depth: node.depth + 1,
      items: [],
      children: null,
    });
    node.children = [
      mk([min[0], min[1]], [mx, mz]),
      mk([mx, min[1]], [max[0], mz]),
      mk([min[0], mz], [mx, max[1]]),
      mk([mx, mz], [max[0], max[1]]),
    ];
    const migrating = node.items;
    node.items = [];
    for (const it of migrating) {
      for (const ch of node.children) {
        if (intersectsAabb2(ch.bounds, it.aabb)) this.insertNode(ch, it);
      }
    }
  }

  private queryAabbNode(node: QuadNode<T>, box: Aabb2, out: SpatialItem2<T>[]): void {
    if (!intersectsAabb2(node.bounds, box)) return;
    for (const it of node.items) {
      if (intersectsAabb2(it.aabb, box)) out.push(it);
    }
    if (node.children) {
      for (const ch of node.children) this.queryAabbNode(ch, box, out);
    }
  }

  private removeNode(node: QuadNode<T>, id: T): boolean {
    const before = node.items.length;
    node.items = node.items.filter((it) => it.id !== id);
    let removed = node.items.length < before;
    if (node.children) {
      for (const ch of node.children) {
        if (this.removeNode(ch, id)) removed = true;
      }
    }
    return removed;
  }
}

/** Helper: AABB from a plan segment with thickness. */
export function aabbFromSegment2(
  a: [number, number],
  b: [number, number],
  halfWidth = 0,
): Aabb2 {
  return {
    min: [
      Math.min(a[0], b[0]) - halfWidth,
      Math.min(a[1], b[1]) - halfWidth,
    ],
    max: [
      Math.max(a[0], b[0]) + halfWidth,
      Math.max(a[1], b[1]) + halfWidth,
    ],
  };
}

/** Helper: world AABB from a plan point footprint. */
export function aabbFromPoint2(
  p: [number, number],
  halfSize: number,
  yMin = 0,
  yMax = 3,
): Aabb3 {
  return {
    min: [p[0] - halfSize, yMin, p[1] - halfSize],
    max: [p[0] + halfSize, yMax, p[1] + halfSize],
  };
}
