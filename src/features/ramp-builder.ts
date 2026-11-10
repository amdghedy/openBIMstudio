/**
 * Ramp mesh builder — closes the "Ramp is an equipment box" gap.
 *
 * The ribbon Ramp tool mapped through TOOL_ALIASES to the generic
 * equipment draw tool, so placing a Ramp produced a featureless box. The
 * ramps engine (modules/ramps/ramps.ts — slope slab, optional landing and
 * side rails) was fully implemented but reachable from no UI.
 *
 * Now "ramp" is a first-class authored element type: placement creates a
 * real ramp element and this builder renders it from its parameters:
 *   params.height    → rise (m)
 *   params.width     → ramp width (m)
 *   params.thickness → slab thickness (m)
 *   properties.slope → slope percent (default 8.333 = 1:12 accessible)
 *   properties.run   → horizontal run override (m); default derived from rise/slope
 *   properties.angle → plan rotation (degrees)
 *   properties.sideRails → add guard rails
 */
import * as THREE from "three";
import { ctx } from "../core/context";
import { buildRamp } from "../modules/ramps/ramps";

type Any = Record<string, any>;

const ACCESSIBLE_SLOPE_PCT = 100 / 12; // 1:12 — ADA/accessibility standard ramp

export function rampMeshBuilder(el: Any): THREE.Object3D | null {
  const p = el?.params ?? {};
  const point = Array.isArray(p.point) ? p.point : [0, 0];
  const rise = Math.max(0.05, Number(p.height) || 1.5);
  const width = Math.max(0.4, Number(p.width) || 1.5);
  const thickness = Math.max(0.02, Number(p.thickness) || 0.2);
  const slopePct = Number(el?.properties?.slope) > 0 ? Number(el.properties.slope) : ACCESSIBLE_SLOPE_PCT;
  const runProp = Number(el?.properties?.run);
  const run = runProp > 0.05 ? runProp : rise / (slopePct / 100);
  const angleDeg = Number(el?.properties?.angle) || 0;
  try {
    const r = buildRamp({
      rise,
      run,
      width,
      thickness,
      angle: THREE.MathUtils.degToRad(angleDeg),
      sideRails: !!el?.properties?.sideRails,
      origin: { x: point[0], y: Number(p.elevation) || 0, z: point[1] },
      color: 0x9ca3af,
    });
    return r.object;
  } catch {
    return null;
  }
}

let installed = false;
export function setupRampBuilder(): void {
  if (installed) return; installed = true;
  const f = (ctx as Any).features ?? ((ctx as Any).features = {});
  const registry = (f.meshBuilders = f.meshBuilders ?? {});
  registry.ramp = rampMeshBuilder;
  console.log("[ramp-builder] ready — authored ramp elements render as real sloped slabs");
}
