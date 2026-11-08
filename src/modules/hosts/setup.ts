/**
 * Live wiring for the transitive host cascade: exposes `findOrphanedHosted`
 * over the current model (model health) and re-exports the closure helper
 * for tools that delete elements outside authoring's delete path.
 */

import { ctx } from "../../core/context";
import {
  collectDeleteCascade,
  dependentSummary,
  findOrphanedHosted,
  type CascadeElement,
} from "./cascade";

type Any = Record<string, any>;

function currentElements(): CascadeElement[] {
  try {
    const a = (ctx as Any).features?.authoring;
    const elements = typeof a?.getElements === "function" ? a.getElements() : a?.elements ?? [];
    return elements as CascadeElement[];
  } catch {
    return [];
  }
}

export function orphansNow(): Array<{ id: string; hostId: string }> {
  return findOrphanedHosted(currentElements());
}

export function cascadeNow(seedIds: string[]) {
  return collectDeleteCascade(seedIds, currentElements());
}

export function setupHostCascade(): void {
  const api = { collectDeleteCascade, dependentSummary, findOrphanedHosted, orphansNow, cascadeNow };
  const f = (ctx as Any).features ?? ((ctx as Any).features = {});
  f.hostCascade = api;
  console.log("[host-cascade] transitive cascade ready — ctx.features.hostCascade.orphansNow()");
}
