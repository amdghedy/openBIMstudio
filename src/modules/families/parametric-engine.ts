/**
 * Open BIM Studio - Parametric Engine (BIM-competitive core)
 *
 * Orchestrates:
 *   1. Formula evaluation (topo-sorted, units-aware, conditional)
 *   2. Dimensional + geometric constraint solving
 *   3. Nested family instances & array expansion
 *   4. Geometry build (extrude / sweep / revolve / loft / void / conditional)
 *   5. Change propagation (type - instance - nested children)
 *
 * Public API is pure / side-effect free except for registered custom builders.
 * Authoring, UI, and store sit on top of this module.
 */

import * as THREE from "three";
import { CSG } from "three-csg-ts";
import type {
  FamilyDefinition,
  FamilyGeometrySpec,
  FamilyParameter,
  FamilyType,
  NumberRef,
  ProfileSpec,
  TransformSpec,
} from "./types";
import {
  evaluateParameters,
  type FormulaResult,
} from "./formula-engine";
import {
  buildParametricGeometry,
  resolveNumber,
  resolveTransform,
  registerCustomBuilder,
  getCustomBuilder,
  tintObject,
} from "./parametric-geometry";
import {
  solveConstraints,
  type Constraint,
  type ConstraintResult,
} from "./constraint-graph";
import {
  expandArrays,
  type ArraySpec,
  type ExpandedPart,
} from "./array-expander";
import {
  resolveNested,
  type NestedFamilyRef,
} from "./nested-families";

/* ---------------------------------------------------------------------------
   Extended geometry kinds (additive - existing kinds still work)
   --------------------------------------------------------------------------- */

export type ExtendedGeometrySpec =
  | FamilyGeometrySpec
  | {
      kind: "sweep";
      profile: ProfileSpec;
      path: [NumberRef, NumberRef, NumberRef][];
      closed?: boolean;
      transform?: TransformSpec;
      /** Parameter name controlling visibility (truthy - show). */
      visibleWhen?: string;
    }
  | {
      kind: "revolve";
      profile: ProfileSpec;
      axis: "x" | "y" | "z";
      angle: NumberRef;
      segments?: number;
      transform?: TransformSpec;
      visibleWhen?: string;
    }
  | {
      kind: "loft";
      profiles: ProfileSpec[];
      segments?: number;
      transform?: TransformSpec;
      visibleWhen?: string;
    }
  | {
      kind: "void";
      /** Positive solid that will be subtracted from siblings in a composed group. */
      solid: FamilyGeometrySpec;
      transform?: TransformSpec;
      visibleWhen?: string;
    }
  | {
      kind: "conditional";
      /** Parameter name (boolean / number). Truthy - thenSpec, else - elseSpec. */
      when: string;
      then: FamilyGeometrySpec;
      else?: FamilyGeometrySpec;
    }
  | {
      kind: "nested";
      familyId: string;
      typeId?: string;
      paramMap?: Record<string, NumberRef | string>;
      transform?: TransformSpec;
      visibleWhen?: string;
    }
  | {
      kind: "array";
      of: FamilyGeometrySpec;
      count: NumberRef;
      /** Translation step between instances [dx, dy, dz]. */
      step: [NumberRef, NumberRef, NumberRef];
      /** Optional rotation step [rx, ry, rz] radians. */
      rotateStep?: [NumberRef, NumberRef, NumberRef];
      visibleWhen?: string;
    };

export interface ParametricBuildOptions {
  /** Extra instance overrides (already merged by caller if desired). */
  overrides?: Record<string, any>;
  /** Project / shared parameter values (lowest priority after defaults). */
  sharedParams?: Record<string, any>;
  /** Constraints to solve after formula evaluation. */
  constraints?: Constraint[];
  /** Lookup for nested families (id - definition). */
  familyLookup?: (id: string) => FamilyDefinition | null;
  /** Lookup nested type values. */
  typeLookup?: (familyId: string, typeId: string) => FamilyType | null;
  /** Material / colour override applied to all meshes. */
  colour?: string | THREE.Color;
  /** When true, skip void CSG (faster preview). */
  preview?: boolean;
  /** Collected build warnings (void CSG failures, etc.). Internal:
   *  `buildParametricFamily` passes its own array in. */
  warnings?: string[];
}

