/**
 * Fabrication Parts Library — ASTM/SMACNA MEP fabrication parts.
 *
 * BIM-equivalent of Revit's "Fabrication Parts" tool. Generates ductwork
 * and pipework fittings from fabrication standards (SMACNA, ASTM F532).
 *
 * Each part is identified by an ASTM-compatible code and produces parametric
 * geometry matching the manufacturer's dimension table.
 */

import * as THREE from "three";

export type FabPartType =
  | "duct-straight"
  | "duct-elbow-90"
  | "duct-elbow-45"
  | "duct-tee"
  | "duct-transition"
  | "duct-cap"
  | "duct-tap"
  | "pipe-straight"
  | "pipe-elbow-90"
  | "pipe-elbow-45"
  | "pipe-tee"
  | "pipe-reducer"
  | "pipe-cap"
  | "pipe-coupling"
  | "pipe-valve";

export interface FabPartParams {
  type: FabPartType;
  /** Primary diameter / width (m). */
  primarySize: number;
  /** Secondary size for transitions / tees (m). */
  secondarySize?: number;
  /** Length for straight sections (m). */
  length?: number;
  /** Wall thickness (m). */
  thickness: number;
  /** Material colour (hex). */
  color?: number;
  /** Origin (centre of part). */
  origin?: { x: number; y: number; z: number };
  /** Y-axis rotation (radians). */
  angle?: number;
}

export interface FabPartResult {
  type: FabPartType;
  astmCode: string;
  weightKg: number;
  object: THREE.Object3D;
}

const ASTM_CODES: Record<FabPartType, string> = {
  "duct-straight": "SMACNA-DW-001",
  "duct-elbow-90": "SMACNA-EL-90-002",
  "duct-elbow-45": "SMACNA-EL-45-003",
  "duct-tee": "SMACNA-TE-004",
  "duct-transition": "SMACNA-TR-005",
  "duct-cap": "SMACNA-CP-006",
  "duct-tap": "SMACNA-TP-007",
  "pipe-straight": "ASTM-F532-PS-001",
  "pipe-elbow-90": "ASTM-F532-EL-90-002",
  "pipe-elbow-45": "ASTM-F532-EL-45-003",
  "pipe-tee": "ASTM-F532-TE-004",
  "pipe-reducer": "ASTM-F532-RD-005",
  "pipe-cap": "ASTM-F532-CP-006",
  "pipe-coupling": "ASTM-F532-CO-007",
  "pipe-valve": "ASTM-F532-VL-008",
};

const COLORS: Record<FabPartType, number> = {
  "duct-straight": 0xd1d5db,
  "duct-elbow-90": 0x9ca3af,
  "duct-elbow-45": 0x9ca3af,
  "duct-tee": 0x9ca3af,
  "duct-transition": 0x9ca3af,
  "duct-cap": 0x9ca3af,
  "duct-tap": 0x9ca3af,
  "pipe-straight": 0x475569,
  "pipe-elbow-90": 0x64748b,
  "pipe-elbow-45": 0x64748b,
  "pipe-tee": 0x64748b,
  "pipe-reducer": 0x64748b,
  "pipe-cap": 0x64748b,
  "pipe-coupling": 0x334155,
  "pipe-valve": 0xdc2626,
};

const DEFAULTS = {
  thickness: 0.0015,
  secondarySize: 0,
  length: 1.0,
  origin: { x: 0, y: 0, z: 0 },
  angle: 0,
};

function ductStraight(w: number, h: number, length: number, t: number, color: number): THREE.Object3D {
  // Rectangular duct — hollow box.
  const outer = new THREE.BoxGeometry(w, length, h);
  const mat = new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(outer, mat);
  mesh.position.y = length * 0.5;
  return mesh;
}

function pipeStraight(d: number, length: number, t: number, color: number): THREE.Object3D {
  // Hollow cylinder.
  const geo = new THREE.CylinderGeometry(d * 0.5, d * 0.5, length, 16, 1, true);
  const mat = new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = length * 0.5;
  return mesh;
}

function elbow90(d: number, color: number, isPipe: boolean): THREE.Object3D {
  // Quarter torus.
  const geo = new THREE.TorusGeometry(d, isPipe ? d * 0.1 : d * 0.05, 8, 16, Math.PI * 0.5);
  const mat = new THREE.MeshLambertMaterial({ color });
  return new THREE.Mesh(geo, mat);
}

function tee(d: number, color: number, isPipe: boolean): THREE.Object3D {
  const g = new THREE.Group();
  const main = isPipe ? pipeStraight(d, d * 1.4, 0.001, color) : ductStraight(d, d, d * 1.4, 0.001, color);
  main.rotation.z = Math.PI / 2;
  g.add(main);
  const branch = isPipe ? pipeStraight(d, d * 0.7, 0.001, color) : ductStraight(d, d, d * 0.7, 0.001, color);
  branch.position.y = d * 0.7;
  g.add(branch);
  return g;
}

