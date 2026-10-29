/**
 * MEP Pipe & Duct Hanger Auto-Placement Engine.
 *
 * Automatically places hangers and supports along routed runs based on
 * SMACNA (ductwork) and MSS SP-69 (piping) support span standards.
 */

import type { MepElementType, RouteLeg, Vec3 } from "./types";

export interface HangerSpec {
  id: string;
  elementId?: string;
  position: Vec3;
  type: "clevis" | "trapeze" | "unistrut";
  rodDiameterMm: number;
  rodLengthM: number;
  loadKg: number;
}

export interface HangerRules {
  maxSpanDuctM: number;
  maxSpanPipeM: number;
  rodDiameterMm: number;
  hangerType: HangerSpec["type"];
}

export const DEFAULT_HANGER_RULES: HangerRules = {
  maxSpanDuctM: 2.4, // SMACNA standard 8 ft / 2.4m
  maxSpanPipeM: 3.0, // MSS SP-69 standard 10 ft / 3.0m
  rodDiameterMm: 10, // 3/8" or M10 standard rod
  hangerType: "trapeze",
};

export function placeHangers(
  legs: RouteLeg[],
  elementType: MepElementType,
  sizeMm: number = 300,
  rules: HangerRules = DEFAULT_HANGER_RULES
): HangerSpec[] {
  const hangers: HangerSpec[] = [];
  const maxSpan = elementType === "duct" ? rules.maxSpanDuctM : rules.maxSpanPipeM;

  let hangerCounter = 1;

  for (const leg of legs) {
    if (leg.isVertical) continue; // Riser clamps handle vertical legs, not hanging rods

    const len = leg.length;
    if (len < 0.5) continue;

    // Number of hangers needed on this leg
    const count = Math.max(1, Math.floor(len / maxSpan));
    const step = len / (count + 1);

    const dx = (leg.end.x - leg.start.x) / len;
    const dy = (leg.end.y - leg.start.y) / len;
    const dz = (leg.end.z - leg.start.z) / len;

    for (let i = 1; i <= count; i++) {
      const dist = step * i;
      const pos: Vec3 = {
        x: Math.round((leg.start.x + dx * dist) * 1000) / 1000,
        y: Math.round((leg.start.y + dy * dist) * 1000) / 1000,
        z: Math.round((leg.start.z + dz * dist) * 1000) / 1000,
      };

      // Estimated load in kg (weight of duct/pipe + insulation + fluid)
      const loadKg = Math.round((sizeMm / 10) * step * 1.5);

      hangers.push({
        id: `hgr-${hangerCounter++}`,
        position: pos,
        type: elementType === "duct" ? "trapeze" : "clevis",
        rodDiameterMm: rules.rodDiameterMm,
        rodLengthM: 0.6, // default 600mm drop from ceiling slab
        loadKg,
      });
    }
  }

  return hangers;
}

export function hangersToIfcData(hangers: HangerSpec[]): object[] {
  return hangers.map((h) => ({
    type: "IfcFastener",
    id: h.id,
    Name: `Hanger ${h.type} (${h.rodDiameterMm}mm)`,
    ObjectType: "MEP Support",
    Position: h.position,
    Properties: {
      HangerType: h.type,
      RodDiameterMm: h.rodDiameterMm,
      DesignLoadKg: h.loadKg,
    },
  }));
}