export interface ParametricBuildResult {
  object: THREE.Object3D | null;
  params: Record<string, any>;
  formula: FormulaResult;
  constraints: ConstraintResult | null;
  errors: string[];
  warnings: string[];
}

/* ---------------------------------------------------------------------------
   Parameter pipeline
   --------------------------------------------------------------------------- */

/**
 * Full parameter resolution pipeline matching BIM's order of operations:
 *   defaults - shared/project - type - instance overrides - formulas - constraints
 */
export function resolveParametricValues(
  family: FamilyDefinition,
  type: FamilyType | null,
  options: ParametricBuildOptions = {},
): { values: Record<string, any>; formula: FormulaResult; constraints: ConstraintResult | null; errors: string[] } {
  const errors: string[] = [];
  const values: Record<string, any> = {};

  // 1. Family defaults
  for (const p of family.parameters) {
    values[p.name] = p.default;
  }

  // 2. Shared / project parameters (only keys that exist on the family)
  if (options.sharedParams) {
    for (const p of family.parameters) {
      if (p.name in options.sharedParams) {
        values[p.name] = options.sharedParams[p.name];
      }
    }
  }

  // 3. Type overrides
  if (type) {
    for (const [k, v] of Object.entries(type.values)) {
      values[k] = v;
    }
  }

  // 4. Instance overrides
  if (options.overrides) {
    for (const [k, v] of Object.entries(options.overrides)) {
      values[k] = v;
    }
  }

  // 5. Clamp numeric parameters to min/max before formulas
  for (const p of family.parameters) {
    if (typeof values[p.name] === "number") {
      let n = values[p.name] as number;
      if (p.min != null && n < p.min) n = p.min;
      if (p.max != null && n > p.max) n = p.max;
      if (p.type === "integer") n = Math.round(n);
      values[p.name] = n;
    }
  }

  // 6. Formula evaluation (topo-sorted, cycle-safe)
  const formula = evaluateParameters(family.parameters, values);
  Object.assign(values, formula.values);
  for (const e of formula.errors) {
    errors.push(`formula:${e.parameter}: ${e.message}`);
  }

  // 7. Constraint solve (equality / ratio / sum / distance)
  let constraints: ConstraintResult | null = null;
  if (options.constraints && options.constraints.length) {
    constraints = solveConstraints(values, options.constraints);
    Object.assign(values, constraints.values);
    for (const e of constraints.errors) {
      errors.push(`constraint:${e}`);
    }
  }

  // 8. Final clamp after constraints
  for (const p of family.parameters) {
    if (typeof values[p.name] === "number") {
      let n = values[p.name] as number;
      if (p.min != null && n < p.min) n = p.min;
      if (p.max != null && n > p.max) n = p.max;
      values[p.name] = n;
    }
  }

  return { values, formula, constraints, errors };
}

/* ---------------------------------------------------------------------------
   Visibility helper
   --------------------------------------------------------------------------- */

function isVisible(spec: { visibleWhen?: string }, params: Record<string, any>): boolean {
  if (!spec.visibleWhen) return true;
  const v = params[spec.visibleWhen];
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0 && v !== "0" && v.toLowerCase() !== "false";
  return !!v;
}

/* ---------------------------------------------------------------------------
   Extended geometry builders
   --------------------------------------------------------------------------- */

