/**
 * Roof Eaves & Wall Attachment Engine.
 *
 * Parametric attachments along roof boundaries: Fascia boards, soffits, and gutters.
 */

export interface RoofAttachmentProfile {
  id: string;
  type: "fascia" | "soffit" | "gutter";
  depthM: number;
  thicknessM: number;
  material: string;
  overhangM: number;
}

export function generateFasciaPolyline(
  roofPerimeter: Array<{ x: number; y: number; z: number }>,
  fasciaDepthM: number = 0.2
): Array<{ start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }> {
  const segments: Array<{ start: { x: number; y: number; z: number }; end: { x: number; y: number; z: number } }> = [];

  for (let i = 0; i < roofPerimeter.length; i++) {
    const p1 = roofPerimeter[i];
    const p2 = roofPerimeter[(i + 1) % roofPerimeter.length];
    segments.push({
      start: { x: p1.x, y: p1.y - fasciaDepthM / 2, z: p1.z },
      end: { x: p2.x, y: p2.y - fasciaDepthM / 2, z: p2.z },
    });
  }

  return segments;
}
