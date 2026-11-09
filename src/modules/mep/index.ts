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
import {
  ductPressureDrop as ductPd, pipePressureDrop as pipePd, worstPath as worstPathImpl, classifyFrictionRate as classifyImpl,
} from "./pressure";
import type { MepSize, MepSystem, RouteRequest, RouteResult, SizingResult } from "./types";
import { MepModelLifecycle } from "./model-lifecycle";
import { optimizeCsdPacking as optimizeCsdPackingImpl } from "./csd-packing";
import type { CsdPackingRequest, CsdPackingResult, CsdSectionBoundary, CsdServiceItem, CsdRelationship } from "./csd-packing";
import { compileKbCsdRules as compileKbCsdRulesImpl } from "./kb-csd-rules";
import type { KbCsdRuleCompilation, KbCsdRuleContext, KbCsdRuleProfile } from "./kb-csd-rules";
import * as mepPlumbing from "./plumbing";
import * as mepConvert from "./convert";
import * as mepFire from "./fire";
import * as mepElectricalCalc from "./electrical-calc";
import * as mepInsulation from "./insulation";
import * as mepRunTools from "./run-tools";
import * as mepSizingMethods from "./sizing-methods";
import * as mepNetwork from "./network";
import * as mepEquipment from "./equipment";
import * as mepDrainage from "./drainage";
import * as mepDistribution from "./distribution";

export * from "./types";
export * from "./connectors";
export * from "./electrical";
export * from "./model-lifecycle";
export * from "./csd-packing";
export * from "./kb-csd-rules";
export { route, routeSimple } from "./router";
export { sizeForSystem, validateSize, defaultVelocityFor, maxVelocityFor } from "./sizing";
export {
  ductPressureDrop, pipePressureDrop, worstPath, classifyFrictionRate,
  colebrook, hydraulicDiameter, FITTING_C, ROUGHNESS, FLUID,
} from "./pressure";
export type {
  DuctSegment, PipeSegment, PressureEdge, PressureNetwork, PressureResult, WorstPathResult,
} from "./pressure";
export * from "./plumbing";
export * from "./convert";
export * from "./fire";
export * from "./electrical-calc";
export * from "./insulation";
export * from "./run-tools";
export * from "./sizing-methods";
export * from "./network";
export * from "./equipment";
export * from "./drainage";
export * from "./distribution";

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
  /** Native model lifecycle: connectors, electrical assignments, schedules and diagnostics. */
  lifecycle: MepModelLifecycle;
  /** Deterministic KB-BIM CSD candidate generator. */
  optimizeCsdPacking(request: CsdPackingRequest): CsdPackingResult;
  /** Compile approved, traceable project rules into solver-ready constraints. */
  compileKbCsdRules(input: { profile: KbCsdRuleProfile; context: KbCsdRuleContext; boundary: CsdSectionBoundary; items: CsdServiceItem[]; baseRelationships?: CsdRelationship[] }): KbCsdRuleCompilation;
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
    lifecycle: new MepModelLifecycle(),
    optimizeCsdPacking: optimizeCsdPackingImpl,
    compileKbCsdRules: compileKbCsdRulesImpl,
  };

  // v0.67: pressure-loss engineering rides on the same service.
  const svcAny = svc as any;
  svcAny.ductPressureDrop = ductPd;
  svcAny.pipePressureDrop = pipePd;
  svcAny.worstPath = worstPathImpl;
  svcAny.classifyFrictionRate = classifyImpl;

  // v0.75: parametric superhero pack — plumbing demand, unit/cross-section
  // conversions, sprinkler hydraulics, electrical quick calc, insulation
  // and run-editing tools ride on the same service.
  svcAny.plumbing = mepPlumbing;
  svcAny.convert = mepConvert;
  svcAny.fire = mepFire;
  svcAny.electricalCalc = mepElectricalCalc;
  svcAny.insulation = mepInsulation;
  svcAny.runTools = mepRunTools;

  // Revit-parity engineering pack: friction/static-regain sizing methods,
  // model-native network audit (System Inspector / Pressure Loss Report),
  // fan & pump duty selection, DFU drainage sizing and the electrical
  // distribution cascade with wire-sized panel schedules.
  svcAny.sizingMethods = mepSizingMethods;
  svcAny.network = mepNetwork;
  svcAny.equipment = mepEquipment;
  svcAny.drainage = mepDrainage;
  svcAny.distribution = mepDistribution;

  // Register in the typed service registry + legacy ctx.features bag.
  try {
    register("mep" as any, svc as any);
  } catch {
    // ServiceMap may not yet declare "mep"; fall back to ctx.features.
  }
  (ctx.features as any).mep = svc;
  try { (window as any).__obsMep = svc; } catch { /* */ }

  console.log(
    "[mep] ready. A* router + ASHRAE sizing + parametric superhero pack + Revit-parity engineering pack online. " +
    "Use the __obsMep service (.route, .plumbing.fixtureUnitsToDemand, .fire.designDemand, " +
    ".electricalCalc.voltageDrop, .insulation, .runTools, .sizingMethods, .network.auditNetwork, " +
    ".equipment.fanSelection/.pumpSelection, .drainage.sizeDrain, .distribution.buildDistributionSummary) " +
    "or the 'MEP Auto-Route…' / 'MEP Design Toolkit…' commands.",
  );

  return svc;
}

/** True after setupMep() has run. */
export function isMepReady(): boolean {
  return installed;
}
