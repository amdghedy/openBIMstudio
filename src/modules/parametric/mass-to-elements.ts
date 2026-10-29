/**
 * Mass-to-BIM Element Conversion Engine.
 *
 * Classifies polygon faces of conceptual mass volumes based on surface normals:
 * - Upward normal (+Y / +Z) => Floor / Slab or Roof
 * - Vertical normal => Wall or Curtain Wall
 * - Downward normal => Soffit / Foundation
 */

export type TargetBimType = "wall" | "curtain-wall" | "floor" | "roof";

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

  if (normal.y > 0.707) {
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