function buildSweep(
  profile: ProfileSpec,
  path: [NumberRef, NumberRef, NumberRef][],
  closed: boolean,
  params: Record<string, any>,
): THREE.Object3D | null {
  // Manual sweep (no ExtrudeGeometry Frenet frames): the profile is
  // carried along the polyline path with parallel-transport frames, so
  // its orientation is deterministic — profile +Y stays as close to
  // world +Y as the path allows (profile +X follows by right-handedness)
  // — and sharp corners are mitered instead of bulging past the
  // waypoint the way a Catmull-Rom curve does. Stations sit on the
  // waypoints; each interior station's ring lies in the plane
  // perpendicular to the average (miter) tangent, so adjacent prisms
  // share exactly one face: no overlap, no gap, no overshoot.
  if (path.length < 2) return null;
  const pts = path.map(([x, y, z]) =>
    new THREE.Vector3(resolveNumber(x, params), resolveNumber(y, params), resolveNumber(z, params)),
  );
  // Drop consecutive duplicates (a zero-length segment has no tangent).
  const clean: THREE.Vector3[] = [];
  for (const p of pts) {
    const last = clean[clean.length - 1];
    if (!last || last.distanceToSquared(p) > 1e-12) clean.push(p);
  }
  if (clean.length < 2) return null;
  const stations = closed && clean[0].distanceToSquared(clean[clean.length - 1]) > 1e-12
    ? [...clean, clean[0].clone()]
    : clean;
  const count = stations.length;
  const wps = closed ? clean : stations;

  // Tangents: end stations use their one segment; interior stations use
  // the miter (average of adjacent segment directions). For a closed
  // path the seam station reuses station 0's tangent.
  const tangents: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const j = closed ? i % wps.length : i;
    if (!closed && j === 0) tangents.push(stations[1].clone().sub(stations[0]).normalize());
    else if (!closed && j === wps.length - 1) tangents.push(stations[count - 1].clone().sub(stations[count - 2]).normalize());
    else {
      const prev = wps[(j - 1 + wps.length) % wps.length];
      const next = wps[(j + 1) % wps.length];
      const a = stations[i].clone().sub(prev).normalize();
      const b = next.clone().sub(stations[i]).normalize();
      const m = a.clone().add(b);
      tangents.push(m.lengthSq() > 1e-12 ? m.normalize() : a);
    }
  }

  // Parallel-transport frames: start from world-up (or world-X when the
  // path starts vertical), then rotate each frame by the shortest arc
  // between consecutive tangents.
  const frames: { n: THREE.Vector3; b: THREE.Vector3 }[] = [];
  {
    const t0 = tangents[0];
    const up = Math.abs(t0.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const b0 = up.clone().sub(t0.clone().multiplyScalar(up.dot(t0))).normalize();
    const n0 = new THREE.Vector3().crossVectors(b0, t0).normalize();
    frames.push({ n: n0, b: b0 });
    for (let i = 1; i < count; i++) {
      const q = new THREE.Quaternion().setFromUnitVectors(tangents[i - 1], tangents[i]);
      const prev = frames[i - 1];
      const n = prev.n.clone().applyQuaternion(q);
      const b = prev.b.clone().applyQuaternion(q);
      // Re-orthogonalise against the new tangent (numerical drift).
      const t = tangents[i];
      b.sub(t.clone().multiplyScalar(b.dot(t))).normalize();
      n.crossVectors(b, t).normalize();
      frames.push({ n, b });
    }
  }

  // Shear the in-plane direction at corners: the ring at a mitered
  // corner is the leg prism's intersection with the miter plane (area
  // profile / cos(half-angle)), NOT the profile rigidly rotated into
  // the plane, which shrinks the corner (a rigid 45-degree ring puts
  // the outer face at 0.354 instead of 0.5 and loses ~2.3 volume on
  // an L-path). The two legs then touch exactly at the miter plane:
  // an L-path of 1x2 profile measures 8 + 8 = 16.
  const dirs: THREE.Vector3[] = [];
  for (let i = 0; i < count; i++) {
    const j = closed ? i % wps.length : i;
    let d = frames[i].n;
    const isCorner = closed || (j > 0 && j < wps.length - 1);
    if (isCorner) {
      const a = stations[i].clone().sub(wps[(j - 1 + wps.length) % wps.length]).normalize();
      const m = tangents[i];
      const nA = new THREE.Vector3().crossVectors(frames[i].b, a).normalize();
      const denom = a.dot(m);
      if (Math.abs(denom) > 1e-9) {
        d = nA.clone().sub(a.clone().multiplyScalar(nA.dot(m) / denom));
      }
    }
    dirs.push(d);
  }
  if (closed) {
    // The seam station must reuse station 0's frame exactly, or the
    // loop does not close.
    dirs[count - 1] = dirs[0];
    frames[count - 1] = frames[0];
  }

  const ring = profileRing(profile, params, 64);
  if (ring.length < 3) return null;
  const ringPts = (i: number): THREE.Vector3[] => {
    const c = stations[i], f = frames[i], d = dirs[i];
    return ring.map((p) => new THREE.Vector3(
      c.x + d.x * p.x + f.b.x * p.y,
      c.y + d.y * p.x + f.b.y * p.y,
      c.z + d.z * p.x + f.b.z * p.y,
    ));
  };

  const positions: number[] = [];
  const pushTri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  const rings = stations.map((_, i) => ringPts(i));
  const m = ring.length;
  const segments = closed ? count : count - 1;
  for (let s = 0; s < segments; s++) {
    const r0 = rings[s], r1 = rings[(s + 1) % count];
    for (let k = 0; k < m; k++) {
      const k1 = (k + 1) % m;
      // Outward-facing quads (profile ring is counter-clockwise).
      pushTri(r0[k], r1[k1], r1[k]);
      pushTri(r0[k], r0[k1], r1[k1]);
    }
  }
  if (!closed) {
    // End caps (fans from the ring centroid).
    for (const [ri, flip] of [[0, true], [count - 1, false]] as const) {
      const r = rings[ri];
      const c = new THREE.Vector3();
      for (const p of r) c.add(p);
      c.multiplyScalar(1 / m);
      for (let k = 0; k < m; k++) {
        const k1 = (k + 1) % m;
        if (flip) pushTri(c, r[k1], r[k]);
        else pushTri(c, r[k], r[k1]);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo);
}

/** Clean ring of outline points for a profile (no duplicate closer, CCW). */
function profileRing(profile: ProfileSpec, params: Record<string, any>, divisions = 64): THREE.Vector2[] {
  const shape = profileToShapeLocal(profile, params);
  const raw = shape.getPoints(divisions);
  const out: THREE.Vector2[] = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.y - p.y) < 1e-9) continue;
    out.push(new THREE.Vector2(p.x, p.y));
  }
  while (out.length > 1) {
    const f = out[0], l = out[out.length - 1];
    if (Math.abs(f.x - l.x) < 1e-9 && Math.abs(f.y - l.y) < 1e-9) out.pop();
    else break;
  }
  return out;
}

