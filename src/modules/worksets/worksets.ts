/**
 * Worksets — element-level workset partitioning for worksharing.
 *
 * BIM-equivalent of Revit's "Worksets" feature. A workset is a named bucket
 * of elements; each element belongs to exactly one workset. Worksets can be
 * visible/invisible per user and can be borrowed (locked) for editing.
 *
 * Stored centrally in a registry; the worksharing client syncs the registry
 * state to the collaboration server.
 */

export interface Workset {
  id: string;
  name: string;
  /** Default visible? */
  defaultVisible: boolean;
  /** Owner (user ID). Empty = unowned. */
  owner: string;
  /** Element express IDs assigned to this workset. */
  elementIds: Set<number>;
  /** Per-user visibility overrides. */
  userVisibility: Record<string, boolean>;
}

export interface WorksetManagerOptions {
  /** Default workset name. */
  defaultWorksetName?: string;
  /** Current user ID. */
  currentUserId?: string;
}

const worksets = new Map<string, Workset>();
const elementToWorkset = new Map<number, string>();
let counter = 0;
let currentUser = "anonymous";

/** Initialise the manager (creates a default workset if none exist). */
export function initWorksets(options: WorksetManagerOptions = {}): void {
  if (options.currentUserId) currentUser = options.currentUserId;
  if (worksets.size === 0) {
    const name = options.defaultWorksetName ?? "Shared Levels and Grids";
    createWorkset(name);
    createWorkset("Workset1");
  }
}

/** Create a new workset. */
export function createWorkset(name: string, defaultVisible = true): Workset {
  const id = `ws-${++counter}`;
  const ws: Workset = {
    id,
    name,
    defaultVisible,
    owner: "",
    elementIds: new Set(),
    userVisibility: {},
  };
  worksets.set(id, ws);
  return ws;
}

/** List all worksets. */
export function listWorksets(): Workset[] {
  return Array.from(worksets.values());
}

/** Get a workset by ID. */
export function getWorkset(id: string): Workset | undefined {
  return worksets.get(id);
}

/** Rename a workset. */
export function renameWorkset(id: string, name: string): boolean {
  const ws = worksets.get(id);
  if (!ws) return false;
  ws.name = name;
  return true;
}

/** Delete a workset (elements go back to default workset). */
export function deleteWorkset(id: string): boolean {
  const ws = worksets.get(id);
  if (!ws) return false;
  // Reassign elements to first remaining workset.
  const remaining = Array.from(worksets.values()).filter((w) => w.id !== id);
  const fallback = remaining[0];
  if (fallback) {
    for (const elId of ws.elementIds) {
      fallback.elementIds.add(elId);
      elementToWorkset.set(elId, fallback.id);
    }
  } else {
    for (const elId of ws.elementIds) elementToWorkset.delete(elId);
  }
  worksets.delete(id);
  return true;
}

/** Assign an element to a workset. */
export function assignToWorkset(elementId: number, worksetId: string): boolean {
  const ws = worksets.get(worksetId);
  if (!ws) return false;
  // Remove from previous.
  const prev = elementToWorkset.get(elementId);
  if (prev) worksets.get(prev)?.elementIds.delete(elementId);
  ws.elementIds.add(elementId);
  elementToWorkset.set(elementId, worksetId);
  return true;
}

/** Get the workset for an element. */
export function getWorksetForElement(elementId: number): Workset | undefined {
  const wsId = elementToWorkset.get(elementId);
  return wsId ? worksets.get(wsId) : undefined;
}

/** Borrow an element (locks it to current user). */
export function borrowElement(elementId: number, userId: string = currentUser): boolean {
  const ws = getWorksetForElement(elementId);
  if (!ws) return false;
  if (ws.owner && ws.owner !== userId) return false;
  ws.owner = userId;
  return true;
}

/** Release a borrowed element. */
export function releaseElement(elementId: number, userId: string = currentUser): boolean {
  const ws = getWorksetForElement(elementId);
  if (!ws || ws.owner !== userId) return false;
  ws.owner = "";
  return true;
}

/** Check if current user can edit an element. */
export function canEdit(elementId: number, userId: string = currentUser): boolean {
  const ws = getWorksetForElement(elementId);
  if (!ws) return true; // No workset assigned → freely editable.
  return !ws.owner || ws.owner === userId;
}

/** Toggle visibility of a workset for a user. */
export function setVisibility(worksetId: string, userId: string, visible: boolean): boolean {
  const ws = worksets.get(worksetId);
  if (!ws) return false;
  ws.userVisibility[userId] = visible;
  return true;
}

/** Is a workset visible for the current user? */
export function isVisible(worksetId: string, userId: string = currentUser): boolean {
  const ws = worksets.get(worksetId);
  if (!ws) return false;
  if (userId in ws.userVisibility) return ws.userVisibility[userId];
  return ws.defaultVisible;
}

/** Get summary statistics. */
export function getWorksetSummary(): {
  total: number;
  totalElements: number;
  ownedByUser: number;
} {
  let totalElements = 0;
  let ownedByUser = 0;
  for (const ws of worksets.values()) {
    totalElements += ws.elementIds.size;
    if (ws.owner === currentUser) ownedByUser += ws.elementIds.size;
  }
  return {
    total: worksets.size,
    totalElements,
    ownedByUser,
  };
}

/** Reset workset registry (tests). */
export function resetWorksets(): void {
  worksets.clear();
  elementToWorkset.clear();
  counter = 0;
  currentUser = "anonymous";
}

/** Set current user (for testing). */
export function setCurrentUser(userId: string): void {
  currentUser = userId;
}
