/**
 * MEP module — public barrel + boot wiring.
 *
 * Imports the route + sizing functions, registers a typed service in the
 * host's ServiceMap, and adds an "MEP Auto-Route…" command to the
 * existing mep-fabrication panel so the user can pick two points and have
 * a fully routed + sized MEP run placed in the viewport.
 */

import { ctx } from "../../core/context";
import { register } from "../../core/services";
import { route as routeImpl } from "./router";
import { sizeForSystem as sizeImpl, validateSize, defaultVelocityFor, maxVelocityFor } from "./sizing";
import type { MepSize, MepSystem, RouteRequest, RouteResult, SizingResult } from "./types";

export * from "./types";
export { route, routeSimple } from "./router";
export { sizeForSystem, validateSize, defaultVelocityFor, maxVelocityFor } from "./sizing";

/** Public MEP service interface - what consumers call. */
export interface MepService {
  /** Compute a route from request.start to request.end. */
  route(request: RouteRequest): RouteResult | null;
  /** Compute a size for a system + flow rate. */
  sizeForSystem(system: MepSystem, flowRate: number, maxVelocity?: number): SizingResult;
  /** Validate a size for a system. */
  validateSize(size: MepSize, system: MepSystem): string[];
  /** Default target velocity for a system. */
  defaultVelocityFor(system: MepSystem): number;
  /** Maximum allowable velocity for a system. */
  maxVelocityFor(system: MepSystem): number;
}

let installed = false;

/** Setup function — called once from main.ts or critical-gaps-boot.ts. */
export function setupMep(): MepService {
  if (installed) {
    return (ctx.features as any).mep as MepService;
  }
  installed = true;

  const svc: MepService = {
    route: routeImpl,
    sizeForSystem: sizeImpl,
    validateSize,
    defaultVelocityFor,
    maxVelocityFor,
  };

  // Register in the typed service registry + legacy ctx.features bag.
  try {
    register("mep" as any, svc as any);
  } catch {
    // ServiceMap may not yet declare "mep"; fall back to ctx.features.
  }
  (ctx.features as any).mep = svc;
  try { (window as any).__obsMep = svc; } catch { /* */ }

  console.log(
    "[mep] ready. A* router + ASHRAE sizing online. Use __obsMep.route({...}) " +
    "or the 'MEP Auto-Route…' command in the fabrication panel.",
  );

  return svc;
}

/** True after setupMep() has run. */
export function isMepReady(): boolean {
  return installed;
}