/** Resample a closed polyline ring to `count` points, uniform by arc length. */
function resampleRing(points: THREE.Vector2[], count: number): THREE.Vector2[] {
  if (points.length < 3 || count < 3) return points;
  const closed = [...points, points[0]];
  const cum: number[] = [0];
  for (let i = 0; i < closed.length - 1; i++) cum.push(cum[i] + Math.hypot(closed[i + 1].x - closed[i].x, closed[i + 1].y - closed[i].y));
  const total = cum[cum.length - 1];
  if (total <= 0) return points.slice(0, count);
  const out: THREE.Vector2[] = [];
  let seg = 0;
  for (let k = 0; k < count; k++) {
    const d = (k / count) * total;
    while (seg < cum.length - 2 && cum[seg + 1] < d) seg++;
    const span = cum[seg + 1] - cum[seg] || 1;
    const f = (d - cum[seg]) / span;
    const a = closed[seg], b = closed[seg + 1];
    out.push(new THREE.Vector2(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f));
  }
  return out;
}

function buildRevolve(
  profile: ProfileSpec,
  axis: "x" | "y" | "z",
  angle: NumberRef,
  segments: number,
  params: Record<string, any>,
): THREE.Object3D | null {
  const shape = profileToShapeLocal(profile, params);
  const theta = resolveNumber(angle, params);
  if (!Number.isFinite(theta) || Math.abs(theta) < 1e-6) return null;
  const geo = new THREE.LatheGeometry(
    shape.getPoints(64).map((p) => new THREE.Vector2(p.x, p.y)),
    Math.max(3, segments),
    0,
    theta,
  );
  const mesh = new THREE.Mesh(geo);
  if (axis === "x") mesh.rotation.z = Math.PI / 2;
  if (axis === "z") mesh.rotation.x = Math.PI / 2;
  return mesh;
}