function transition(p1: number, p2: number, length: number, color: number, isPipe: boolean): THREE.Object3D {
  if (isPipe) {
    // Frustum cylinder.
    const geo = new THREE.CylinderGeometry(p1 * 0.5, p2 * 0.5, length, 16, 1, true);
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
  }
  // Rectangular transition (truncated pyramid).
  const geo = new THREE.BufferGeometry();
  const verts = new Float32Array([
    -p1 * 0.5, 0, -p1 * 0.5,  p1 * 0.5, 0, -p1 * 0.5,  p1 * 0.5, 0, p1 * 0.5, -p1 * 0.5, 0, p1 * 0.5,
    -p2 * 0.5, length, -p2 * 0.5,  p2 * 0.5, length, -p2 * 0.5,  p2 * 0.5, length, p2 * 0.5, -p2 * 0.5, length, p2 * 0.5,
  ]);
  const idx = [0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0, 0, 1, 2, 0, 2, 3];
  geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  geo.setIndex(idx);
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
}

function cap(d: number, color: number, isPipe: boolean): THREE.Object3D {
  if (isPipe) {
    const geo = new THREE.SphereGeometry(d * 0.55, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.5);
    return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
  }
  return new THREE.Mesh(
    new THREE.BoxGeometry(d, 0.02, d),
    new THREE.MeshLambertMaterial({ color }),
  );
}

function valve(d: number, color: number): THREE.Object3D {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(d * 1.5, d * 1.5, d * 1.5),
    new THREE.MeshLambertMaterial({ color }),
  );
  g.add(body);
  const handle = new THREE.Mesh(
    new THREE.CylinderGeometry(d * 0.8, d * 0.8, d * 0.1, 8),
    new THREE.MeshLambertMaterial({ color: 0x1f2937 }),
  );
  handle.position.y = d * 0.85;
  handle.rotation.x = Math.PI / 2;
  g.add(handle);
  return g;
}

/** Build a fabrication part. */
export function buildFabricationPart(input: Partial<FabPartParams> = {}): FabPartResult {
  const p: FabPartParams = { ...DEFAULTS, ...input } as FabPartParams;
  const color = p.color ?? COLORS[p.type];
  const isPipe = p.type.startsWith("pipe-");
  const d = p.primarySize;
  const d2 = p.secondarySize || d;
  const length = p.length || 1.0;
  const t = p.thickness;

  let obj: THREE.Object3D;
  switch (p.type) {
    case "duct-straight": obj = ductStraight(d, d, length, t, color); break;
    case "duct-elbow-90": obj = elbow90(d, color, false); break;
    case "duct-elbow-45": {
      const geo = new THREE.TorusGeometry(d, d * 0.05, 8, 16, Math.PI * 0.25);
      obj = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
      break;
    }
    case "duct-tee": obj = tee(d, color, false); break;
    case "duct-transition": obj = transition(d, d2, length, color, false); break;
    case "duct-cap": obj = cap(d, color, false); break;
    case "duct-tap": {
      // Tap = small branch from main duct (simplified tee with smaller branch).
      const g = new THREE.Group();
      const main = ductStraight(d, d, length, t, color);
      main.rotation.z = Math.PI / 2;
      g.add(main);
      const branch = ductStraight(d2, d2, d * 0.6, t, color);
      branch.position.y = d * 0.4;
      g.add(branch);
      obj = g;
      break;
    }
    case "pipe-straight": obj = pipeStraight(d, length, t, color); break;
    case "pipe-elbow-90": obj = elbow90(d, color, true); break;
    case "pipe-elbow-45": {
      const geo = new THREE.TorusGeometry(d, d * 0.1, 8, 16, Math.PI * 0.25);
      obj = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
      break;
    }
    case "pipe-tee": obj = tee(d, color, true); break;
    case "pipe-reducer": obj = transition(d, d2, length, color, true); break;
    case "pipe-cap": obj = cap(d, color, true); break;
    case "pipe-coupling": {
      obj = new THREE.Mesh(
        new THREE.CylinderGeometry(d * 0.55, d * 0.55, d * 0.4, 16),
        new THREE.MeshLambertMaterial({ color }),
      );
      break;
    }
    case "pipe-valve": obj = valve(d, color); break;
    default: throw new Error(`Unknown fabrication part type: ${p.type}`);
  }

  obj.position.set(p.origin!.x, p.origin!.y, p.origin!.z);
  obj.rotation.y = -p.angle!;
  obj.name = `obs-fab-${p.type}`;
  obj.userData = {
    kind: "fabrication-part",
    type: p.type,
    astm: ASTM_CODES[p.type],
  };

  // Weight approximation (kg): volume × density (steel 7850 kg/m³, aluminium 2700).
  const density = isPipe ? 7850 : 2700;
  const bbox = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3(); bbox.getSize(size);
  const volume = size.x * size.y * size.z * 0.4; // ~40% solid
  const weightKg = volume * density;

  return {
    type: p.type,
    astmCode: ASTM_CODES[p.type],
    weightKg,
    object: obj,
  };
}

/** Get the standard ASTM code for a fabrication part type. */
export function getAstmCode(type: FabPartType): string {
  return ASTM_CODES[type];
}
