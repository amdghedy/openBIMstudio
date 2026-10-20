/**
 * Rebar module — public barrel + boot wiring.
 *
 * Imports the layout + geometry functions, registers a typed service
 * in the host's ServiceMap, and exposes a `__obsRebar` global for
 * console access.
 */

import { layoutRebar as layoutImpl } from "./layout";
import { generateRebarMesh as meshImpl, generateBarMesh } from "./geometry";
import type { RebarLayout, RebarLayoutConfig, RebarHost } from "./types";

export * from "./types";
export { layoutRebar, layoutBeamRebar, layoutColumnRebar } from "./layout";
export { generateRebarMesh, generateBarMesh } from "./geometry";
export * from "./shapes";

/** Public Rebar service interface. */
export interface RebarService {
  /** Compute a rebar layout for a host element. */
  layout(cfg: Partial<RebarLayoutConfig>): RebarLayout;
  /** Generate 3D mesh for a rebar layout. */
  generateMesh(bars: RebarLayout["bars"], segments?: number, color?: string): ReturnType<typeof meshImpl>;
}

let installed = false;

export function setupRebar(): RebarService {
  if (installed) return (window as any).__obsRebar as RebarService;
  installed = true;

  const svc: RebarService = {
    layout: layoutImpl,
    generateMesh: meshImpl,
  };

  try { (window as any).__obsRebar = svc; } catch { /* */ }
  console.log("[rebar] ready. Shape library + layout engine + geometry generator online.");

  return svc;
}

/** True after setupRebar() has run. */
export function isRebarReady(): boolean {
  return installed;
}
