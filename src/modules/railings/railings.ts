/**
 * Railing Generator - path-based railings with balusters (Revit-style).
 */

import * as THREE from "three";
import { ctx } from "../../core/context";

export interface RailingParams {
  /** Path points in world XZ (y used as elevation offset). */
  path: Array<{ x: number; y?: number; z: number }>;
  /** Top rail height above path elevation. */
  height: number;
  /** Baluster spacing (m). */
  balusterSpacing: number;
  /** Baluster cross-section size. */
  balusterSize: number;
  /** Top rail diameter. */
  railDiameter: number;
  /** Number of intermediate horizontal rails (0 = none). */
  intermediateRails: number;
  /** Base elevation. */
  elevation: number;
}

export interface RailingResult {
  balusterCount: number;
  length: number;
  object: THREE.Object3D;
}

const DEFAULTS: RailingParams = {
  path: [
    { x: 0, z: 0 },
    { x: 3, z: 0 },
  ],
  height: 1.1,
  balusterSpacing: 0.12,
  balusterSize: 0.02,
  railDiameter: 0.04,
  intermediateRails: 1,
  elevation: 0,
};

function pathLength(path: RailingParams["path"]): number {
  let len = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    len += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return len;
}

function pointAt(path: RailingParams["path"], dist: number): { x: number; z: number; tx: number; tz: number } {
  let remaining = dist;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (seg < 1e-9) continue;
    if (remaining <= seg) {
      const t = remaining / seg;
      const tx = (b.x - a.x) / seg;
      const tz = (b.z - a.z) / seg;
      return {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        tx,
        tz,
      };
    }
    remaining -= seg;
  }
  const last = path[path.length - 1];
  const prev = path[path.length - 2] ?? last;
  const seg = Math.hypot(last.x - prev.x, last.z - prev.z) || 1;
  return {
    x: last.x,
    z: last.z,
    tx: (last.x - prev.x) / seg,
    tz: (last.z - prev.z) / seg,
  };
}

export function buildRailing(input: Partial<RailingParams> = {}): RailingResult {
  const p: RailingParams = {
    ...DEFAULTS,
    ...input,
    path: input.path?.length ? input.path : DEFAULTS.path,
  };

  const group = new THREE.Group();
  group.name = "obs-railing";
  const mat = new THREE.MeshLambertMaterial({ color: 0xcbd5e1 });
  const length = pathLength(p.path);

  // Top rail as a tube along the path at height
  const railPts: THREE.Vector3[] = [];
  const steps = Math.max(2, Math.ceil(length / 0.25));
  for (let i = 0; i <= steps; i++) {
    const d = (length * i) / steps;
    const pt = pointAt(p.path, d);
    railPts.push(new THREE.Vector3(pt.x, p.elevation + p.height, pt.z));
  }
  if (railPts.length >= 2) {
    const curve = new THREE.CatmullRomCurve3(railPts);
    const railGeo = new THREE.TubeGeometry(curve, steps * 2, p.railDiameter / 2, 8, false);
    group.add(new THREE.Mesh(railGeo, mat));
  }

  // Intermediate rails
  for (let r = 1; r <= p.intermediateRails; r++) {
    const h = p.elevation + (p.height * r) / (p.intermediateRails + 1);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= steps; i++) {
      const d = (length * i) / steps;
      const pt = pointAt(p.path, d);
      pts.push(new THREE.Vector3(pt.x, h, pt.z));
    }
    if (pts.length >= 2) {
      const curve = new THREE.CatmullRomCurve3(pts);
      const geo = new THREE.TubeGeometry(curve, steps * 2, p.railDiameter / 3, 6, false);
      group.add(new THREE.Mesh(geo, mat));
    }
  }

  // Balusters
  let balusterCount = 0;
  const spacing = Math.max(0.05, p.balusterSpacing);
  for (let d = 0; d <= length + 1e-6; d += spacing) {
    const pt = pointAt(p.path, Math.min(d, length));
    const geo = new THREE.BoxGeometry(p.balusterSize, p.height, p.balusterSize);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pt.x, p.elevation + p.height / 2, pt.z);
    group.add(mesh);
    balusterCount++;
  }

  return { balusterCount, length, object: group };
}

export function setupRailings(): void {
  (ctx.features as any).railings = { buildRailing };
  (window as any).__obsRailings = { buildRailing };
  console.log("[railings] generator ready");
}
