/**
 * Scope Box — 3D cropping volume that can be applied to multiple views.
 *
 * BIM-equivalent of Revit's "Scope Box" tool. Defines a rectangular volume
 * (XZ footprint + min/max elevation) that crops visible geometry in any
 * view it is applied to.
 *
 * Stored centrally in a registry, so a single scope box can be referenced
 * by N views (plan, section, 3D).
 */

export interface ScopeBox {
  /** Unique ID. */
  id: string;
  /** Human label. */
  name: string;
  /** World min corner. */
  min: { x: number; y: number; z: number };
  /** World max corner. */
  max: { x: number; y: number; z: number };
  /** Colour (hex). */
  color: number;
  /** Views this box is applied to. */
  appliedToViews: string[];
}

const registry = new Map<string, ScopeBox>();

let counter = 0;

/** Create and register a new scope box. */
export function createScopeBox(input: Partial<ScopeBox> = {}): ScopeBox {
  const id = input.id ?? `sb-${++counter}`;
  const box: ScopeBox = {
    id,
    name: input.name ?? `Scope Box ${counter}`,
    min: input.min ?? { x: 0, y: 0, z: 0 },
    max: input.max ?? { x: 10, y: 4, z: 10 },
    color: input.color ?? 0x2563eb,
    appliedToViews: input.appliedToViews ?? [],
  };
  registry.set(id, box);
  return box;
}

/** List all scope boxes. */
export function listScopeBoxes(): ScopeBox[] {
  return Array.from(registry.values());
}

/** Get a scope box by ID. */
export function getScopeBox(id: string): ScopeBox | undefined {
  return registry.get(id);
}

/** Delete a scope box by ID. */
export function deleteScopeBox(id: string): boolean {
  return registry.delete(id);
}

/** Update a scope box (returns the updated copy). */
export function updateScopeBox(id: string, patch: Partial<ScopeBox>): ScopeBox | undefined {
  const existing = registry.get(id);
  if (!existing) return undefined;
  const updated: ScopeBox = {
    ...existing,
    ...patch,
    min: { ...existing.min, ...(patch.min ?? {}) },
    max: { ...existing.max, ...(patch.max ?? {}) },
    appliedToViews: patch.appliedToViews ?? existing.appliedToViews,
  };
  registry.set(id, updated);
  return updated;
}

/** Apply a scope box to a view. */
export function applyToView(boxId: string, viewId: string): boolean {
  const box = registry.get(boxId);
  if (!box) return false;
  if (!box.appliedToViews.includes(viewId)) box.appliedToViews.push(viewId);
  return true;
}

/** Remove a scope box from a view. */
export function removeFromView(boxId: string, viewId: string): boolean {
  const box = registry.get(boxId);
  if (!box) return false;
  box.appliedToViews = box.appliedToViews.filter((v) => v !== viewId);
  return true;
}

/** Check if a point is inside the scope box (for view clipping). */
export function pointInScope(box: ScopeBox, x: number, y: number, z: number): boolean {
  return (
    x >= box.min.x && x <= box.max.x &&
    y >= box.min.y && y <= box.max.y &&
    z >= box.min.z && z <= box.max.z
  );
}

/** Check if an element's bounding box intersects the scope box. */
export function bboxIntersectsScope(
  box: ScopeBox,
  elementMin: { x: number; y: number; z: number },
  elementMax: { x: number; y: number; z: number },
): boolean {
  return (
    elementMin.x <= box.max.x && elementMax.x >= box.min.x &&
    elementMin.y <= box.max.y && elementMax.y >= box.min.y &&
    elementMin.z <= box.max.z && elementMax.z >= box.min.z
  );
}

/** Clear the registry (used in tests). */
export function resetScopeBoxes(): void {
  registry.clear();
  counter = 0;
}
