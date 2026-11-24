/**
 * Family bridge wiring — app side.
 *
 * Runs the two-way sync once at parametric-family boot, exposes the
 * bridge to the legacy editor (`window.__obsFamilyBridge`, called by
 * `public/js/obs-family-editor.js` on save / delete / open), and keeps
 * the editor library fresh whenever the store changes.
 *
 * This module is the only place that touches the real store, the real
 * shared-parameter manager and `localStorage`; all conversion and merge
 * logic lives in the dependency-light `family-bridge.ts` (node-tested).
 */

import { ctx } from "../../core/context";
import { familyStore } from "./store";
import { getCurrentProject } from "../projects/projects";
import { sharedParameterManager } from "./shared-parameters";
import {
  exportServiceFamilies,
  pushEditorFamily,
  removeBridgedFamily,
  syncAll,
  syncSharedParameters,
  type BridgeSyncReport,
  type EditorFamily,
  type PushResult,
} from "./family-bridge";

type Any = Record<string, any>;

export interface FamilyBridgeApi {
  /** Full two-way sync now (editor in, store out, shared params both ways). */
  syncNow(): BridgeSyncReport;
  /** Save one editor family into the store; stamps `serviceId` on it. */
  pushEditorFamily(editor: EditorFamily): PushResult;
  /** Remove a bridged family from the store and the editor library. */
  removeServiceFamily(serviceId: string): boolean;
  /** Sync shared parameters both ways now. */
  syncSharedParameters(): unknown;
}

let installed = false;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** The project the store is currently scoped to (null = global store). */
function projectId(): string | null {
  try {
    return getCurrentProject()?.id ?? null;
  } catch {
    return null;
  }
}

function setConstraintsSink(familyId: string, constraints: import("./constraint-graph").Constraint[]): void {
  try {
    const svc = (ctx.features as Any).family as Any;
    svc?.setConstraints?.(familyId, constraints);
  } catch { /* constraints are best-effort */ }
}

export function setupFamilyBridge(): FamilyBridgeApi | null {
  if (installed) return (window as Any).__obsFamilyBridge ?? null;
  installed = true;

  const api: FamilyBridgeApi = {
    syncNow() {
      const ls = storage();
      if (!ls) return { families: { imported: 0, updated: 0, skipped: 0, exported: 0, removed: 0 }, shared: { imported: 0, exported: 0, removed: 0 }, errors: [] };
      try {
        return syncAll(familyStore, sharedParameterManager, ls, {
          setConstraints: setConstraintsSink,
          projectId: projectId(),
        });
      } catch (err) {
        console.warn("[family-bridge] sync failed", err);
        return { families: { imported: 0, updated: 0, skipped: 0, exported: 0, removed: 0 }, shared: { imported: 0, exported: 0, removed: 0 }, errors: [String(err)] };
      }
    },

    pushEditorFamily(editor: EditorFamily): PushResult {
      return pushEditorFamily(familyStore, editor, {
        setConstraints: setConstraintsSink,
        projectId: projectId(),
      });
    },

    removeServiceFamily(serviceId: string): boolean {
      const ls = storage();
      if (!ls) return familyStore.remove(serviceId);
      return removeBridgedFamily(familyStore, ls, serviceId);
    },

    syncSharedParameters() {
      const ls = storage();
      if (!ls) return { imported: 0, exported: 0, removed: 0 };
      try {
        return syncSharedParameters(sharedParameterManager, ls);
      } catch (err) {
        console.warn("[family-bridge] shared-parameter sync failed", err);
        return { imported: 0, exported: 0, removed: 0 };
      }
    },
  };

  try {
    (window as Any).__obsFamilyBridge = api;
  } catch { /* */ }

  // Keep the editor library fresh whenever the store changes (a save in
  // the editor, a panel/sketch create, a delete, the seed-catalog stamp
  // pass). Export only writes localStorage; it never touches the store,
  // so this cannot loop.
  try {
    familyStore.onChange(() => {
      const ls = storage();
      if (!ls) return;
      try {
        exportServiceFamilies(familyStore, ls, { projectId: projectId() });
      } catch (err) {
        console.warn("[family-bridge] export on change failed", err);
      }
    });
  } catch (err) {
    console.warn("[family-bridge] could not subscribe to store changes", err);
  }

  // First sync: pick up anything the editor saved before the service
  // booted, and mirror the service families into the editor library.
  try {
    const report = api.syncNow();
    console.log(
      `[family-bridge] ready — library in: ${report.families.imported} new, ` +
      `${report.families.updated} updated, ${report.families.skipped} skipped; ` +
      `library out: ${report.families.exported} exported; ` +
      `shared: ${report.shared.imported} in, ${report.shared.exported} out`,
    );
    if (report.errors.length) {
      for (const e of report.errors) console.warn(`[family-bridge] ${e}`);
    }
  } catch (err) {
    console.warn("[family-bridge] first sync failed", err);
  }

  return api;
}
