/**
 * Truss Generator — pitched chord Pratt / Howe / Warren trusses.
 *
 * BIM-equivalent of Revit's "Truss" tool. Produces a triangulated truss
 * with top chord, bottom chord and web members, based on span / depth /
 * panel count.
 *
 * Geometry convention: truss spans along +X, depth along Y, thickness along Z.
 */

import * as THREE from "three";

export type TrussType = "pratt" | "howe" | "warren" | "fink";

export interface TrussParams {
  /** Span between supports (m). */
  span: number;
  /** Peak height above bottom chord (m). */
  depth: number;
  /** Number of panels (must be even for symmetric trusses). */
  panelCount: number;
  /** Out-of-plane thickness (m). */
  thickness: number;
  /** Truss type. */
  type: TrussType;
  /** Top chord section size (m). */
  topChordSize: number;
  /** Bottom chord section size (m). */
  bottomChordSize: number;
  /** Web member section size (m). */
  webSize: number;
  /** Origin (bottom-left support). */
  origin: { x: number; y: number; z: number };
  /** Rotation around Y axis (radians). */
  angle?: number;
}

export interface TrussResult {
  panelLength: number;
  members: Array<{
    kind: "top-chord" | "bottom-chord" | "web-vertical" | "web-diagonal" | "ridge";
    start: { x: number; y: number; z: number };
    end: { x: number; y: number; z: number };
    length: number;
  }>;
  totalSteelLength: number;
  object: THREE.Object3D;
}

const DEFAULTS = {
  panelCount: 6,
  thickness: 0.2,
  type: "pratt" as TrussType,
  topChordSize: 0.1,
  bottomChordSize: 0.1,
  webSize: 0.06,
  origin: { x: 0, y: 0, z: 0 },
  angle: 0,
};

function makeChord(
  start: THREE.Vector3,
  end: THREE.Vector3,
  size: number,
  mat: THREE.Material,
): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(end, start);
  const len = dir.length();
  const geo = new THREE.BoxGeometry(len, size, size);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(start).add(end).multiplyScalar(0.5);
  mesh.lookAt(end);
  return mesh;
}

/** Build a truss. */
export function buildTruss(input: Partial<TrussParams> = {}): TrussResult {
  const p: TrussParams = { ...DEFAULTS, ...input, origin: { ...DEFAULTS.origin, ...input.origin } } as TrussParams;
  if (p.span <= 0 || p.depth <= 0) throw new Error("Truss needs positive span and depth");
  if (p.panelCount < 2) throw new Error("Truss needs ≥2 panels");
  const panels = p.panelCount;
  const panelLen = p.span / panels;

  const group = new THREE.Group();
  group.name = `obs-truss-${p.type}`;
  group.userData.kind = "truss";
  group.position.set(p.origin.x, p.origin.y, p.origin.z);
  group.rotation.y = -p.angle!;

  const matTop = new THREE.MeshLambertMaterial({ color: 0xb91c1c });
  const matBot = new THREE.MeshLambertMaterial({ color: 0x1d4ed8 });
  const matWeb = new THREE.MeshLambertMaterial({ color: 0x475569 });

  const members: TrussResult["members"] = [];
  let totalSteel = 0;

  // Helper to add a chord and bookkeep.
  const addMember = (
    sx: number, sy: number, sz: number,
    ex: number, ey: number, ez: number,
    kind: TrussResult["members"][number]["kind"],
    size: number,
    mat: THREE.Material,
  ) => {
    const start = new THREE.Vector3(sx, sy, sz);
    const end = new THREE.Vector3(ex, ey, ez);
    const m = makeChord(start, end, size, mat);
    group.add(m);
    const length = start.distanceTo(end);
    totalSteel += length;
    members.push({ kind, start: { x: sx, y: sy, z: sz }, end: { x: ex, y: ey, z: ez }, length });
  };

  // Top chord: two pitched segments meeting at midspan ridge.
  const halfSpan = p.span / 2;
  // Left top chord: (0,0) → (halfSpan, depth)
  addMember(0, 0, 0, halfSpan, p.depth, 0, "top-chord", p.topChordSize, matTop);
  // Right top chord: (halfSpan, depth) → (span, 0)
  addMember(halfSpan, p.depth, 0, p.span, 0, 0, "top-chord", p.topChordSize, matTop);
  // Ridge marker (vertical peak) — purely for visual emphasis.
  addMember(halfSpan, p.depth, 0, halfSpan, p.depth + 0.05, 0, "ridge", p.webSize, matWeb);

  // Bottom chord: full span.
  addMember(0, 0, 0, p.span, 0, 0, "bottom-chord", p.bottomChordSize, matBot);

  // Web members depending on type.
  for (let i = 1; i < panels; i++) {
    const x = i * panelLen;
    // Top chord elevation at this x.
    const topY = x <= halfSpan ? (x / halfSpan) * p.depth : ((p.span - x) / halfSpan) * p.depth;

    // Always add vertical (Pratt/Howe) — Warren skips verticals.
    if (p.type === "pratt" || p.type === "howe") {
      addMember(x, 0, 0, x, topY, 0, "web-vertical", p.webSize, matWeb);
    }

    // Diagonals.
    if (i < panels) {
      const nx = (i + 1) * panelLen;
      const nTopY = nx <= halfSpan ? (nx / halfSpan) * p.depth : ((p.span - nx) / halfSpan) * p.depth;
      if (p.type === "pratt") {
        // Pratt: diagonals point toward ridge (away from center).
        if (i < panels / 2) {
          addMember(x, 0, 0, nx, nTopY, 0, "web-diagonal", p.webSize, matWeb);
        } else if (i > panels / 2) {
          addMember(nx, 0, 0, x, nTopY, 0, "web-diagonal", p.webSize, matWeb);
        }
      } else if (p.type === "howe") {
        // Howe: diagonals point away from ridge (toward supports).
        if (i < panels / 2) {
          addMember(x, topY, 0, nx, 0, 0, "web-diagonal", p.webSize, matWeb);
        } else if (i > panels / 2) {
          addMember(nx, topY, 0, x, 0, 0, "web-diagonal", p.webSize, matWeb);
        }
      } else if (p.type === "warren") {
        // Warren: zig-zag diagonals, no verticals.
        if (i % 2 === 1) {
          addMember(x, 0, 0, nx, nTopY, 0, "web-diagonal", p.webSize, matWeb);
        }
      } else if (p.type === "fink") {
        // Fink: symmetric V's from supports to ridge.
        if (i === 1 || i === panels - 1) {
          if (i === 1) addMember(0, 0, 0, x, topY, 0, "web-diagonal", p.webSize, matWeb);
          if (i === panels - 1) addMember(p.span, 0, 0, x, topY, 0, "web-diagonal", p.webSize, matWeb);
        }
      }
    }
  }

  return {
    panelLength: panelLen,
    members,
    totalSteelLength: totalSteel,
    object: group,
  };
}
