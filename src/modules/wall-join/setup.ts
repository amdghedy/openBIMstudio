/**
 * Live wiring for the vertical (stacked) wall join engine.
 * Registers the pure detection/validation API onto ctx.features.wallJoin
 * and the window alias, plus `check()` over the CURRENT authoring model —
 * the entry point model-health / the checker call on demand.
 */

import { ctx } from "../../core/context";
import {
  detectVerticalStacks,
  stackChains,
  validateStacks,
  type StackPair,
  type StackWall,
  type StackIssue,
} from "./vertical-join";

type Any = Record<string, any>;

/** Map authored wall elements onto the pure StackWall shape. */
export function toStackWalls(elements: Any[]): StackWall[] {
  const out: StackWall[] = [];
  for (const el of elements) {
    if (!el || String(el.type ?? "") !== "wall" || !el.params) continue;
    const s = el.params.start;
    const e = el.params.end;
    if (!Array.isArray(s) || !Array.isArray(e) || s.length < 2 || e.length < 2) continue;
    out.push({
      id: String(el.id),
      start: [Number(s[0]), Number(s[1])],
      end: [Number(e[0]), Number(e[1])],
      baseZ: Number(el.params.elevation ?? 0),
      height: Number(el.params.height ?? 0),
      joinStatus: String(el.properties?.joinStatus ?? "allow"),
    });
  }
  return out;
}

export interface VerticalJoinReport {
  pairs: StackPair[];
  chains: string[][];
  issues: StackIssue[];
}

/** Full report over the current authored model. */
export function checkVerticalJoins(): VerticalJoinReport {
  let walls: StackWall[] = [];
  try {
    const a = (ctx as Any).features?.authoring;
    const elements = typeof a?.getElements === "function" ? a.getElements() : a?.elements ?? [];
    walls = toStackWalls(elements);
  } catch { /* no authoring yet */ }
  const pairs = detectVerticalStacks(walls);
  return {
    pairs,
    chains: stackChains(pairs),
    issues: validateStacks(walls),
  };
}

export function setupVerticalJoin(): void {
  const api = {
    detectVerticalStacks,
    stackChains,
    validateStacks,
    toStackWalls,
    check: checkVerticalJoins,
  };
  const f = (ctx as Any).features ?? ((ctx as Any).features = {});
  f.wallJoin = api;
  console.log("[wall-join] vertical stack engine ready — ctx.features.wallJoin.check()");
}
