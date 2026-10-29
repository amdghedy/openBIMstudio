/**
 * Gusset Plate Connection Generator for Diagonal Bracing.
 *
 * Generates parametric steel gusset plates connecting braces to beams and columns.
 */

import * as THREE from "three";

export interface GussetPlateParams {
  origin: { x: number; y: number; z: number };
  braceAngleDeg: number; // Angle from horizontal (e.g. 45°)
  braceSize: number; // in meters (e.g. 0.15 for HSS150)
  columnSize: number;
  beamSize: number;
  plateThickness: number;
  boltDiameter: number;
  boltsOnBrace: number;
  boltsOnBeam: number;
  boltsOnColumn: number;
  angle?: number;
}

export interface GussetResult {
  plateArea: number; // m²
  boltCount: number;
  weldLength: number;
  whitmore: number; // Whitmore section effective width (m)
  object: THREE.Object3D;
}

export function buildGussetPlate(input: Partial<GussetPlateParams> = {}): GussetResult {
  const origin = input.origin || { x: 0, y: 0, z: 0 };
  const braceAngle = ((input.braceAngleDeg || 45) * Math.PI) / 180;
  const braceSize = input.braceSize || 0.15;
  const colSize = input.columnSize || 0.3;
  const beamSize = input.beamSize || 0.35;
  const t = input.plateThickness || 0.016;
  const boltD = input.boltDiameter || 0.02;
  const boltsOnBrace = input.boltsOnBrace || 4;

  const group = new THREE.Group();
  group.name = "obs-conn-gusset-plate";
  group.userData.kind = "structural-connection";
  group.userData.type = "gusset-plate";
  group.position.set(origin.x, origin.y, origin.z);

  // Polygonal gusset shape
  const lengthX = beamSize * 1.6;
  const heightY = colSize * 1.6;

  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(lengthX, 0);
  shape.lineTo(lengthX * 0.7, heightY * 0.7);
  shape.lineTo(0, heightY);
  shape.closePath();

  const extrudeSettings = {
    steps: 1,
    depth: t,
    bevelEnabled: false,
  };

  const geo = new THREE.ExtrudeGeometry(shape, extrudeSettings);
  const mat = new THREE.MeshLambertMaterial({ color: 0x475569 });
  const plateMesh = new THREE.Mesh(geo, mat);
  // Center thickness around z=0
  plateMesh.position.z = -t / 2;
  group.add(plateMesh);

  // Bolts along brace axis
  const boltPositions: THREE.Vector3[] = [];
  const spacing = 0.08;
  const startDist = 0.15;
  for (let i = 0; i < boltsOnBrace; i++) {
    const dist = startDist + i * spacing;
    boltPositions.push(
      new THREE.Vector3(
        dist * Math.cos(braceAngle),
        dist * Math.sin(braceAngle),
        0
      )
    );
  }

  // Bolt mesh
  if (boltPositions.length > 0) {
    const boltGeo = new THREE.CylinderGeometry(boltD * 0.5, boltD * 0.5, boltD * 2.5, 8);
    const boltMat = new THREE.MeshLambertMaterial({ color: 0x1f2937 });
    const inst = new THREE.InstancedMesh(boltGeo, boltMat, boltPositions.length);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
    const s = new THREE.Vector3(1, 1, 1);
    boltPositions.forEach((p, idx) => {
      m.compose(p, q, s);
      inst.setMatrixAt(idx, m);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.name = "obs-gusset-bolts";
    group.add(inst);
  }

  const plateArea = (lengthX * heightY) / 2;
  const weldLength = lengthX + heightY; // welded to beam flange & column flange
  const whitmore = braceSize + 2 * Math.tan((30 * Math.PI) / 180) * (boltsOnBrace * spacing);

  return {
    plateArea: Math.round(plateArea * 1000) / 1000,
    boltCount: boltPositions.length,
    weldLength: Math.round(weldLength * 1000) / 1000,
    whitmore: Math.round(whitmore * 1000) / 1000,
    object: group,
  };
}
