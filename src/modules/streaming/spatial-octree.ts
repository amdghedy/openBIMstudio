/**
 * Spatial Octree Partitioning for Large BIM Models
 *
 * Provides hierarchical 3D spatial partitioning for out-of-core streaming,
 * high-performance frustum culling, distance-based LOD calculation, and ray queries.
 */

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface BoundingBox3D {
  min: [number, number, number];
  max: [number, number, number];
}

export interface Plane3D {
  normal: [number, number, number]; // [nx, ny, nz] unit normal
  distance: number; // plane distance (dot(normal, pt) + distance = 0)
}

export interface OctreeItem<T = any> {
  id: string | number;
  bbox: BoundingBox3D;
  data?: T;
}

export function createBoundingBox(min: [number, number, number], max: [number, number, number]): BoundingBox3D {
  return {
    min: [Math.min(min[0], max[0]), Math.min(min[1], max[1]), Math.min(min[2], max[2])],
    max: [Math.max(min[0], max[0]), Math.max(min[1], max[1]), Math.max(min[2], max[2])],
  };
}

export function boxCenter(box: BoundingBox3D): [number, number, number] {
  return [
    (box.min[0] + box.max[0]) * 0.5,
    (box.min[1] + box.max[1]) * 0.5,
    (box.min[2] + box.max[2]) * 0.5,
  ];
}

export function boxSize(box: BoundingBox3D): [number, number, number] {
  return [
    Math.max(0, box.max[0] - box.min[0]),
    Math.max(0, box.max[1] - box.min[1]),
    Math.max(0, box.max[2] - box.min[2]),
  ];
}

export function boxRadius(box: BoundingBox3D): number {
  const [dx, dy, dz] = boxSize(box);
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * 0.5;
}

export function boxContainsPoint(box: BoundingBox3D, pt: [number, number, number]): boolean {
  return (
    pt[0] >= box.min[0] &&
    pt[0] <= box.max[0] &&
    pt[1] >= box.min[1] &&
    pt[1] <= box.max[1] &&
    pt[2] >= box.min[2] &&
    pt[2] <= box.max[2]
  );
}

export function boxesIntersect(a: BoundingBox3D, b: BoundingBox3D): boolean {
  return (
    a.min[0] <= b.max[0] &&
    a.max[0] >= b.min[0] &&
    a.min[1] <= b.max[1] &&
    a.max[1] >= b.min[1] &&
    a.min[2] <= b.max[2] &&
    a.max[2] >= b.min[2]
  );
}

export function boxIntersectsSphere(box: BoundingBox3D, center: [number, number, number], radius: number): boolean {
  let dmin = 0;
  for (let i = 0; i < 3; i++) {
    if (center[i] < box.min[i]) {
      const d = center[i] - box.min[i];
      dmin += d * d;
    } else if (center[i] > box.max[i]) {
      const d = center[i] - box.max[i];
      dmin += d * d;
    }
  }
  return dmin <= radius * radius;
}

export function boxIntersectsFrustum(box: BoundingBox3D, planes: Plane3D[]): boolean {
  for (const plane of planes) {
    const [nx, ny, nz] = plane.normal;
    // Positive vertex in direction of normal
    const px = nx > 0 ? box.max[0] : box.min[0];
    const py = ny > 0 ? box.max[1] : box.min[1];
    const pz = nz > 0 ? box.max[2] : box.min[2];

    const dist = nx * px + ny * py + nz * pz + plane.distance;
    if (dist < 0) {
      // Entirely outside this half-space
      return false;
    }
  }
  return true;
}

export class OctreeNode<T = any> {
  public bbox: BoundingBox3D;
  public depth: number;
  public children: OctreeNode<T>[] | null = null;
  public items: OctreeItem<T>[] = [];

  constructor(bbox: BoundingBox3D, depth = 0) {
    this.bbox = bbox;
    this.depth = depth;
  }

  public isLeaf(): boolean {
    return this.children === null;
  }

  public subdivide(): void {
    if (this.children !== null) return;

    const center = boxCenter(this.bbox);
    const min = this.bbox.min;
    const max = this.bbox.max;

    this.children = new Array(8);
    let idx = 0;
    for (let x = 0; x < 2; x++) {
      for (let y = 0; y < 2; y++) {
        for (let z = 0; z < 2; z++) {
          const subMin: [number, number, number] = [
            x === 0 ? min[0] : center[0],
            y === 0 ? min[1] : center[1],
            z === 0 ? min[2] : center[2],
          ];
          const subMax: [number, number, number] = [
            x === 0 ? center[0] : max[0],
            y === 0 ? center[1] : max[1],
            z === 0 ? center[2] : max[2],
          ];
          this.children[idx++] = new OctreeNode<T>(createBoundingBox(subMin, subMax), this.depth + 1);
        }
      }
    }
  }
}

