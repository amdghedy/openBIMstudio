/**
 * Dependent Views — primary/dependent view pairs for sheet composition.
 *
 * BIM-equivalent of Revit's "Dependent View" feature. A dependent view
 * shares all properties of its primary (geometry, annotations, dimensions)
 * but has its own crop region, so the same model can be split across
 * multiple sheets while staying synchronised.
 *
 * Implementation: a primary view holds a list of dependent view IDs; any
 * property change broadcast to the primary propagates to all dependents
 * EXCEPT crop region, scope box binding and view position on sheet.
 */

export interface DependentView {
  id: string;
  primaryId: string;
  name: string;
  /** Crop region (min/max in view-space). */
  cropRegion: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** Sheet placement (if placed on a sheet). */
  sheetPlacement?: { sheetId: string; x: number; y: number };
}

const registry = new Map<string, DependentView>();
const primaryToDependents = new Map<string, string[]>();
let counter = 0;

/** Create a dependent view from a primary. */
export function createDependentView(
  primaryId: string,
  input: Partial<DependentView> = {},
): DependentView {
  const id = input.id ?? `dv-${++counter}`;
  const dv: DependentView = {
    id,
    primaryId,
    name: input.name ?? `Dependent ${counter}`,
    cropRegion: input.cropRegion ?? { minX: 0, maxX: 10, minZ: 0, maxZ: 10 },
    sheetPlacement: input.sheetPlacement,
  };
  registry.set(id, dv);
  const list = primaryToDependents.get(primaryId) ?? [];
  list.push(id);
  primaryToDependents.set(primaryId, list);
  return dv;
}

/** List dependent views for a primary. */
export function listDependents(primaryId: string): DependentView[] {
  const ids = primaryToDependents.get(primaryId) ?? [];
  return ids.map((id) => registry.get(id)!).filter(Boolean);
}

/** Get a dependent view. */
export function getDependentView(id: string): DependentView | undefined {
  return registry.get(id);
}

/** Update a dependent view's crop region. */
export function updateCropRegion(id: string, crop: Partial<DependentView["cropRegion"]>): DependentView | undefined {
  const dv = registry.get(id);
  if (!dv) return undefined;
  dv.cropRegion = { ...dv.cropRegion, ...crop };
  return dv;
}

/** Delete a dependent view (does not affect primary). */
export function deleteDependentView(id: string): boolean {
  const dv = registry.get(id);
  if (!dv) return false;
  registry.delete(id);
  const list = primaryToDependents.get(dv.primaryId);
  if (list) {
    const idx = list.indexOf(id);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) primaryToDependents.delete(dv.primaryId);
  }
  return true;
}

/** Propagate a primary view property change to all dependents (returns list of affected). */
export function propagateChange(primaryId: string, change: Record<string, unknown>): string[] {
  const affected: string[] = [];
  for (const dv of listDependents(primaryId)) {
    // Stub: real implementation would push change through view's mutation API.
    affected.push(dv.id);
  }
  return affected;
}

/** Reset registry (tests). */
export function resetDependentViews(): void {
  registry.clear();
  primaryToDependents.clear();
  counter = 0;
}
