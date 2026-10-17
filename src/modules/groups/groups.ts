/**
 * Model Groups - BIM-style element groups.
 *
 * A group is a named set of authored element ids. Editing one instance
 * can optionally propagate to all instances of the same group type
 * (shared group behaviour).
 */

import { ctx } from "../../core/context";

export type GroupId = string;
export type GroupTypeId = string;

export interface GroupType {
  id: GroupTypeId;
  name: string;
  /** Canonical member element ids (template). */
  memberIds: string[];
  /** When true, edits to any instance update the type. */
  shared: boolean;
}

export interface GroupInstance {
  id: GroupId;
  typeId: GroupTypeId;
  name: string;
  /** Element ids belonging to this instance. */
  memberIds: string[];
  /** Origin offset applied when placing additional instances. */
  origin: { x: number; y: number; z: number };
  phaseId?: string | null;
  designOptionId?: string | null;
}

const STORAGE = "obs.groups.v1";
type Listener = () => void;

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

class GroupsStore {
  private types = new Map<GroupTypeId, GroupType>();
  private instances = new Map<GroupId, GroupInstance>();
  private listeners = new Set<Listener>();
  private booted = false;

  boot(): void {
    if (this.booted) return;
    this.booted = true;
    try {
      const raw = localStorage.getItem(STORAGE);
      if (raw) {
        const data = JSON.parse(raw);
        for (const t of data.types ?? []) this.types.set(t.id, t);
        for (const i of data.instances ?? []) this.instances.set(i.id, i);
      }
    } catch { /* */ }
  }

  private persist(): void {
    try {
      localStorage.setItem(
        STORAGE,
        JSON.stringify({
          types: [...this.types.values()],
          instances: [...this.instances.values()],
        }),
      );
    } catch { /* */ }
    for (const cb of this.listeners) {
      try { cb(); } catch { /* */ }
    }
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  listTypes(): GroupType[] {
    return [...this.types.values()];
  }

  listInstances(): GroupInstance[] {
    return [...this.instances.values()];
  }

  getType(id: GroupTypeId): GroupType | null {
    return this.types.get(id) ?? null;
  }

  getInstance(id: GroupId): GroupInstance | null {
    return this.instances.get(id) ?? null;
  }

  /** Create a group type + first instance from a selection of element ids. */
  createFromSelection(
    name: string,
    memberIds: string[],
    shared = true,
  ): { type: GroupType; instance: GroupInstance } | null {
    if (!memberIds.length) return null;
    const type: GroupType = {
      id: uid("gtype"),
      name,
      memberIds: [...memberIds],
      shared,
    };
    const instance: GroupInstance = {
      id: uid("ginst"),
      typeId: type.id,
      name: `${name} 1`,
      memberIds: [...memberIds],
      origin: { x: 0, y: 0, z: 0 },
    };
    this.types.set(type.id, type);
    this.instances.set(instance.id, instance);
    this.persist();
    return { type, instance };
  }

  /** Place another instance of an existing group type (empty members - authoring fills geometry). */
  placeInstance(
    typeId: GroupTypeId,
    origin: { x: number; y: number; z: number },
    memberIds: string[] = [],
  ): GroupInstance | null {
    const type = this.types.get(typeId);
    if (!type) return null;
    const count = [...this.instances.values()].filter((i) => i.typeId === typeId).length;
    const instance: GroupInstance = {
      id: uid("ginst"),
      typeId,
      name: `${type.name} ${count + 1}`,
      memberIds: memberIds.length ? memberIds : [],
      origin: { ...origin },
    };
    this.instances.set(instance.id, instance);
    this.persist();
    return instance;
  }

  /** Ungroup: remove instance, keep members in the model. */
  ungroup(instanceId: GroupId): string[] {
    const inst = this.instances.get(instanceId);
    if (!inst) return [];
    const members = [...inst.memberIds];
    this.instances.delete(instanceId);
    // Drop type if no instances remain
    const remaining = [...this.instances.values()].filter((i) => i.typeId === inst.typeId);
    if (!remaining.length) this.types.delete(inst.typeId);
    this.persist();
    return members;
  }

  removeInstance(id: GroupId): boolean {
    const ok = this.instances.delete(id);
    if (ok) this.persist();
    return ok;
  }

  /** Find which group instance owns an element (if any). */
  findOwner(elementId: string): GroupInstance | null {
    for (const inst of this.instances.values()) {
      if (inst.memberIds.includes(elementId)) return inst;
    }
    return null;
  }

  /** All element ids belonging to any group. */
  allGroupedIds(): Set<string> {
    const set = new Set<string>();
    for (const inst of this.instances.values()) {
      for (const id of inst.memberIds) set.add(id);
    }
    return set;
  }

  reset(): void {
    this.types.clear();
    this.instances.clear();
    this.persist();
  }
}

export const groupsStore = new GroupsStore();

export function setupGroups(): typeof groupsStore {
  groupsStore.boot();
  (ctx.features as any).groups = groupsStore;
  (window as any).__obsGroups = groupsStore;
  console.log(
    "[groups] ready -",
    groupsStore.listTypes().length,
    "types,",
    groupsStore.listInstances().length,
    "instances",
  );
  return groupsStore;
}
