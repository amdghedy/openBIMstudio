/**
 * Structural Connections Library — steel moment / shear / base-plate / cap-plate / gussets.
 *
 * BIM-equivalent of Revit's "Structural Connection" tool. Generates
 * connection plates, bolt arrays, stiffeners, and capacity check reports at joints.
 */

import * as THREE from "three";
import { buildGussetPlate } from "./gusset-plate";
import { checkConnectionCapacity, formatCapacityReport, type ConnectionCapacity, type DesignForces } from "./connection-capacity";

export * from "./connection-capacity";
export * from "./gusset-plate";
export * from "./weld-annotations";
export * from "./anchor-bolt-pattern";

export type ConnectionType =
  | "moment-flange-plate"   // top + bottom flange plates
  | "shear-end-plate"        // single end plate
  | "base-plate"             // column-to-foundation
  | "cap-plate"              // column-to-beam top
  | "splice-plate"           // column-to-column butt splice
  | "gusset-plate"           // diagonal brace gusset plate
  | "double-angle-shear"     // bolted/welded double angle cleat
  | "welded-moment-end-plate"; // full-depth welded moment end plate

export interface ConnectionParams {
  type: ConnectionType;
  /** Connection centre in world. */
  origin: { x: number; y: number; z: number };
  /** Column section size (m) at this joint. */
  columnSize: number;
  /** Beam section size (m). */
  beamSize: number;
  /** Bolt diameter (m). */
  boltDiameter: number;
  /** Number of bolts per row. */
  boltsPerRow: number;
  /** Plate thickness (m). */
  plateThickness: number;
  /** Plate oversize factor (extra margin on member size). */
  plateOversize: number;
  /** Rotation around Y (radians). */
  angle?: number;
}

export interface ConnectionResult {
  plateCount: number;
  boltCount: number;
  weldLength: number;
  object: THREE.Object3D;
  capacity?: ConnectionCapacity;
}

const DEFAULTS = {
  boltDiameter: 0.02,
  boltsPerRow: 4,
  plateThickness: 0.02,
  plateOversize: 0.04,
  angle: 0,
};

function plateMesh(
  w: number, h: number, t: number,
  pos: THREE.Vector3, rotY: number = 0, color: number = 0x475569,
): THREE.Mesh {
  const geo = new THREE.BoxGeometry(w, h, t);
  const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color }));
  m.position.copy(pos);
  m.rotation.y = rotY;
  return m;
}

function boltInstanced(diameter: number, positions: THREE.Vector3[], rotY: number = 0): THREE.InstancedMesh {
  const geo = new THREE.CylinderGeometry(diameter * 0.5, diameter * 0.5, diameter * 2.5, 8);
  const mat = new THREE.MeshLambertMaterial({ color: 0x1f2937 });
  const inst = new THREE.InstancedMesh(geo, mat, positions.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, rotY, 0));
  const s = new THREE.Vector3(1, 1, 1);
  positions.forEach((p, i) => {
    m.compose(p, q, s);
    inst.setMatrixAt(i, m);
  });
  inst.instanceMatrix.needsUpdate = true;
  return inst;
}

