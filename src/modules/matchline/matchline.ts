/**
 * Matchline — sheet composition annotation marking view overlap region.
 *
 * BIM-equivalent of Revit's "Matchline" tool. A matchline is a polyline drawn
 * in a view that, when the view is split across multiple sheets, marks where
 * the views overlap and shows a "View Reference" annotation pointing to the
 * adjacent sheet.
 */

import * as THREE from "three";

export interface MatchlineParams {
  /** Polyline points (plan-view 2D). */
  points: Array<{ x: number; z: number }>;
  /** Elevation (Y). */
  elevation?: number;
  /** Line colour (hex). */
  color?: number;
  /** Line weight (1-16). */
  lineWeight?: number;
  /** Gap line ticks (BIM convention — show ticks at line ends). */
  showTicks?: boolean;
  /** Annotation labels at each end. */
  labels?: { left: string; right: string };
}

export interface MatchlineResult {
  length: number;
  object: THREE.Object3D;
  leftLabel: string;
  rightLabel: string;
}

const DEFAULTS = {
  elevation: 1.0,
  color: 0x16a34a,
  lineWeight: 4,
  showTicks: true,
};

/** Build a matchline object. */
export function buildMatchline(input: MatchlineParams): MatchlineResult {
  const p: MatchlineParams & typeof DEFAULTS = { ...DEFAULTS, ...input };
  if (p.points.length < 2) throw new Error("Matchline needs ≥2 points");

  const group = new THREE.Group();
  group.name = "obs-matchline";
  group.userData.kind = "matchline";

  // Main polyline.
  const positions: number[] = [];
  for (const pt of p.points) positions.push(pt.x, p.elevation, pt.z);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color: p.color, linewidth: p.lineWeight });
  const line = new THREE.Line(geo, mat);
  group.add(line);

  // Compute total length.
  let length = 0;
  for (let i = 1; i < p.points.length; i++) {
    const a = p.points[i - 1];
    const b = p.points[i];
    length += Math.hypot(b.x - a.x, b.z - a.z);
  }

  // Tick marks at start and end.
  if (p.showTicks) {
    const tickGeo = new THREE.CylinderGeometry(0.04, 0.04, p.lineWeight * 0.1, 6);
    const tickMat = new THREE.MeshBasicMaterial({ color: p.color });
    for (const end of [p.points[0], p.points[p.points.length - 1]]) {
      const tick = new THREE.Mesh(tickGeo, tickMat);
      tick.position.set(end.x, p.elevation, end.z);
      group.add(tick);
    }
  }

  return {
    length,
    object: group,
    leftLabel: p.labels?.left ?? "← A",
    rightLabel: p.labels?.right ?? "B →",
  };
}
