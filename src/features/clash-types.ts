/**
 * Clash scope + status types (types-only module).
 *
 * These types live here — not in `features/clash.ts` — so the typed
 * service registry (`core/services.ts`) can reference them without
 * importing the clash implementation module. That import was one of
 * two type-only edges that put `services.ts` inside the 19-module
 * static import cycle (hardening item 18): `import type` is erased
 * at compile time, so the edge never existed at runtime, but the
 * static graph counts it. Moving the types here detaches
 * `services.ts` from the cycle in the static graph too.
 *
 * This module must stay types-only: no value imports, no runtime
 * code. `features/clash.ts` re-exports these names so existing
 * importers keep working unchanged.
 */
import type { ClashMethod } from "./clash-engine";

export type ClashScope = "all" | "viewport" | "aOnly" | "bOnly" | "both";

export type ClashStatus = "new" | "active" | "reviewed" | "approved" | "resolved";

export interface ClashComment {
  id: string;
  author: string;
  date: number;
  text: string;
}

export interface ClashState {
  status: ClashStatus;
  comments: ClashComment[];
  assignee?: string;
  updatedAt: number;
}

export type ClashScenario = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  testName: string;
  tolerance: number;
  clearance: number;
  cropMargin: number;
  scope?: ClashScope;
  method?: ClashMethod;
  selectionA: string[];
  selectionB: string[];
  clashStates?: Record<string, ClashState>;
  lastRun?: { total: number; intersect: number; touching: number; clearance: number; duplicate: number; at: number };
};