/** Build a structural connection. */
export function buildStructuralConnection(input: Partial<ConnectionParams> = {}): ConnectionResult {
  const p: ConnectionParams = { ...DEFAULTS, ...input } as ConnectionParams;
  if (p.origin === undefined) p.origin = { x: 0, y: 0, z: 0 };

  // Handle gusset plate via dedicated module
  if (p.type === "gusset-plate") {
    const res = buildGussetPlate({
      origin: p.origin,
      columnSize: p.columnSize,
      beamSize: p.beamSize,
      plateThickness: p.plateThickness,
      boltDiameter: p.boltDiameter,
      boltsOnBrace: p.boltsPerRow,
      angle: p.angle,
    });
    return {
      plateCount: 1,
      boltCount: res.boltCount,
      weldLength: res.weldLength,
      object: res.object,
    };
  }

  const group = new THREE.Group();
  group.name = `obs-conn-${p.type}`;
  group.userData.kind = "structural-connection";
  group.userData.type = p.type;
  group.position.set(p.origin.x, p.origin.y, p.origin.z);
  group.rotation.y = -p.angle!;

  const cs = p.columnSize;
  const bs = p.beamSize;
  const oversize = p.plateOversize;
  const t = p.plateThickness;
  const boltD = p.boltDiameter;
  const colW = cs + oversize;
  const beamW = bs + oversize;
  const boltPositions: THREE.Vector3[] = [];
  let plateCount = 0;
  let weldLength = 0;

  if (p.type === "moment-flange-plate") {
    const flangeW = beamW;
    const flangeL = cs + 2 * beamW * 0.3;
    const top = plateMesh(flangeL, t, flangeW, new THREE.Vector3(0, bs * 0.5, 0));
    const bot = plateMesh(flangeL, t, flangeW, new THREE.Vector3(0, -bs * 0.5, 0));
    group.add(top); group.add(bot);
    plateCount = 2;
    weldLength = 4 * flangeL;
    const spacing = beamW / (p.boltsPerRow + 1);
    for (const yPos of [bs * 0.5, -bs * 0.5]) {
      for (let i = 1; i <= p.boltsPerRow; i++) {
        boltPositions.push(new THREE.Vector3(-flangeL * 0.5 + i * spacing, yPos, 0));
      }
    }
  } else if (p.type === "shear-end-plate" || p.type === "welded-moment-end-plate") {
    const plateW = colW;
    const plateH = p.type === "welded-moment-end-plate" ? beamW * 1.3 : beamW;
    const m = plateMesh(t, plateH, plateW, new THREE.Vector3(0, 0, colW * 0.5));
    group.add(m);
    plateCount = 1;
    weldLength = 2 * (plateW + plateH);
    const spacing = plateH / (p.boltsPerRow + 1);
    for (let i = 1; i <= p.boltsPerRow; i++) {
      boltPositions.push(new THREE.Vector3(0, -plateH * 0.5 + i * spacing, colW * 0.5 + t * 0.5));
    }
  } else if (p.type === "base-plate") {
    const plateW = colW + 0.1;
    const m = plateMesh(plateW, t, plateW, new THREE.Vector3(0, -t * 0.5, 0));
    group.add(m);
    plateCount = 1;
    weldLength = 4 * cs;
    const inset = plateW * 0.15;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      boltPositions.push(new THREE.Vector3(sx * (plateW * 0.5 - inset), t, sz * (plateW * 0.5 - inset)));
    }
  } else if (p.type === "cap-plate") {
    const plateW = colW + 0.05;
    const m = plateMesh(plateW, t, plateW, new THREE.Vector3(0, cs * 0.5 + t * 0.5, 0));
    group.add(m);
    plateCount = 1;
    weldLength = 4 * cs;
    const inset = plateW * 0.15;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      boltPositions.push(new THREE.Vector3(sx * (plateW * 0.5 - inset), cs * 0.5 + t * 0.5, sz * (plateW * 0.5 - inset)));
    }
  } else if (p.type === "double-angle-shear") {
    // Two angle cleats on beam web
    const angleH = bs * 0.7;
    const angleW = 0.09;
    const m1 = plateMesh(angleW, angleH, t, new THREE.Vector3(t, 0, 0.04));
    const m2 = plateMesh(angleW, angleH, t, new THREE.Vector3(t, 0, -0.04));
    group.add(m1); group.add(m2);
    plateCount = 2;
    weldLength = 4 * angleH;
    for (let i = 1; i <= p.boltsPerRow; i++) {
      boltPositions.push(new THREE.Vector3(0, -angleH * 0.5 + (i * angleH) / (p.boltsPerRow + 1), 0.04));
      boltPositions.push(new THREE.Vector3(0, -angleH * 0.5 + (i * angleH) / (p.boltsPerRow + 1), -0.04));
    }
  } else if (p.type === "splice-plate") {
    const spliceL = cs * 1.2;
    const spliceW = cs * 0.4;
    const positions = [
      new THREE.Vector3(0, cs * 0.5, 0),
      new THREE.Vector3(0, -cs * 0.5, 0),
      new THREE.Vector3(cs * 0.5, 0, 0),
      new THREE.Vector3(-cs * 0.5, 0, 0),
    ];
    for (const pos of positions) {
      const m = plateMesh(spliceL, t, spliceW, pos);
      group.add(m);
      plateCount++;
      weldLength += 2 * spliceL;
    }
    const spacing = spliceL / 5;
    for (const pos of positions) {
      for (let i = -2; i <= 2; i++) {
        boltPositions.push(new THREE.Vector3(pos.x + i * spacing, pos.y, pos.z));
      }
    }
  }

  if (boltPositions.length > 0) {
    const bolts = boltInstanced(boltD, boltPositions, 0);
    bolts.name = "obs-conn-bolts";
    group.add(bolts);
  }

  return {
    plateCount,
    boltCount: boltPositions.length,
    weldLength,
    object: group,
  };
}
