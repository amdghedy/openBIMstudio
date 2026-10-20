/**
 * Ramp Generator — sloped floor ramps with optional landings.
 *
 * BIM-equivalent of Revit's "Ramp" tool. Produces a single-slope ramp
 * slab with optional mid-landing, slope percentage and side rails.
 *
 * Geometry convention: ramp runs along +X direction (modified by `angle`),
 * width along Z, slope rises along Y.
 */

import * as THREE from "three";

export interface RampParams {
  /** Total rise (m). */
  rise: number;
  /** Run length along X (m). */
  run: number;
  /** Clear width (m). */
  width: number;
  /** Slope percentage override (optional — overrides run). */
  slopePercent?: number;
  /** Optional landing at midpoint. */
  landing?: { length: number };
  /** Slab thickness (m). */
  thickness: number;
  /** Origin in world. */
  origin: { x: number; y: number; z: number };
  /** Run direction angle (radians, XZ plane). */
  angle: number;
  /** Generate side rails (height 1.1 m). */
  sideRails?: boolean;
  /** Material colour. */
  color?: number;
}

export interface RampResult {
  slopePercent: number;
  slopeAngle: number;
  actualRun: number;
  area: number;
  object: THREE.Object3D;
}

const DEFAULTS = {
  width: 1.5,
  thickness: 0.15,
  angle: 0,
  sideRails: false,
  color: 0x9ca3af,
  origin: { x: 0, y: 0, z: 0 },
};

function buildSlopeSlab(
  rise: number,
  run: number,
  width: number,
  thickness: number,
  color: number,
  startOffset: { x: number; y: number; z: number },
  angle: number,
): THREE.Mesh {
  const slopeAngle = Math.atan2(rise, run);
  const length = Math.hypot(run, rise);
  const geo = new THREE.BoxGeometry(length, thickness, width);
  const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
  mesh.position.set(
    startOffset.x + Math.cos(angle) * length * 0.5,
    startOffset.y + rise * 0.5,
    startOffset.z + Math.sin(angle) * length * 0.5,
  );
  // Rotate slab to align with slope + plan angle.
  mesh.rotation.set(0, -angle, 0);
  mesh.rotateZ(-slopeAngle);
  return mesh;
}

/** Build a ramp. */
export function buildRamp(input: Partial<RampParams> = {}): RampResult {
  const p: RampParams = { ...DEFAULTS, ...input, origin: { ...DEFAULTS.origin, ...(input.origin ?? {}) } } as RampParams;
  if (!p.origin) p.origin = { x: 0, y: 0, z: 0 };
  if (p.slopePercent !== undefined) {
    p.run = p.rise / (p.slopePercent / 100);
  }
  if (p.run <= 0 || p.rise <= 0) throw new Error("Ramp needs positive rise and run");

  const group = new THREE.Group();
  group.name = "obs-ramp";
  group.userData.kind = "ramp";
  group.position.set(p.origin.x, p.origin.y, p.origin.z);
  group.rotation.y = -p.angle;

  const cos = Math.cos(p.angle);
  const sin = Math.sin(p.angle);

  let actualRun = p.run;
  let slopeRise = p.rise;
  if (p.landing) {
    // First half slope up to landing
    const halfRise = p.rise * 0.5;
    const halfRun = (p.run - p.landing.length) * 0.5;
    const slab1 = buildSlopeSlab(halfRise, halfRun, p.width, p.thickness, p.color!, { x: 0, y: 0, z: 0 }, 0);
    group.add(slab1);
    // Landing slab
    const landGeo = new THREE.BoxGeometry(p.landing.length, p.thickness, p.width);
    const landMesh = new THREE.Mesh(landGeo, new THREE.MeshLambertMaterial({ color: p.color }));
    landMesh.position.set(halfRun + p.landing.length * 0.5, halfRise, 0);
    group.add(landMesh);
    // Second slope
    const slab2 = buildSlopeSlab(
      halfRise, halfRun, p.width, p.thickness, p.color!,
      { x: halfRun + p.landing.length, y: halfRise, z: 0 },
      0,
    );
    group.add(slab2);
    actualRun = p.run;
  } else {
    const slab = buildSlopeSlab(p.rise, p.run, p.width, p.thickness, p.color!, { x: 0, y: 0, z: 0 }, 0);
    group.add(slab);
  }

  const slopePercent = (p.rise / p.run) * 100;
  const slopeAngle = Math.atan2(p.rise, p.run) * (180 / Math.PI);
  const area = p.run * p.width;

  // Optional rails along both edges.
  if (p.sideRails) {
    const railHeight = 1.1;
    for (const zSign of [-1, 1]) {
      const railGeo = new THREE.BoxGeometry(0.05, 0.05, p.width);
      const railMat = new THREE.MeshLambertMaterial({ color: 0x6b7280 });
      // Top rail (sloped)
      const railTop = new THREE.Mesh(railGeo, railMat);
      railTop.position.set(actualRun * 0.5, slopeRise * 0.5 + railHeight, zSign * p.width * 0.5);
      railTop.rotation.y = Math.PI / 2;
      railTop.rotation.x = Math.atan2(slopeRise, actualRun);
      group.add(railTop);
    }
  }

  return {
    slopePercent,
    slopeAngle,
    actualRun,
    area,
    object: group,
  };
}
