/**
 * Model groups — group elements for reuse + placement.
 *
 * Revit's "Model Groups" let users group elements (walls, doors,
 * furniture, etc.) into a reusable unit. The group can be placed
 * multiple times — editing one instance updates all.
 *
 * Also supports "Attached Groups" (detail groups for 2D annotations).
 */

export interface ModelGroup {
  id: string;
  name: string;
  /** Element IDs in this group. */
  elementIds: string[];
  /** Group type: model (3D) or detail (2D annotations). */
  type: "model" | "detail";
  /** Placed instances: array of [x, z] positions + rotation. */
  instances: Array<{ position: [number, number]; rotation: number }>;
}

const groups = new Map<string, ModelGroup>();
let idCounter = 0;

export function createGroup(name: string, elementIds: string[], type: "model" | "detail" = "model"): ModelGroup {
  const group: ModelGroup = {
    id: `group-${++idCounter}`,
    name,
    elementIds,
    type,
    instances: [{ position: [0, 0], rotation: 0 }],
  };
  groups.set(group.id, group);
  console.log(`[model-groups] created "${name}" with ${elementIds.length} element(s)`);
  return group;
}

export function listGroups(): ModelGroup[] { return [...groups.values()]; }
export function getGroup(id: string): ModelGroup | null { return groups.get(id) ?? null; }

export function placeGroupInstance(groupId: string, position: [number, number], rotation: number = 0): void {
  const group = groups.get(groupId);
  if (!group) return;
  group.instances.push({ position, rotation });
  console.log(`[model-groups] placed instance of "${group.name}" at [${position}]`);
}

export function removeGroupInstance(groupId: string, index: number): void {
  const group = groups.get(groupId);
  if (!group || index < 0 || index >= group.instances.length) return;
  group.instances.splice(index, 1);
}

export function deleteGroup(id: string): void {
  groups.delete(id);
  console.log(`[model-groups] deleted ${id}`);
}

export function dissolveGroup(id: string): string[] | null {
  const group = groups.get(id);
  if (!group) return null;
  groups.delete(id);
  console.log(`[model-groups] dissolved "${group.name}" — ${group.elementIds.length} elements freed`);
  return group.elementIds;
}

let installed = false;
export function setupModelGroups() {
  if (installed) return; installed = true;
  (window as any).__obsModelGroups = {
    create: createGroup, list: listGroups, get: getGroup,
    place: placeGroupInstance, removeInstance: removeGroupInstance,
    delete: deleteGroup, dissolve: dissolveGroup,
  };
  console.log("[model-groups] ready. Group elements via __obsModelGroups.create(name, ids).");
}
