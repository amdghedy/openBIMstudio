/**
 * CAD Revision Cloud Arc Renderer.
 *
 * Converts a polygon vertex list into authentic drafting revision clouds
 * composed of scalloped bezier or circular arcs along each boundary segment.
 */

import type { RevisionCloudDef } from "./model";

export function polygonToCloudSvgPath(points: [number, number][], arcRadius: number = 8): string {
  if (!points || points.length < 3) return "";

  const pathParts: string[] = [];

  for (let i = 0; i < points.length; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % points.length];

    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const segLen = Math.sqrt(dx * dx + dy * dy);

    if (segLen <= 0.001) continue;

    const arcCount = Math.max(1, Math.round(segLen / (arcRadius * 1.5)));
    const arcStep = segLen / arcCount;

    // Normal pointing outward
    const nx = -dy / segLen;
    const ny = dx / segLen;

    for (let j = 0; j < arcCount; j++) {
      const tStart = (j * arcStep) / segLen;
      const tEnd = ((j + 1) * arcStep) / segLen;
      const tMid = ((j + 0.5) * arcStep) / segLen;

      const startPt: [number, number] = [p1[0] + dx * tStart, p1[1] + dy * tStart];
      const endPt: [number, number] = [p1[0] + dx * tEnd, p1[1] + dy * tEnd];

      // Scallop control point pushed outwards
      const bulge = arcRadius * 0.7;
      const ctrlPt: [number, number] = [
        p1[0] + dx * tMid + nx * bulge,
        p1[1] + dy * tMid + ny * bulge,
      ];

      if (pathParts.length === 0) {
        pathParts.push(`M ${startPt[0]} ${startPt[1]}`);
      }
      pathParts.push(`Q ${ctrlPt[0]} ${ctrlPt[1]} ${endPt[0]} ${endPt[1]}`);
    }
  }

  pathParts.push("Z");
  return pathParts.join(" ");
}

export function renderCloudsSvg(clouds: RevisionCloudDef[], strokeColor: string = "#ef4444"): string {
  return clouds
    .map((c) => {
      const d = polygonToCloudSvgPath(c.points);
      if (!d) return "";
      return `<path d="${d}" fill="none" stroke="${strokeColor}" stroke-width="1.8" stroke-linecap="round" />`;
    })
    .join("\n");
}
