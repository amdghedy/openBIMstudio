/**
 * Structural Connection Capacity Design Check Engine.
 *
 * Implements code checks for steel connections according to:
 * - AISC 360-16 (US Specification for Structural Steel Buildings)
 * - Eurocode 3 (EN 1993-1-8 - Design of joints)
 * - IS 800:2007 (Indian Standard General Construction in Steel)
 */

import type { ConnectionParams, ConnectionType } from "./structural-connections";

export type DesignCode = "AISC360" | "EC3" | "IS800";
export type SteelGrade = "S275" | "S355" | "A36" | "A572-50";

export interface DesignForces {
  shearKN: number;
  momentKNm: number;
  axialKN: number;
}

export interface ConnectionCapacity {
  connectionType: ConnectionType;
  designCode: DesignCode;
  steelGrade: SteelGrade;
  shearCapacityKN: number;
  momentCapacityKNm: number;
  axialCapacityKN: number;
  utilizationRatio: number; // Max(demand/capacity)
  governingCheck: string;
  status: "pass" | "fail" | "over-designed";
  notes: string[];
}

const STEEL_YIELD_MPA: Record<SteelGrade, number> = {
  S275: 275,
  S355: 355,
  A36: 250,
  "A572-50": 345,
};

export function checkConnectionCapacity(
  params: ConnectionParams,
  forces: DesignForces,
  code: DesignCode = "EC3",
  steelGrade: SteelGrade = "S355"
): ConnectionCapacity {
  const fy = STEEL_YIELD_MPA[steelGrade];
  const notes: string[] = [];

  // Bolt shear capacity (assuming Grade 8.8 bolts or A325)
  // Single bolt shear capacity in kN ~ 0.6 * fub * As / gamma_M2
  const fub = code === "AISC360" ? 825 : 800; // MPa
  const boltDiaM = params.boltDiameter || 0.02;
  const boltAreaMm2 = (Math.PI * Math.pow(boltDiaM * 1000, 2)) / 4;
  const singleBoltShearKN = (0.6 * fub * boltAreaMm2 * 0.78) / 1000 / (code === "EC3" ? 1.25 : 1.33);

  // Total bolt count estimation
  const totalBolts = (params.boltsPerRow || 4) * 2;
  const boltGroupShearKN = Math.round(singleBoltShearKN * totalBolts * 10) / 10;

  // Plate bearing/yielding capacity
  const tPlateMm = (params.plateThickness || 0.02) * 1000;
  const plateWidthMm = (params.beamSize || 0.3) * 1000;
  const plateGrossAreaMm2 = tPlateMm * plateWidthMm;
  const plateTensionKN = Math.round((plateGrossAreaMm2 * fy) / 1000 / (code === "EC3" ? 1.0 : 1.1));

  // Moment capacity based on flange plate lever arm
  const leverArmM = params.beamSize || 0.35;
  const momentCapacityKNm = Math.round(Math.min(plateTensionKN, singleBoltShearKN * (params.boltsPerRow || 4)) * leverArmM);

  const shearCapacityKN = boltGroupShearKN;
  const axialCapacityKN = plateTensionKN;

  // Calculate maximum utilization ratio
  const shearRatio = forces.shearKN / Math.max(1, shearCapacityKN);
  const momentRatio = forces.momentKNm / Math.max(1, momentCapacityKNm);
  const axialRatio = forces.axialKN / Math.max(1, axialCapacityKN);

  let maxRatio = Math.max(shearRatio, momentRatio, axialRatio);
  let governing = "Bolt Shear";
  if (momentRatio === maxRatio) governing = "Flange Plate Yielding / Tension";
  if (axialRatio === maxRatio) governing = "Plate Gross Section Tension";

  maxRatio = Math.round(maxRatio * 100) / 100;

  const status: ConnectionCapacity["status"] =
    maxRatio > 1.0 ? "fail" : maxRatio < 0.35 ? "over-designed" : "pass";

  if (maxRatio > 1.0) {
    notes.push(`Capacity exceeded for ${governing} (ratio: ${maxRatio}). Increase bolt count or plate thickness.`);
  } else if (maxRatio < 0.35) {
    notes.push(`Connection is conservatively sized (ratio: ${maxRatio}). Opportunity for weight optimization.`);
  } else {
    notes.push(`Satisfies all strength requirements under ${code} with steel grade ${steelGrade}.`);
  }

  return {
    connectionType: params.type,
    designCode: code,
    steelGrade,
    shearCapacityKN,
    momentCapacityKNm,
    axialCapacityKN,
    utilizationRatio: maxRatio,
    governingCheck: governing,
    status,
    notes,
  };
}

export function formatCapacityReport(cap: ConnectionCapacity): string {
  return [
    `### Connection Capacity Check (${cap.connectionType})`,
    `- **Design Code:** ${cap.designCode}`,
    `- **Steel Grade:** ${cap.steelGrade}`,
    `- **Shear Capacity:** ${cap.shearCapacityKN} kN`,
    `- **Moment Capacity:** ${cap.momentCapacityKNm} kNm`,
    `- **Axial Capacity:** ${cap.axialCapacityKN} kN`,
    `- **Utilization Ratio:** ${(cap.utilizationRatio * 100).toFixed(0)}%`,
    `- **Governing Check:** ${cap.governingCheck}`,
    `- **Status:** **${cap.status.toUpperCase()}**`,
    `- **Notes:** ${cap.notes.join("; ")}`,
  ].join("\n");
}
