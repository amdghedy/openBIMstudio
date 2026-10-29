/**
 * Anchor Bolt Pattern Generator for Column Base Plates.
 *
 * Generates square, rectangular, and circular anchor bolt groups with embedment specs.
 */

import * as THREE from "three";

export type AnchorPatternType = "square-4" | "square-8" | "circular-6" | "circular-8";

export interface AnchorBoltSpec {
  diameterMm: number;
  grade: "F1554-36" | "F1554-55" | "F1554-105" | "8.8";
  lengthMm: number;
  hookType: "J-bolt" | "headed" | "straight";
  projectionMm: number;
}

export interface AnchorBoltGroup {
  id: string;
  pattern: AnchorPatternType;
  boltSpec: AnchorBoltSpec;
  positions: Array<{ x: number; y: number }>; // in meters
  origin: { x: number; y: number; z: number };
}

export function generateAnchorPositions(
  pattern: AnchorPatternType,
  spacingXM: number = 0.25,
  spacingYM: number = 0.25,
  circleDiaM: number = 0.35
): Array<{ x: number; y: number }> {
  const pos: Array<{ x: number; y: number }> = [];

  if (pattern === "square-4") {
    const hx = spacingXM / 2;
    const hy = spacingYM / 2;
    pos.push({ x: -hx, y: -hy }, { x: hx, y: -hy }, { x: hx, y: hy }, { x: -hx, y: hy });
  } else if (pattern === "square-8") {
    const hx = spacingXM / 2;
    const hy = spacingYM / 2;
    pos.push(
      { x: -hx, y: -hy }, { x: 0, y: -hy }, { x: hx, y: -hy },
      { x: hx, y: 0 }, { x: hx, y: hy }, { x: 0, y: hy },
      { x: -hx, y: hy }, { x: -hx, y: 0 }
    );
  } else if (pattern === "circular-6" || pattern === "circular-8") {
    const n = pattern === "circular-6" ? 6 : 8;
    const r = circleDiaM / 2;
    for (let i = 0; i < n; i++) {
      const angle = (i * 2 * Math.PI) / n;
      pos.push({ x: r * Math.cos(angle), y: r * Math.sin(angle) });
    }
  }

  return pos;
}

export function buildAnchorBoltGeometry(group: AnchorBoltGroup): THREE.Group {
  const g = new THREE.Group();
  g.name = `obs-anchors-${group.pattern}`;
  g.position.set(group.origin.x, group.origin.y, group.origin.z);

  const diaM = group.boltSpec.diameterMm / 1000;
  const lenM = group.boltSpec.lengthMm / 1000;
  const projM = group.boltSpec.projectionMm / 1000;

  const boltGeo = new THREE.CylinderGeometry(diaM / 2, diaM / 2, lenM + projM, 8);
  const boltMat = new THREE.MeshLambertMaterial({ color: 0x334155 });

  for (const p of group.positions) {
    const m = new THREE.Mesh(boltGeo, boltMat);
    // Cylinder centered, offset downward into foundation
    m.position.set(p.x, (projM - lenM) / 2, p.y);
    g.add(m);
  }

  return g;
}

export function renderAnchorPatternPlanSVG(group: AnchorBoltGroup, plateWMm: number = 400): string {
  const size = 160;
  const center = size / 2;
  const scale = (size * 0.8) / plateWMm;

  const boltCircles = group.positions.map((p) => {
    const cx = center + p.x * 1000 * scale;
    const cy = center + p.y * 1000 * scale;
    const r = Math.max(3, (group.boltSpec.diameterMm / 2) * scale);
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#0f172a" />`;
  });

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <rect x="${center - (plateWMm / 2) * scale}" y="${center - (plateWMm / 2) * scale}" width="${plateWMm * scale}" height="${plateWMm * scale}" fill="#e2e8f0" stroke="#0f172a" stroke-width="1.5" />
      <line x1="${center}" y1="10" x2="${center}" y2="${size - 10}" stroke="#94a3b8" stroke-dasharray="3,3" />
      <line x1="10" y1="${center}" x2="${size - 10}" y2="${center}" stroke="#94a3b8" stroke-dasharray="3,3" />
      ${boltCircles.join("\n")}
    </svg>
  `;
}
