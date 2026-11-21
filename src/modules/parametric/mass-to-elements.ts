/**
 * Mass-to-BIM Element Conversion Engine.
 *
 * Classifies polygon faces of conceptual mass volumes based on surface normals:
 * - Upward normal (+Y / +Z) => Floor / Slab or Roof
 * - Vertical normal => Wall or Curtain Wall
 * - Downward normal => Soffit / Foundation
 */

export type TargetBimType = "wall" | "curtain-wall" | "floor" | "roof" | "foundation";

export interface MassFaceClassification {
  faceIndex: number;
  normal: { x: number; y: number; z: number };
  areaM2: number;
  suggestedType: TargetBimType;
  confidence: number; // 0 to 1
}

export function classifyMassFace(
  normal: { x: number; y: number; z: number },
  areaM2: number,
  faceIndex: number
): MassFaceClassification {
  // Assuming Y is world-up
  const upDot = Math.abs(normal.y);

  if (normal.y < -0.707) {
    // Bottom surface (> 45 deg down) => foundation slab, not a roof:
    // the old code fell through to the "sloped roof" branch for a
    // downward normal, so a mass bottom face was classified as roof.
    return {
      faceIndex,
      normal,
      areaM2,
      suggestedType: "foundation",
      confidence: 0.95,
    };
  } else if (normal.y > 0.707) {
    // Top surface (> 45 deg)
    return {
      faceIndex,
      normal,
      areaM2,
      suggestedType: areaM2 > 50 ? "floor" : "roof",
      confidence: 0.95,
    };
  } else if (upDot < 0.35) {
    // Steep/vertical face => Wall or Curtain Wall
    return {
      faceIndex,
      normal,
      areaM2,
      suggestedType: areaM2 > 30 ? "curtain-wall" : "wall",
      confidence: 0.9,
    };
  } else {
    // Sloped roof
    return {
      faceIndex,
      normal,
      areaM2,
      suggestedType: "roof",
      confidence: 0.85,
    };
  }
}

// ── Mass → elements ──────────────────────────────────────────────────────────

import type { MassElement } from "../in-place-mass/types";

/**
 * Minimal surface of the authoring service the conversion needs. The real
 * `__obsAuthoring.createElementByType(type, params, hostId?)` satisfies
 * this interface structurally (the ribbon call site passes it, so
 * `tsc` checks the assignment there); tests use a small in-memory
 * implementation instead, because authoring.ts is a browser module not
 * loadable in node.
 */
export interface MassElementSink {
  createElement(type: string, params: Record<string, unknown>): Promise<string | null>;
}

export interface ConvertedMassFace {
  faceIndex: number;
  /** Classification the conversion followed. */
  suggestedType: TargetBimType;
  /** Authored element type actually created. */
  elementType: string;
  elementId: string;
  areaM2: number;
  confidence: number;
}

export interface SkippedMassFace {
  faceIndex: number;
  suggestedType: TargetBimType;
  reason: string;
}

export interface MassConversionReport {
  massId: string;
  massName: string;
  created: ConvertedMassFace[];
  skipped: SkippedMassFace[];
}

/** Shoelace area of a [x, z] polygon. */
function polygonAreaM2(poly: Array<[number, number]>): number {
  let area = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i];
    const [x2, z2] = poly[(i + 1) % poly.length];
    area += x1 * z2 - x2 * z1;
  }
  return Math.abs(area / 2);
}

/**
 * Convert a conceptual mass (extruded polygon) into native authored
 * elements: one element per face, classified by `classifyMassFace`.
 *
 * - vertical faces → wall (area ≤ 30 m²) or curtain-wall (above);
 * - top face → roof (area ≤ 50 m²) or floor (above), at the mass top;
 * - bottom face → foundation, built as a slab at elevation 0.
 *
 * Walls are created with the polygon edge as start/end and the mass
 * height; slabs/roofs carry the whole footprint polygon. A face whose
 * creation returns null is reported in `skipped`, never thrown — one
 * failed face must not lose the rest of the conversion. Throws only
 * for a mass that cannot be converted at all (fewer than 3 polygon
 * points, zero area, or non-positive height).
 */
export async function convertMassToElements(
  mass: MassElement,
  sink: MassElementSink,
): Promise<MassConversionReport> {
  const poly = mass.basePolygon;
  if (!Array.isArray(poly) || poly.length < 3) {
    throw new Error(`Mass "${mass.name}" has no usable footprint polygon (needs ≥ 3 points).`);
  }
  if (!(mass.height > 0) || !Number.isFinite(mass.height)) {
    throw new Error(`Mass "${mass.name}" has no positive height (${mass.height}).`);
  }
  const area = polygonAreaM2(poly);
  if (!(area > 1e-9)) {
    throw new Error(`Mass "${mass.name}" has zero footprint area.`);
  }

  const report: MassConversionReport = { massId: mass.id, massName: mass.name, created: [], skipped: [] };
  let faceIndex = 0;

  const create = async (
    classification: MassFaceClassification,
    elementType: string,
    params: Record<string, unknown>,
  ): Promise<void> => {
    let id: string | null = null;
    try {
      id = await sink.createElement(elementType, params);
    } catch (error) {
      report.skipped.push({
        faceIndex: classification.faceIndex,
        suggestedType: classification.suggestedType,
        reason: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!id) {
      report.skipped.push({
        faceIndex: classification.faceIndex,
        suggestedType: classification.suggestedType,
        reason: `authoring refused to create a ${elementType}`,
      });
      return;
    }
    report.created.push({
      faceIndex: classification.faceIndex,
      suggestedType: classification.suggestedType,
      elementType,
      elementId: id,
      areaM2: classification.areaM2,
      confidence: classification.confidence,
    });
  };

  // Bottom face (index 0): downward normal, elevation 0.
  await create(
    classifyMassFace({ x: 0, y: -1, z: 0 }, area, faceIndex++),
    "slab",
    { polygon: poly.map(([x, z]) => [x, z] as [number, number]), elevation: 0 },
  );
  // Top face (index 1): upward normal, elevation = mass height.
  // roof for a small top face, floor for a large one — the
  // classification decides; the element type follows it.
  const topClassification = classifyMassFace({ x: 0, y: 1, z: 0 }, area, faceIndex++);
  await create(
    topClassification,
    topClassification.suggestedType === "floor" ? "slab" : "roof",
    { polygon: poly.map(([x, z]) => [x, z] as [number, number]), elevation: mass.height },
  );
  // Side faces (index 2+): one per polygon edge, vertical normal.
  for (let i = 0; i < poly.length; i++) {
    const [x1, z1] = poly[i];
    const [x2, z2] = poly[(i + 1) % poly.length];
    const edgeLength = Math.hypot(x2 - x1, z2 - z1);
    if (edgeLength < 1e-6) continue; // degenerate edge: no face to build
    // Outward normal of the edge in plan (polygon is [x, z]; the
    // outward side is the right of the edge direction for a CCW
    // footprint, the left for CW — the sign only matters for the
    // classification's vertical branch, which uses |y|, so either is
    // correct here; keep the geometric outward normal for the report).
    const nx = (z2 - z1) / edgeLength;
    const nz = -(x2 - x1) / edgeLength;
    const classification = classifyMassFace({ x: nx, y: 0, z: nz }, edgeLength * mass.height, faceIndex);
    const elementType = classification.suggestedType === "curtain-wall" ? "curtain-wall" : "wall";
    await create(classification, elementType, {
      start: [x1, z1],
      end: [x2, z2],
      elevation: 0,
      height: mass.height,
    });
    faceIndex++;
  }
  return report;
}