function buildLoft(
  profiles: ProfileSpec[],
  segments: number,
  params: Record<string, any>,
): THREE.Object3D | null {
  if (profiles.length < 2) return null;
  // Honest loft: every profile is resampled to the SAME point count,
  // uniform by arc length, so point k of one profile corresponds to
  // point k of the next (the old code paired getPoints() output by
  // index, which gave a rect 132 points and a circle 33 — the first 33
  // rect points cover only a quarter of the outline). Consecutive
  // rings are stitched with quads, so the solid is the exact linear
  // interpolation between profiles instead of a stepped stack that
  // over-estimates it with the slice-start section (a 2x2 -> 1x1
  // taper used to measure 2.719 for a true 2.333).
  // Total height is 1 (z in [0, 1]); place/scale with `transform`.
  const COUNT = 64;
  const rings = profiles.map((p) => resampleRing(profileRing(p, params, 256), COUNT));
  if (rings.some((r) => r.length < 3)) return null;
  // Align the rings' starting points by polar angle about each ring's
  // centroid, so point k of one profile corresponds to point k of the
  // next in the same DIRECTION. Without this the correspondence is
  // whatever getPoints() happened to start with — a rect starts at its
  // (-1,-1) corner while a circle starts at (1,0) — and the loft
  // twists through 135 degrees, collapsing the middle (a rect->circle
  // loft measured 1.53 instead of ~3.5).
  for (const ring of rings) {
    let cx = 0, cy = 0;
    for (const p of ring) { cx += p.x; cy += p.y; }
    cx /= ring.length; cy /= ring.length;
    let best = 0, bestAngle = Infinity;
    ring.forEach((p, k) => {
      let a = Math.atan2(p.y - cy, p.x - cx);
      if (a < 0) a += 2 * Math.PI;
      if (a < bestAngle) { bestAngle = a; best = k; }
    });
    if (best > 0) {
      const rotated = [...ring.slice(best), ...ring.slice(0, best)];
      ring.splice(0, ring.length, ...rotated);
    }
  }
  // Exact linear interpolation: for each profile pair, build rings at
  // t = 0, 1/n, ..., 1 and stitch consecutive rings with quads, so the
  // solid really starts at the first profile and ends at the last
  // (midpoint prisms never reach the end profiles). End caps close the
  // first and last profiles.
  const group = new THREE.Group();
  const n = Math.max(1, segments);
  const span = profiles.length - 1;
  const positions: number[] = [];
  const centroid = new THREE.Vector3();
  const pushTri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  const ringAt = (pair: number, t: number): THREE.Vector3[] =>
    rings[pair].map((p, k) => {
      const q = rings[pair + 1][k];
      return new THREE.Vector3(
        p.x * (1 - t) + q.x * t,
        p.y * (1 - t) + q.y * t,
        (pair + t) / span,
      );
    });
  const cap = (ring: THREE.Vector3[], flip: boolean) => {
    centroid.set(0, 0, 0);
    for (const p of ring) centroid.add(p);
    centroid.divideScalar(ring.length);
    for (let k = 0; k < ring.length; k++) {
      const k1 = (k + 1) % ring.length;
      if (flip) pushTri(centroid, ring[k1], ring[k]);
      else pushTri(centroid, ring[k], ring[k1]);
    }
  };
  for (let i = 0; i < span; i++) {
    const pairRings: THREE.Vector3[][] = [];
    for (let s = 0; s <= n; s++) pairRings.push(ringAt(i, s / n));
    for (let s = 0; s < n; s++) {
      const r0 = pairRings[s], r1 = pairRings[s + 1];
      for (let k = 0; k < COUNT; k++) {
        const k1 = (k + 1) % COUNT;
        pushTri(r0[k], r1[k1], r1[k]);
        pushTri(r0[k], r0[k1], r1[k1]);
      }
    }
    if (i === 0) cap(pairRings[0], true);
    if (i === span - 1) cap(pairRings[n], false);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.computeVertexNormals();
  group.add(new THREE.Mesh(geo));
  return group.children.length ? group : null;
}

function profileToShapeLocal(profile: ProfileSpec, params: Record<string, any>): THREE.Shape {
  const shape = new THREE.Shape();
  if (profile.kind === "rect") {
    const w = resolveNumber(profile.w, params);
    const h = resolveNumber(profile.h, params);
    shape.moveTo(-w / 2, -h / 2);
    shape.lineTo(w / 2, -h / 2);
    shape.lineTo(w / 2, h / 2);
    shape.lineTo(-w / 2, h / 2);
    shape.closePath();
  } else if (profile.kind === "circle") {
    const r = resolveNumber(profile.r, params);
    shape.absarc(0, 0, Math.max(1e-6, r), 0, Math.PI * 2, false);
  } else if (profile.kind === "arc") {
    const r = resolveNumber(profile.r, params);
    const a0 = resolveNumber(profile.startAngle, params) * Math.PI / 180;
    const a1 = resolveNumber(profile.endAngle, params) * Math.PI / 180;
    if (r > 0 && a1 > a0) {
      shape.absarc(0, 0, Math.max(1e-6, r), a0, a1, false);
      if (a1 - a0 < Math.PI * 2 - 1e-9) { shape.lineTo(0, 0); shape.closePath(); }
    }
  } else if (profile.kind === "polygon") {
    const pts = profile.points;
    if (pts.length >= 3) {
      shape.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i][0], pts[i][1]);
      shape.closePath();
    }
  }
  return shape;
}

