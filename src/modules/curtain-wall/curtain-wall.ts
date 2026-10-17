/**
 * Curtain Wall System - grid of mullions + panels (BIM-style).
 *
 * Defines a rectangular curtain wall on a vertical plane, subdivided by
 * horizontal and vertical grid lines. Generates mullion boxes + panel faces.
 */

import * as THREE from "three";
import { ctx } from "../../core/context";

export interface CurtainWallParams {
  /** Width along local X (m). */
  width: number;
  /** Height along local Y (m). */
  height: number;
  /** Origin (bottom-left of wall in world). */
  origin: { x: number; y: number; z: number };
  /** Facing angle in XZ (radians). */
  angle: number;
  /** Number of vertical divisions (columns of panels). */
  vDivisions: number;
  /** Number of horizontal divisions (rows of panels). */
  hDivisions: number;
  /** Mullion depth (projection from plane). */
  mullionDepth: number;
  /** Mullion thickness. */
  mullionThickness: number;
  /** Panel thickness. */
  panelThickness: number;
  /** Optional custom V-grid positions 0-1 (overrides even divisions). */
  vGrid?: number[];
  /** Optional custom H-grid positions 0-1. */
  hGrid?: number[];
}

export interface CurtainWallResult {
  panelCount: number;
  mullionCount: number;
  object: THREE.Object3D;
  panels: Array<{
    u0: number; u1: number; v0: number; v1: number;
    center: THREE.Vector3;
  }>;
}

const DEFAULTS: CurtainWallParams = {
  width: 6,
  height: 3.5,
  origin: { x: 0, y: 0, z: 0 },
  angle: 0,
  vDivisions: 4,
  hDivisions: 2,
  mullionDepth: 0.12,
  mullionThickness: 0.05,
  panelThickness: 0.02,
};

function gridLines(count: number, custom?: number[]): number[] {
  if (custom && custom.length >= 2) {
    return [...custom].sort((a, b) => a - b);
  }
  const lines: number[] = [];
  for (let i = 0; i <= count; i++) lines.push(i / count);
  return lines;
}

export function buildCurtainWall(input: Partial<CurtainWallParams> = {}): CurtainWallResult {
  const p: CurtainWallParams = {
    ...DEFAULTS,
    ...input,
    origin: { ...DEFAULTS.origin, ...input.origin },
  };

  const group = new THREE.Group();
  group.name = "obs-curtain-wall";

  const cos = Math.cos(p.angle);
  const sin = Math.sin(p.angle);
  // Local axes: U along width, V along height, N outward
  const uAxis = new THREE.Vector3(cos, 0, sin);
  const vAxis = new THREE.Vector3(0, 1, 0);
  const nAxis = new THREE.Vector3(-sin, 0, cos);

  const vLines = gridLines(p.vDivisions, p.vGrid);
  const hLines = gridLines(p.hDivisions, p.hGrid);

  const mullionMat = new THREE.MeshLambertMaterial({ color: 0x64748b });
  const panelMat = new THREE.MeshLambertMaterial({
    color: 0x7dd3fc,
    transparent: true,
    opacity: 0.35,
    side: THREE.DoubleSide,
  });

  let mullionCount = 0;
  const origin = new THREE.Vector3(p.origin.x, p.origin.y, p.origin.z);

  // Vertical mullions
  for (const u of vLines) {
    const base = origin.clone().addScaledVector(uAxis, u * p.width);
    const geo = new THREE.BoxGeometry(p.mullionThickness, p.height, p.mullionDepth);
    const mesh = new THREE.Mesh(geo, mullionMat);
    mesh.position.copy(base).addScaledVector(vAxis, p.height / 2).addScaledVector(nAxis, p.mullionDepth / 2);
    mesh.rotation.y = -p.angle;
    group.add(mesh);
    mullionCount++;
  }

  // Horizontal mullions
  for (const v of hLines) {
    const base = origin.clone().addScaledVector(vAxis, v * p.height);
    const geo = new THREE.BoxGeometry(p.width, p.mullionThickness, p.mullionDepth);
    const mesh = new THREE.Mesh(geo, mullionMat);
    mesh.position.copy(base).addScaledVector(uAxis, p.width / 2).addScaledVector(nAxis, p.mullionDepth / 2);
    mesh.rotation.y = -p.angle;
    group.add(mesh);
    mullionCount++;
  }

  // Panels
  const panels: CurtainWallResult["panels"] = [];
  for (let i = 0; i < vLines.length - 1; i++) {
    for (let j = 0; j < hLines.length - 1; j++) {
      const u0 = vLines[i];
      const u1 = vLines[i + 1];
      const v0 = hLines[j];
      const v1 = hLines[j + 1];
      const pw = (u1 - u0) * p.width - p.mullionThickness;
      const ph = (v1 - v0) * p.height - p.mullionThickness;
      if (pw <= 0.01 || ph <= 0.01) continue;

      const cu = (u0 + u1) / 2;
      const cv = (v0 + v1) / 2;
      const center = origin
        .clone()
        .addScaledVector(uAxis, cu * p.width)
        .addScaledVector(vAxis, cv * p.height)
        .addScaledVector(nAxis, p.panelThickness / 2);

      const geo = new THREE.BoxGeometry(pw, ph, p.panelThickness);
      const mesh = new THREE.Mesh(geo, panelMat);
      mesh.position.copy(center);
      mesh.rotation.y = -p.angle;
      mesh.userData.curtainPanel = { row: j, col: i };
      group.add(mesh);

      panels.push({ u0, u1, v0, v1, center });
    }
  }

  return {
    panelCount: panels.length,
    mullionCount,
    object: group,
    panels,
  };
}

/** Insert a grid line at normalized position (0-1). */
export function insertGridLine(
  lines: number[],
  position: number,
): number[] {
  const t = Math.max(0.01, Math.min(0.99, position));
  if (lines.some((l) => Math.abs(l - t) < 0.01)) return lines;
  return [...lines, t].sort((a, b) => a - b);
}

export function setupCurtainWall(): void {
  (ctx.features as any).curtainWall = { buildCurtainWall, insertGridLine };
  (window as any).__obsCurtainWall = { buildCurtainWall, insertGridLine };
  console.log("[curtain-wall] system ready");
}
