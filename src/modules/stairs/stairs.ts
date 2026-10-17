/**
 * Stairs Generator - parametric straight / L-shaped stairs (Revit-style).
 *
 * Produces a composed geometry spec + authored-element params from
 * riser/tread/width inputs. Integrates with the parametric family engine.
 */

import * as THREE from "three";
import { ctx } from "../../core/context";

export type StairRunType = "straight" | "l-shape" | "u-shape";

export interface StairParams {
  /** Total rise (floor-to-floor) in metres. */
  totalRise: number;
  /** Preferred riser height (m). Actual is computed to fit evenly. */
  maxRiser: number;
  /** Tread depth (going) in metres. */
  treadDepth: number;
  /** Clear width of the run. */
  width: number;
  /** Run type. */
  runType: StairRunType;
  /** Landing depth for L/U shapes. */
  landingDepth: number;
  /** Thickness of tread slab. */
  treadThickness: number;
  /** Starting world origin. */
  origin: { x: number; y: number; z: number };
  /** Run direction angle in XZ plane (radians). */
  angle: number;
}

export interface StairResult {
  riserCount: number;
  riserHeight: number;
  totalRun: number;
  treads: Array<{
    origin: THREE.Vector3;
    width: number;
    depth: number;
    height: number;
    elevation: number;
  }>;
  landings: Array<{
    origin: THREE.Vector3;
    width: number;
    depth: number;
    elevation: number;
  }>;
  object: THREE.Object3D;
}

const DEFAULTS: StairParams = {
  totalRise: 3.0,
  maxRiser: 0.175,
  treadDepth: 0.28,
  width: 1.2,
  runType: "straight",
  landingDepth: 1.2,
  treadThickness: 0.05,
  origin: { x: 0, y: 0, z: 0 },
  angle: 0,
};

function computeRisers(totalRise: number, maxRiser: number): { count: number; height: number } {
  const count = Math.max(1, Math.ceil(totalRise / maxRiser));
  return { count, height: totalRise / count };
}

/**
 * Build a parametric stair mesh from parameters.
 */