/**
 * Recursively build geometry from an extended (or classic) spec.
 */

interface CollectedMesh {
  mesh: THREE.Mesh;
  /** Matrix of the mesh relative to the composed group. */
  rel: THREE.Matrix4;
  /** Bounding box in composed-group space (for the overlap pre-check). */
  box: THREE.Box3;
}

function collectMeshes(root: THREE.Object3D, invGroup: THREE.Matrix4): CollectedMesh[] {
  const out: CollectedMesh[] = [];
  root.traverse((o) => {
    if (!(o as THREE.Mesh).isMesh) return;
    const mesh = o as THREE.Mesh;
    const rel = new THREE.Matrix4().copy(invGroup).multiply(mesh.matrixWorld);
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox(); // returns void
    const box = (mesh.geometry.boundingBox as THREE.Box3).clone().applyMatrix4(rel);
    out.push({ mesh, rel, box });
  });
  return out;
}

/**
 * Subtract every void part of a composed group from its solids, with
 * the repo's existing CSG path (`three-csg-ts`, as used for door/window
 * openings in authoring.ts — no new dependency).
 *
 * `CSG.fromMesh` transforms vertices by the mesh's LOCAL matrix, so
 * each mesh is first re-expressed with its matrix relative to the
 * composed group; the result replaces the original mesh as a direct
 * child of the group with that same relative matrix. Meshes whose
 * bounding box does not touch any void are left exactly as built (no
 * CSG round-trip). A void that touches nothing costs nothing. A
 * subtraction that throws keeps the original solid and records a
 * warning — a failed cut must never silently drop the solid.
 */
function subtractVoids(
  group: THREE.Group,
  solids: THREE.Object3D[],
  voids: THREE.Object3D[],
  warnings: string[],
): void {
  group.updateMatrixWorld(true);
  const invGroup = group.matrixWorld.clone().invert();
  const solidMeshes = solids.flatMap((s) => collectMeshes(s, invGroup));
  const voidMeshes = voids.flatMap((v) => collectMeshes(v, invGroup));
  if (!solidMeshes.length || !voidMeshes.length) return;

  for (const s of solidMeshes) {
    let working: THREE.Mesh | null = null;
    for (const v of voidMeshes) {
      if (!s.box.intersectsBox(v.box)) continue;
      try {
        const src = working ?? (() => {
          const tmp = new THREE.Mesh(s.mesh.geometry, s.mesh.material as THREE.Material);
          tmp.matrix.copy(s.rel);
          return tmp;
        })();
        const cutter = new THREE.Mesh(v.mesh.geometry, v.mesh.material as THREE.Material);
        cutter.matrix.copy(v.rel);
        const result = CSG.toMesh(
          CSG.fromMesh(src).subtract(CSG.fromMesh(cutter)),
          s.rel,
          s.mesh.material as THREE.Material,
        );
        result.userData = { ...(s.mesh.userData ?? {}) };
        working = result;
      } catch (err) {
        const msg = `void subtraction failed: ${err instanceof Error ? err.message : String(err)}`;
        warnings.push(msg);
        console.warn("[parametric-engine] " + msg);
      }
    }
    if (working) {
      const parent = s.mesh.parent;
      if (parent) parent.remove(s.mesh);
      group.add(working);
    }
  }
  // Voids are cutters, not geometry: remove them from the output.
  for (const v of voids) group.remove(v);
}

