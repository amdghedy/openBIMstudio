/**
 * Per-project persistence for the "BIM parity" stores.
 *
 * Problem this fixes: rooms, areas, phases, design options, groups, reference
 * planes, shared / project parameters and copy-monitor rules were saved only in
 * global localStorage keys. They leaked between projects and were missing from
 * the saved project and the Project JSON export.
 *
 * How it works (no edits to the stores or to projects.ts):
 *   - the stores keep using their localStorage keys as a working cache;
 *   - every store change copies those keys into `project.revitStores`
 *     (the live project document, so saveProject() persists it);
 *   - when the open project changes (new / open), the keys are replaced with
 *     that project's data (or emptied) and every store is re-booted.
 * The very first time it runs, the data currently in localStorage is ADOPTED by
 * the open project so nothing already modelled is lost.
 */
import { roomsStore } from "../rooms/rooms";
import { phasesStore } from "../phases/phases";
import { designOptionsStore } from "../design-options/design-options";
import { groupsStore } from "../groups/groups";
import { refPlanesStore } from "../ref-planes/ref-planes";
import { sharedParamsStore } from "../shared-params/shared-params";
import { copyMonitorStore } from "../copy-monitor/copy-monitor";

type Any = Record<string, any>;

const KEYS = [
  "obs.rooms.v1", "obs.areas.v1", "obs.phases.v1", "obs.design-options.v1", "obs.groups.v1",
  "obs.ref-planes.v1", "obs.shared-params.v1", "obs.project-params.v1", "obs.copy-monitor.v1",
];
const STORES: Any[] = [roomsStore, phasesStore, designOptionsStore, groupsStore, refPlanesStore, sharedParamsStore, copyMonitorStore];
const ADOPTED_FLAG = "obs.bim-gaps.scope-adopted";

export interface BIMStoresPayload { v: 1; data: Record<string, string> }

let hydrating = false;
let lastProjectId: string | null | undefined;
let P: { getCurrentProject(): Any | null; markDirty(): void; onProjectChanged(cb: () => void): void } | null = null;

export function snapshotStores(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of KEYS) {
    try { const v = localStorage.getItem(k); if (v != null) out[k] = v; } catch { /* */ }
  }
  return out;
}

function resetStore(store: Any): void {
  for (const k of Object.keys(store)) {
    const v = store[k];
    if (v instanceof Map) v.clear();
    else if (Array.isArray(v)) v.length = 0;
  }
  if ("currentPhaseId" in store) store.currentPhaseId = null;
  if ("currentFilter" in store) store.currentFilter = "show-complete";
  if ("activeWorkPlaneId" in store) store.activeWorkPlaneId = null;
  store.booted = false;
}

/** Replace the working cache with `data` (null = empty project) and re-boot every store. */
export function hydrateStores(data: Record<string, string> | null): void {
  hydrating = true;
  try {
    for (const k of KEYS) {
      try { if (data && data[k] != null) localStorage.setItem(k, data[k]); else localStorage.removeItem(k); } catch { /* */ }
    }
    for (const s of STORES) {
      try {
        resetStore(s);
        s.boot?.();
        s.persist?.(); // idempotent; also notifies panels listening to the store
      } catch (e) { console.warn("[project-scope] store hydrate failed", e); }
    }
  } finally {
    hydrating = false;
  }
}

function syncToProject(): void {
  if (hydrating || !P) return;
  const doc = P.getCurrentProject();
  if (!doc) return;
  const snap = snapshotStores();
  const prev = (doc.revitStores as BIMStoresPayload | undefined)?.data;
  if (prev && JSON.stringify(prev) === JSON.stringify(snap)) return;
  doc.revitStores = { v: 1, data: snap } satisfies BIMStoresPayload;
  P.markDirty();
}

function onProject(): void {
  if (!P) return;
  const doc = P.getCurrentProject();
  const id: string | null = doc?.id ?? null;
  if (id === lastProjectId) return;
  const first = lastProjectId === undefined;
  lastProjectId = id;
  if (!doc) return;
  const payload = doc.revitStores as BIMStoresPayload | undefined;
  if (payload?.data) { hydrateStores(payload.data); return; }
  let adopted = false;
  try { adopted = localStorage.getItem(ADOPTED_FLAG) === "1"; } catch { /* */ }
  if (first && !adopted) {
    // Migration: the first project we ever see keeps the data that was already in localStorage.
    try { localStorage.setItem(ADOPTED_FLAG, "1"); } catch { /* */ }
    doc.revitStores = { v: 1, data: snapshotStores() } satisfies BIMStoresPayload;
    P.markDirty();
  } else {
    hydrateStores(null); // a project that has no saved data starts empty instead of inheriting another project's
  }
}

let installed = false;
export async function setupProjectScope(): Promise<{ ok: boolean; detail: string }> {
  if (installed) return { ok: true, detail: "already installed" };
  installed = true;
  const mod: Any = await import("../projects/projects");
  P = { getCurrentProject: mod.getCurrentProject, markDirty: mod.markDirty, onProjectChanged: mod.onProjectChanged };
  for (const s of STORES) { try { s.boot?.(); s.onChange?.(syncToProject); } catch { /* */ } }
  P.onProjectChanged(onProject);
  onProject();
  return { ok: true, detail: `${STORES.length} stores scoped to the open project` };
}