export function buildStair(input: Partial<StairParams> = {}): StairResult {
  const p: StairParams = { ...DEFAULTS, ...input, origin: { ...DEFAULTS.origin, ...input.origin } };
  const { count, height } = computeRisers(p.totalRise, p.maxRiser);
  const treadCount = count; // top landing is the upper floor
  const totalRun = (treadCount - 1) * p.treadDepth;

  const cos = Math.cos(p.angle);
  const sin = Math.sin(p.angle);
  const group = new THREE.Group();
  group.name = "obs-stair";

  const treads: StairResult["treads"] = [];
  const landings: StairResult["landings"] = [];

  const mat = new THREE.MeshLambertMaterial({ color: 0x94a3b8 });

  if (p.runType === "straight") {
    for (let i = 0; i < treadCount; i++) {
      const elev = p.origin.y + height * (i + 1) - p.treadThickness;
      const along = p.treadDepth * i;
      const ox = p.origin.x + cos * along;
      const oz = p.origin.z + sin * along;

      const geo = new THREE.BoxGeometry(p.width, p.treadThickness, p.treadDepth);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(ox, elev + p.treadThickness / 2, oz);
      mesh.rotation.y = -p.angle;
      group.add(mesh);

      treads.push({
        origin: new THREE.Vector3(ox, elev, oz),
        width: p.width,
        depth: p.treadDepth,
        height: p.treadThickness,
        elevation: elev,
      });
    }
  } else if (p.runType === "l-shape") {
    // First flight: half the risers
    const first = Math.ceil(count / 2);
    const second = count - first;

    for (let i = 0; i < first; i++) {
      const elev = p.origin.y + height * (i + 1) - p.treadThickness;
      const along = p.treadDepth * i;
      const ox = p.origin.x + cos * along;
      const oz = p.origin.z + sin * along;
      const geo = new THREE.BoxGeometry(p.width, p.treadThickness, p.treadDepth);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(ox, elev + p.treadThickness / 2, oz);
      mesh.rotation.y = -p.angle;
      group.add(mesh);
      treads.push({
        origin: new THREE.Vector3(ox, elev, oz),
        width: p.width,
        depth: p.treadDepth,
        height: p.treadThickness,
        elevation: elev,
      });
    }

    // Landing at turn
    const landElev = p.origin.y + height * first - p.treadThickness;
    const landAlong = p.treadDepth * first;
    const lx = p.origin.x + cos * landAlong;
    const lz = p.origin.z + sin * landAlong;
    const landGeo = new THREE.BoxGeometry(p.width, p.treadThickness, p.landingDepth);
    const landMesh = new THREE.Mesh(landGeo, mat);
    landMesh.position.set(lx, landElev + p.treadThickness / 2, lz);
    landMesh.rotation.y = -p.angle;
    group.add(landMesh);
    landings.push({
      origin: new THREE.Vector3(lx, landElev, lz),
      width: p.width,
      depth: p.landingDepth,
      elevation: landElev,
    });

    // Second flight perpendicular
    const angle2 = p.angle + Math.PI / 2;
    const cos2 = Math.cos(angle2);
    const sin2 = Math.sin(angle2);
    for (let i = 0; i < second; i++) {
      const elev = p.origin.y + height * (first + i + 1) - p.treadThickness;
      const along = p.treadDepth * (i + 1);
      const ox = lx + cos2 * along;
      const oz = lz + sin2 * along;
      const geo = new THREE.BoxGeometry(p.width, p.treadThickness, p.treadDepth);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(ox, elev + p.treadThickness / 2, oz);
      mesh.rotation.y = -angle2;
      group.add(mesh);
      treads.push({
        origin: new THREE.Vector3(ox, elev, oz),
        width: p.width,
        depth: p.treadDepth,
        height: p.treadThickness,
        elevation: elev,
      });
    }
  } else {
    // U-shape: two parallel flights with landing
    const first = Math.ceil(count / 2);
    const second = count - first;

    for (let i = 0; i < first; i++) {
      const elev = p.origin.y + height * (i + 1) - p.treadThickness;
      const along = p.treadDepth * i;
      const ox = p.origin.x + cos * along;
      const oz = p.origin.z + sin * along;
      const geo = new THREE.BoxGeometry(p.width, p.treadThickness, p.treadDepth);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(ox, elev + p.treadThickness / 2, oz);
      mesh.rotation.y = -p.angle;
      group.add(mesh);
      treads.push({
        origin: new THREE.Vector3(ox, elev, oz),
        width: p.width,
        depth: p.treadDepth,
        height: p.treadThickness,
        elevation: elev,
      });
    }

    const landElev = p.origin.y + height * first - p.treadThickness;
    const landAlong = p.treadDepth * first;
    const lx = p.origin.x + cos * landAlong;
    const lz = p.origin.z + sin * landAlong;
    const landGeo = new THREE.BoxGeometry(p.width * 2 + 0.2, p.treadThickness, p.landingDepth);
    const landMesh = new THREE.Mesh(landGeo, mat);
    // Offset landing sideways by half width
    const sideX = -sin * (p.width / 2 + 0.1);
    const sideZ = cos * (p.width / 2 + 0.1);
    landMesh.position.set(lx + sideX, landElev + p.treadThickness / 2, lz + sideZ);
    landMesh.rotation.y = -p.angle;
    group.add(landMesh);
    landings.push({
      origin: new THREE.Vector3(lx + sideX, landElev, lz + sideZ),
      width: p.width * 2,
      depth: p.landingDepth,
      elevation: landElev,
    });

    const angle2 = p.angle + Math.PI; // reverse
    const cos2 = Math.cos(angle2);
    const sin2 = Math.sin(angle2);
    const start2x = lx + sideX * 2;
    const start2z = lz + sideZ * 2;
    for (let i = 0; i < second; i++) {
      const elev = p.origin.y + height * (first + i + 1) - p.treadThickness;
      const along = p.treadDepth * (i + 1);
      const ox = start2x + cos2 * along;
      const oz = start2z + sin2 * along;
      const geo = new THREE.BoxGeometry(p.width, p.treadThickness, p.treadDepth);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(ox, elev + p.treadThickness / 2, oz);
      mesh.rotation.y = -angle2;
      group.add(mesh);
      treads.push({
        origin: new THREE.Vector3(ox, elev, oz),
        width: p.width,
        depth: p.treadDepth,
        height: p.treadThickness,
        elevation: elev,
      });
    }
  }

  return {
    riserCount: count,
    riserHeight: height,
    totalRun,
    treads,
    landings,
    object: group,
  };
}

/** Comfort rule check (Blondel): 2R + T - 0.63 m. */
export function stairComfort(riserHeight: number, treadDepth: number): {
  ok: boolean;
  value: number;
  message: string;
} {
  const value = 2 * riserHeight + treadDepth;
  const ok = value >= 0.59 && value <= 0.65;
  return {
    ok,
    value,
    message: ok
      ? `Comfort OK (2R+T = ${value.toFixed(3)} m)`
      : `Comfort warning: 2R+T = ${value.toFixed(3)} m (target 0.59-0.65)`,
  };
}

export function setupStairs(): void {
  (ctx.features as any).stairs = { buildStair, stairComfort };
  (window as any).__obsStairs = { buildStair, stairComfort };
  console.log("[stairs] generator ready");
}