export function buildExtendedGeometry(
  spec: ExtendedGeometrySpec,
  params: Record<string, any>,
  options: ParametricBuildOptions = {},
): THREE.Object3D | null {
  // Visibility gate (shared by most extended kinds)
  if ("visibleWhen" in spec && !isVisible(spec as any, params)) {
    return null;
  }

  switch (spec.kind) {
    case "box":
    case "cylinder":
    case "extrusion":
    case "custom":
      return buildParametricGeometry(spec as FamilyGeometrySpec, params);

    case "composed": {
      // Build parts through the extended builder (the classic builder
      // silently drops void/sweep/loft parts), then subtract the void
      // parts from the solids. Skipped for previews (options.preview),
      // where the old mark-only behaviour is kept for speed.
      const parts = (spec as { parts: ExtendedGeometrySpec[] }).parts ?? [];
      const group = new THREE.Group();
      const solids: THREE.Object3D[] = [];
      const voids: THREE.Object3D[] = [];
      for (const part of parts) {
        const child = buildExtendedGeometry(part, params, options);
        if (!child) continue;
        if ((child as any).userData?.isVoid) voids.push(child);
        else solids.push(child);
        group.add(child);
      }
      if (!group.children.length) return null;
      if (voids.length && !options.preview) {
        subtractVoids(group, solids, voids, options.warnings ?? []);
      }
      return group;
    }

    case "sweep": {
      const mesh = buildSweep(spec.profile, spec.path, !!spec.closed, params);
      if (!mesh) return null;
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(mesh);
      return wrap;
    }

    case "revolve": {
      const mesh = buildRevolve(
        spec.profile,
        spec.axis,
        spec.angle,
        spec.segments ?? 32,
        params,
      );
      if (!mesh) return null;
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(mesh);
      return wrap;
    }

    case "loft": {
      const obj = buildLoft(spec.profiles, spec.segments ?? 4, params);
      if (!obj) return null;
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(obj);
      return wrap;
    }

    case "void": {
      // Mark as void; CSG subtraction is applied at composed-group level.
      const solid = buildParametricGeometry(spec.solid, params);
      if (!solid) return null;
      solid.userData.isVoid = true;
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(solid);
      wrap.userData.isVoid = true;
      return wrap;
    }

    case "conditional": {
      const v = params[spec.when];
      const truthy =
        typeof v === "boolean" ? v :
        typeof v === "number" ? v !== 0 :
        !!v;
      const branch = truthy ? spec.then : spec.else;
      if (!branch) return null;
      return buildExtendedGeometry(branch as ExtendedGeometrySpec, params, options);
    }

    case "nested": {
      if (!options.familyLookup) {
        console.warn("[parametric-engine] nested family requires familyLookup");
        return null;
      }
      const nestedFam = options.familyLookup(spec.familyId);
      if (!nestedFam) return null;
      const nestedType = spec.typeId
        ? options.typeLookup?.(spec.familyId, spec.typeId) ?? null
        : null;

      // Map parent params - nested overrides
      const nestedOverrides: Record<string, any> = {};
      if (spec.paramMap) {
        for (const [childKey, ref] of Object.entries(spec.paramMap)) {
          if (typeof ref === "string") {
            nestedOverrides[childKey] = params[ref];
          } else {
            nestedOverrides[childKey] = resolveNumber(ref, params);
          }
        }
      }

      const nested = buildParametricFamily(nestedFam, nestedType, {
        ...options,
        overrides: nestedOverrides,
      });
      if (!nested.object) return null;
      const wrap = resolveTransform(spec.transform, params);
      wrap.add(nested.object);
      return wrap;
    }

    case "array": {
      const count = Math.max(0, Math.floor(resolveNumber(spec.count, params)));
      if (count === 0) return null;
      const dx = resolveNumber(spec.step[0], params);
      const dy = resolveNumber(spec.step[1], params);
      const dz = resolveNumber(spec.step[2], params);
      const rx = spec.rotateStep ? resolveNumber(spec.rotateStep[0], params) : 0;
      const ry = spec.rotateStep ? resolveNumber(spec.rotateStep[1], params) : 0;
      const rz = spec.rotateStep ? resolveNumber(spec.rotateStep[2], params) : 0;

      const group = new THREE.Group();
      for (let i = 0; i < count; i++) {
        const child = buildExtendedGeometry(spec.of as ExtendedGeometrySpec, params, options);
        if (!child) continue;
        child.position.set(dx * i, dy * i, dz * i);
        if (rx || ry || rz) child.rotation.set(rx * i, ry * i, rz * i);
        group.add(child);
      }
      return group.children.length ? group : null;
    }

    default:
      return null;
  }
}

/* ---------------------------------------------------------------------------
   Public: build a complete parametric family instance
   --------------------------------------------------------------------------- */