export class SpatialOctree<T = any> {
  public root: OctreeNode<T>;
  public maxDepth: number;
  public maxItemsPerNode: number;
  private totalItems = 0;

  constructor(bounds: BoundingBox3D, maxDepth = 6, maxItemsPerNode = 16) {
    this.root = new OctreeNode<T>(bounds, 0);
    this.maxDepth = maxDepth;
    this.maxItemsPerNode = maxItemsPerNode;
  }

  public insert(item: OctreeItem<T>): boolean {
    if (!boxesIntersect(this.root.bbox, item.bbox)) {
      // Item completely outside octree bounds
      return false;
    }
    const inserted = this.insertIntoNode(this.root, item);
    if (inserted) this.totalItems++;
    return inserted;
  }

  private insertIntoNode(node: OctreeNode<T>, item: OctreeItem<T>): boolean {
    if (!boxesIntersect(node.bbox, item.bbox)) {
      return false;
    }

    // If node is leaf and within limit or reached max depth, keep here
    if (node.isLeaf()) {
      if (node.items.length < this.maxItemsPerNode || node.depth >= this.maxDepth) {
        node.items.push(item);
        return true;
      }
      // Subdivide leaf
      node.subdivide();
      // Redistribute existing items
      const existing = node.items;
      node.items = [];
      for (const ex of existing) {
        this.insertIntoChildren(node, ex);
      }
    }

    return this.insertIntoChildren(node, item);
  }

  private insertIntoChildren(node: OctreeNode<T>, item: OctreeItem<T>): boolean {
    if (!node.children) return false;
    let placed = false;
    for (const child of node.children) {
      if (boxesIntersect(child.bbox, item.bbox)) {
        if (this.insertIntoNode(child, item)) {
          placed = true;
        }
      }
    }
    // If not placed into any child (spanning boundaries), store in parent node items
    if (!placed) {
      node.items.push(item);
      placed = true;
    }
    return placed;
  }

  public queryFrustum(planes: Plane3D[]): OctreeItem<T>[] {
    const results: OctreeItem<T>[] = [];
    const visited = new Set<string | number>();

    const traverse = (node: OctreeNode<T>) => {
      if (!boxIntersectsFrustum(node.bbox, planes)) {
        return; // Early prune entire subtree
      }

      for (const item of node.items) {
        if (!visited.has(item.id)) {
          if (boxIntersectsFrustum(item.bbox, planes)) {
            visited.add(item.id);
            results.push(item);
          }
        }
      }

      if (node.children) {
        for (const child of node.children) {
          traverse(child);
        }
      }
    };

    traverse(this.root);
    return results;
  }

  public querySphere(center: [number, number, number], radius: number): OctreeItem<T>[] {
    const results: OctreeItem<T>[] = [];
    const visited = new Set<string | number>();

    const traverse = (node: OctreeNode<T>) => {
      if (!boxIntersectsSphere(node.bbox, center, radius)) return;

      for (const item of node.items) {
        if (!visited.has(item.id)) {
          if (boxIntersectsSphere(item.bbox, center, radius)) {
            visited.add(item.id);
            results.push(item);
          }
        }
      }

      if (node.children) {
        for (const child of node.children) {
          traverse(child);
        }
      }
    };

    traverse(this.root);
    return results;
  }

  public queryBox(box: BoundingBox3D): OctreeItem<T>[] {
    const results: OctreeItem<T>[] = [];
    const visited = new Set<string | number>();

    const traverse = (node: OctreeNode<T>) => {
      if (!boxesIntersect(node.bbox, box)) return;

      for (const item of node.items) {
        if (!visited.has(item.id)) {
          if (boxesIntersect(item.bbox, box)) {
            visited.add(item.id);
            results.push(item);
          }
        }
      }

      if (node.children) {
        for (const child of node.children) {
          traverse(child);
        }
      }
    };

    traverse(this.root);
    return results;
  }

  public getStats(): {
    totalNodes: number;
    leafNodes: number;
    totalItems: number;
    maxDepthReached: number;
  } {
    let totalNodes = 0;
    let leafNodes = 0;
    let maxDepth = 0;

    const count = (node: OctreeNode<T>) => {
      totalNodes++;
      maxDepth = Math.max(maxDepth, node.depth);
      if (node.isLeaf()) {
        leafNodes++;
      } else if (node.children) {
        for (const child of node.children) {
          count(child);
        }
      }
    };

    count(this.root);
    return {
      totalNodes,
      leafNodes,
      totalItems: this.totalItems,
      maxDepthReached: maxDepth,
    };
  }
}
