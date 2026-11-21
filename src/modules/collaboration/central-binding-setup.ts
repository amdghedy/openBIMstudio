/**
 * Boot wiring for the central binding (browser only).
 *
 * Creates the single `CentralBinding` for the session, backed by the live
 * authoring model, and exposes it as `ctx.features.centralSync` (the
 * worksharing panel and the E2E spec drive it from there). The binding is
 * dormant until `join(roomId, name)` is called — no server is contacted at
 * boot, so solo/offline use is unaffected. If the authoring feature is not
 * ready, setup logs and returns null instead of breaking boot.
 *
 * Conflict notices are toasted (the panel lists them with resolve actions);
 * the binding itself stays UI-free.
 */

import { ctx } from "../../core/context";
import { centralClient } from "./central-client";
import {
  CentralBinding,
  getActiveCentralBinding,
  setActiveCentralBinding,
} from "./central-binding";
import { createAuthoringAdapter } from "./authoring-adapter";

export function setupCentralBinding(): CentralBinding | null {
  try {
    const existing = getActiveCentralBinding();
    if (existing) return existing;
    const authoring = (ctx.features as any)?.authoring;
    if (!authoring) {
      console.warn("[central] authoring feature not ready; central binding dormant");
      return null;
    }
    const binding = new CentralBinding(centralClient, createAuthoringAdapter());
    setActiveCentralBinding(binding);
    binding.subscribeConflicts((conflicts) => {
      for (const c of conflicts) {
        try {
          window.dispatchEvent(
            new CustomEvent("obs-toast", {
              detail: {
                kind: "warn",
                message: `[Central] Edit conflict on ${c.elementId} (${c.field}): kept the server value — resolve it in the Worksharing panel`,
              },
            }),
          );
        } catch { /* toast is cosmetic */ }
      }
    });
    (ctx.features as any).centralSync = {
      binding,
      join: (roomId: string, name?: string) => binding.join(roomId, name),
      leave: () => binding.leave(),
      syncNow: () => binding.syncNow(),
      borrow: (elementId: string) => binding.borrow(elementId),
      relinquish: (elementId: string) => binding.relinquish(elementId),
      requestBorrow: (elementId: string) => binding.requestBorrow(elementId),
      resolveConflict: (conflictId: string, choice: "mine" | "theirs" | { value: any }) =>
        binding.resolveConflict(conflictId, choice),
      getStatus: () => binding.getStatus(),
      listLocalElements: () =>
        binding.adapter.listElements().map((e) => ({
          id: e.id,
          type: e.type,
          name: e.name,
          params: e.params,
        })),
    };
    return binding;
  } catch (err) {
    console.warn("[central] binding setup failed", err);
    return null;
  }
}