export function buildParametricFamily(
  family: FamilyDefinition,
  type: FamilyType | null,
  options: ParametricBuildOptions = {},
): ParametricBuildResult {
  const warnings: string[] = [];
  const { values, formula, constraints, errors } = resolveParametricValues(
    family,
    type,
    options,
  );

  let object: THREE.Object3D | null = null;
  try {
    object = buildExtendedGeometry(
      family.geometry as ExtendedGeometrySpec,
      values,
      { ...options, warnings },
    );
  } catch (err) {
    errors.push(
      `geometry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (object) {
    object.userData.familyId = family.id;
    object.userData.familyTypeId = type?.id ?? null;
    object.userData.familyParams = { ...values };
    object.userData.ifcEntity = family.ifcEntity;
    if (options.colour) tintObject(object, options.colour);
  }

  return {
    object,
    params: values,
    formula,
    constraints,
    errors,
    warnings,
  };
}

/* ---------------------------------------------------------------------------
   Parameter change propagation (type edit - all instances)
   --------------------------------------------------------------------------- */

export interface InstanceParamBinding {
  elementId: string;
  familyId: string;
  typeId: string | null;
  /** Instance-level overrides only (type values live on the type). */
  overrides: Record<string, any>;
}

/**
 * Re-resolve one instance after a type change, with that instance's
 * overrides applied on top of the (new) type values. Pure: the same
 * inputs always produce the same resolved map. This is the single
 * per-instance re-resolution used by `propagateTypeChange` and by the
 * authoring sync path — overrides are never silently dropped here.
 */
export function resolveInstanceAfterTypeChange(
  family: FamilyDefinition,
  type: FamilyType,
  instanceOverrides: Record<string, any> = {},
  options: ParametricBuildOptions = {},
): { values: Record<string, any>; formula: FormulaResult; constraints: ConstraintResult | null; errors: string[] } {
  return resolveParametricValues(family, type, {
    ...options,
    overrides: instanceOverrides,
  });
}

/**
 * Recover the instance overrides an element is carrying, from its stored
 * parameters alone. An override is a stored finite-number value for one
 * of `keys` that differs from what the given type resolves to on its own
 * (or a stored value for a key the type resolution does not produce at
 * all, e.g. placement-level values such as `elevation`, which are
 * per-instance by nature). Values that match the type resolution are
 * inherited, not overrides, and are left out.
 *
 * Pure map diff — it does not touch the scene, the store, or the type.
 * Callers must pass the resolution of the type the element was last
 * synced against; comparing against a *changed* type would misread stale
 * inherited values as overrides.
 */
export function extractInstanceOverrides(
  typeResolvedValues: Record<string, any>,
  storedParams: Record<string, any>,
  keys: readonly string[],
): Record<string, any> {
  const overrides: Record<string, any> = {};
  for (const key of keys) {
    const stored = storedParams[key];
    if (typeof stored !== "number" || !Number.isFinite(stored)) continue;
    const base = typeResolvedValues[key];
    if (base === undefined || stored !== base) overrides[key] = stored;
  }
  return overrides;
}

/**
 * Given a type parameter change, recompute every bound instance's effective
 * parameter map. Does not touch the scene - caller applies geometry rebuild.
 */
export function propagateTypeChange(
  family: FamilyDefinition,
  type: FamilyType,
  instances: InstanceParamBinding[],
  options: ParametricBuildOptions = {},
): Map<string, Record<string, any>> {
  const out = new Map<string, Record<string, any>>();
  for (const inst of instances) {
    if (inst.familyId !== family.id) continue;
    if (inst.typeId !== type.id) continue;
    const { values } = resolveInstanceAfterTypeChange(
      family,
      type,
      inst.overrides,
      options,
    );
    out.set(inst.elementId, values);
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Reporting parameters (read-only, derived, shown in schedules)
   --------------------------------------------------------------------------- */

export function collectReportingValues(
  family: FamilyDefinition,
  values: Record<string, any>,
): Record<string, any> {
  const report: Record<string, any> = {};
  for (const p of family.parameters) {
    // Convention: group === "Reporting" or name starts with "Report_"
    if (p.group === "Reporting" || p.name.startsWith("Report_") || !p.editable) {
      if (p.formula || p.group === "Reporting") {
        report[p.name] = values[p.name];
      }
    }
  }
  return report;
}

/* ---------------------------------------------------------------------------
   Re-exports for a single import path
   --------------------------------------------------------------------------- */

export {
  evaluateParameters,
  buildParametricGeometry,
  resolveNumber,
  resolveTransform,
  registerCustomBuilder,
  getCustomBuilder,
  tintObject,
  solveConstraints,
  expandArrays,
  resolveNested,
};

export type {
  FormulaResult,
  Constraint,
  ConstraintResult,
  ArraySpec,
  ExpandedPart,
  NestedFamilyRef,
};
