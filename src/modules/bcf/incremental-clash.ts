/**
 * Incremental Clash Engine.
 *
 * Speeds up clash detection in live authoring sessions by tracking bounding box
 * mutations and only checking elements whose bounding boxes moved or expanded.
 */

export interface BoundingBox3D {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

export interface ModelSnapshot {
  timestamp: number;
  elementBounds: Map<string | number, BoundingBox3D>;
}

export interface IncrementalCheckResult {
  modifiedElementIds: Array<string | number>;
  unaffectedCount: number;
  durationMs: number;
}

export function createModelSnapshot(elements: Array<{ id: string | number; bbox: BoundingBox3D }>): ModelSnapshot {
  const map = new Map<string | number, BoundingBox3D>();
  for (const el of elements) {
    map.set(el.id, {
      min: { ...el.bbox.min },
      max: { ...el.bbox.max },
    });
  }
  return { timestamp: Date.now(), elementBounds: map };
}

export function detectAlteredElements(
  previousSnapshot: ModelSnapshot,
  currentElements: Array<{ id: string | number; bbox: BoundingBox3D }>
): IncrementalCheckResult {
  const start = performance.now();
  const modified: Array<string | number> = [];
  let unaffected = 0;

  for (const el of currentElements) {
    const prev = previousSnapshot.elementBounds.get(el.id);
    if (!prev) {
      // New element added
      modified.push(el.id);
      continue;
    }

    const dx = Math.abs(prev.min.x - el.bbox.min.x) + Math.abs(prev.max.x - el.bbox.max.x);
    const dy = Math.abs(prev.min.y - el.bbox.min.y) + Math.abs(prev.max.y - el.bbox.max.y);
    const dz = Math.abs(prev.min.z - el.bbox.min.z) + Math.abs(prev.max.z - el.bbox.max.z);

    // If moved by more than 2mm, mark modified
    if (dx > 0.002 || dy > 0.002 || dz > 0.002) {
      modified.push(el.id);
    } else {
      unaffected++;
    }
  }

  return {
    modifiedElementIds: modified,
    unaffectedCount: unaffected,
    durationMs: Math.round(performance.now() - start),
  };
}
