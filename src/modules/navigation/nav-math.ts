/**
 * Pure navigation math for the ViewCube / Home menu. No DOM, no three.js: plain [x,y,z] tuples,
 * so every rule here is unit-tested (tests/nav-math.test.cjs).
 *
 * World convention of the app: Y is up. The *orientation map* says which world directions are the
 * Front and Top faces (defaults: Front = +Z, Top = +Y). Right = Top x Front. All 26 ViewCube targets
 * (6 faces, 12 edges, 8 corners) are cells (x, y, z) in {-1,0,1}^3 over the (Right, Top, Front) basis.
 */

export type V3 = [number, number, number];
export type Quat = [number, number, number, number]; // x, y, z, w

const EPS = 1e-9;

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
export const isFiniteV3 = (a: unknown): a is V3 => Array.isArray(a) && a.length === 3 && a.every((n) => typeof n === "number" && Number.isFinite(n));

/** Unit vector, or `fallback` for zero / non-finite input (never NaN). */
export function norm(a: V3, fallback: V3 = [0, 1, 0]): V3 {
  const l = len(a);
  return l > EPS && Number.isFinite(l) ? [a[0] / l, a[1] / l, a[2] / l] : [...fallback] as V3;
}

/** Rodrigues rotation of `v` about unit `axis` by `angle` (radians). */
export function rotateVec(v: V3, axis: V3, angle: number): V3 {
  const k = norm(axis), c = Math.cos(angle), s = Math.sin(angle);
  return add(add(mul(v, c), mul(cross(k, v), s)), mul(k, dot(k, v) * (1 - c)));
}

/* ───────────────────────── orientation map ───────────────────────── */

export interface OrientationMap { front: V3; top: V3 }
export const DEFAULT_ORIENTATION: OrientationMap = { front: [0, 0, 1], top: [0, 1, 0] };
export const cloneOrientation = (o: OrientationMap): OrientationMap => ({ front: [...o.front] as V3, top: [...o.top] as V3 });

/** Axis least aligned with `v` (used to build a perpendicular when two directions coincide). */
function leastAligned(v: V3): V3 {
  const a = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
  return a[0] <= a[1] && a[0] <= a[2] ? [1, 0, 0] : a[1] <= a[2] ? [0, 1, 0] : [0, 0, 1];
}

/** Make front/top unit and perpendicular. Garbage in -> the default map out. */
export function normalizeOrientation(o: unknown): OrientationMap {
  const r = o as Partial<OrientationMap> | null;
  if (!r || !isFiniteV3(r.front) || !isFiniteV3(r.top) || len(r.front) < 1e-6) return cloneOrientation(DEFAULT_ORIENTATION);
  const f = norm(r.front);
  let t = sub(r.top, mul(f, dot(r.top, f)));
  if (len(t) < 1e-6) t = sub(leastAligned(f), mul(f, dot(leastAligned(f), f)));
  return { front: f, top: norm(t) };
}

export interface Basis { right: V3; top: V3; front: V3 }
export function basisOf(o: OrientationMap): Basis {
  const m = normalizeOrientation(o);
  return { right: norm(cross(m.top, m.front)), top: m.top, front: m.front };
}

export function isDefaultOrientation(o: OrientationMap): boolean {
  const m = normalizeOrientation(o);
  return len(sub(m.front, DEFAULT_ORIENTATION.front)) < 1e-6 && len(sub(m.top, DEFAULT_ORIENTATION.top)) < 1e-6;
}

/** "Set current view as Front": the direction from target to camera becomes Front; Top is kept as close as possible. */
export function setFrontFromView(o: OrientationMap, dirToCamera: V3): OrientationMap {
  const f = norm(dirToCamera, o.front);
  return normalizeOrientation({ front: f, top: o.top });
}

/** "Set current view as Top": the direction from target to camera becomes Top; Front is kept as close as possible. */
export function setTopFromView(o: OrientationMap, dirToCamera: V3): OrientationMap {
  const t = norm(dirToCamera, o.top);
  // Front must stay perpendicular to the new Top.
  let f = sub(o.front, mul(t, dot(o.front, t)));
  if (len(f) < 1e-6) f = sub(leastAligned(t), mul(t, dot(leastAligned(t), t)));
  const front = norm(f);
  return { front, top: t };
}

/* ───────────────────────── cube cells ───────────────────────── */

export type Axis = -1 | 0 | 1;
/** (x: Right, y: Top, z: Front). */
export type Cell = [Axis, Axis, Axis];
export type CellKind = "face" | "edge" | "corner";

export const cellKind = (c: Cell): CellKind | null => {
  const n = Math.abs(c[0]) + Math.abs(c[1]) + Math.abs(c[2]);
  return n === 1 ? "face" : n === 2 ? "edge" : n === 3 ? "corner" : null;
};

export const ALL_CELLS: Cell[] = (() => {
  const out: Cell[] = [];
  for (const x of [-1, 0, 1] as Axis[]) for (const y of [-1, 0, 1] as Axis[]) for (const z of [-1, 0, 1] as Axis[]) if (x || y || z) out.push([x, y, z]);
  return out;
})();

export const FACE_CELLS = { front: [0, 0, 1], back: [0, 0, -1], top: [0, 1, 0], bottom: [0, -1, 0], right: [1, 0, 0], left: [-1, 0, 0] } as const satisfies Record<string, Cell>;
export type FaceName = keyof typeof FACE_CELLS;

export function cellName(c: Cell): string {
  const parts: string[] = [];
  if (c[1] === 1) parts.push("Top"); else if (c[1] === -1) parts.push("Bottom");
  if (c[2] === 1) parts.push("Front"); else if (c[2] === -1) parts.push("Back");
  if (c[0] === 1) parts.push("Right"); else if (c[0] === -1) parts.push("Left");
  return parts.join(" ");
}

/** Direction from the target towards the camera for a cell (unit), or null for the centre. */
export function cellDirection(o: OrientationMap, c: Cell): V3 | null {
  if (!c[0] && !c[1] && !c[2]) return null;
  const b = basisOf(o);
  return norm(add(add(mul(b.right, c[0]), mul(b.top, c[1])), mul(b.front, c[2])));
}

/**
 * Camera up vector for a cell. Side faces / edges / corners keep Top up (rolled out of the
 * viewing axis). The two poles use Front so the picture never spins when switching Top <-> Bottom.
 */
export function cellUp(o: OrientationMap, c: Cell): V3 {
  const b = basisOf(o), d = cellDirection(o, c) ?? b.front;
  const poleTop = Math.abs(c[0]) + Math.abs(c[2]) === 0;
  if (poleTop) return c[1] >= 0 ? mul(b.front, -1) : [...b.front] as V3;
  const up = sub(b.top, mul(d, dot(b.top, d)));
  return len(up) > 1e-4 ? norm(up) : mul(b.front, -1);
}

export interface ViewSpec { dir: V3; up: V3 }
export function viewForCell(o: OrientationMap, c: Cell): ViewSpec | null {
  const d = cellDirection(o, c);
  return d ? { dir: d, up: cellUp(o, c) } : null;
}

/** The cell (face only) the camera is currently closest to. */
export function nearestFaceCell(o: OrientationMap, dirToCamera: V3): Cell {
  const b = basisOf(o), d = norm(dirToCamera);
  const cands: Array<[Cell, number]> = [
    [[1, 0, 0], dot(d, b.right)], [[-1, 0, 0], -dot(d, b.right)],
    [[0, 1, 0], dot(d, b.top)], [[0, -1, 0], -dot(d, b.top)],
    [[0, 0, 1], dot(d, b.front)], [[0, 0, -1], -dot(d, b.front)],
  ];
  return cands.sort((p, q) => q[1] - p[1])[0][0];
}

export function angleBetween(a: V3, b: V3): number {
  return Math.acos(Math.max(-1, Math.min(1, dot(norm(a), norm(b))))) * 180 / Math.PI;
}

/** True when the camera sits on a face axis (within `tolDeg`): used by "Perspective with Ortho Faces". */
export function alignedFaceCell(o: OrientationMap, dirToCamera: V3, tolDeg = 0.75): Cell | null {
  const c = nearestFaceCell(o, dirToCamera);
  const d = cellDirection(o, c)!;
  return angleBetween(d, dirToCamera) <= tolDeg ? c : null;
}

/* ───────────────────────── orbit / roll steps ───────────────────────── */

/**
 * Orbit the camera position around `target`.
 * dAz: radians around the up axis (positive = camera moves counter-clockwise seen from above).
 * dEl: radians; positive moves the camera UP. The polar angle is clamped so the view never flips.
 */
export function orbitStep(pos: V3, target: V3, up: V3, dAz: number, dEl: number, poleClampDeg = 1): V3 {
  const U = norm(up);
  let off = sub(pos, target);
  const r = len(off);
  if (r < EPS) return pos;
  off = rotateVec(off, U, dAz);
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(off, U) / r)));
  const lo = poleClampDeg * Math.PI / 180, hi = Math.PI - lo;
  const next = Math.max(lo, Math.min(hi, theta - dEl));
  const axis = cross(U, off);
  if (len(axis) > 1e-9) off = rotateVec(off, axis, next - theta);
  return add(target, off);
}

/** Roll the camera about its viewing axis (CW/CCW arrows): returns the new up vector. */
export function rollStep(up: V3, dirToCamera: V3, angle: number): V3 {
  return norm(rotateVec(up, dirToCamera, angle));
}

/* ───────────────────────── framing & projection ───────────────────────── */

export interface Box { min: V3; max: V3 }
export function validBox(b: unknown): b is Box {
  const r = b as Box | null;
  if (!r || !isFiniteV3(r.min) || !isFiniteV3(r.max)) return false;
  return r.max[0] >= r.min[0] && r.max[1] >= r.min[1] && r.max[2] >= r.min[2];
}
export function boxSphere(b: Box): { center: V3; radius: number } {
  const center: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  return { center, radius: Math.max(len(sub(b.max, b.min)) / 2, 1e-3) };
}

/** Camera distance that fits a sphere of `radius` in a perspective view (vertical fov in degrees). */
export function perspectiveFitDistance(radius: number, fovDeg: number, aspect: number, margin = 1.15): number {
  const v = Math.max(0.05, Math.min(3.0, (fovDeg * Math.PI) / 180));
  const a = Number.isFinite(aspect) && aspect > 0.05 ? aspect : 1;
  const h = 2 * Math.atan(Math.tan(v / 2) * a);
  return (Math.max(radius, 1e-3) * margin) / Math.sin(Math.min(v, h) / 2);
}

/** Visible world height an orthographic view needs to fit a sphere. */
export function orthoFitHeight(radius: number, aspect: number, margin = 1.15): number {
  const a = Number.isFinite(aspect) && aspect > 0.05 ? aspect : 1;
  return (2 * Math.max(radius, 1e-3) * margin) / Math.min(1, a);
}

/** Visible world height at distance `dist` for a perspective camera. */
export const visibleHeightAt = (dist: number, fovDeg: number): number => 2 * Math.max(dist, 1e-6) * Math.tan((fovDeg * Math.PI) / 360);
/** Distance that shows `height` world units for a perspective camera. */
export const distanceForHeight = (height: number, fovDeg: number): number => Math.max(height, 1e-6) / (2 * Math.tan((fovDeg * Math.PI) / 360));

/* ───────────────────────── home state ───────────────────────── */

export type ProjectionName = "perspective" | "orthographic";
export type ProjectionMode = "orthographic" | "perspective" | "perspective-ortho-faces";

export interface HomeView {
  pos: V3; target: V3; up: V3;
  projection: ProjectionName;
  fov?: number;
  /** Orthographic zoom factor (frustum is rebuilt on apply). */
  zoom?: number;
  /** Visible world height at the target at save time: lets the view survive a projection or window change. */
  height?: number;
}

/** Validate untrusted (persisted) home data. Returns a clean copy or null. */
export function validateHome(raw: unknown): HomeView | null {
  const r = raw as Partial<HomeView> | null;
  if (!r || typeof r !== "object") return null;
  if (!isFiniteV3(r.pos) || !isFiniteV3(r.target) || !isFiniteV3(r.up)) return null;
  if (len(sub(r.pos, r.target)) < 1e-6 || len(r.up) < 1e-6) return null;
  const projection: ProjectionName = r.projection === "orthographic" ? "orthographic" : "perspective";
  const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
  return {
    pos: [...r.pos] as V3, target: [...r.target] as V3, up: norm(r.up),
    projection, fov: num(r.fov, 1, 170), zoom: num(r.zoom, 1e-4, 1e6), height: num(r.height, 1e-6, 1e9),
  };
}

export interface NavPersist { home: HomeView | null; orientation: OrientationMap; mode: ProjectionMode }
export const DEFAULT_PERSIST = (): NavPersist => ({ home: null, orientation: cloneOrientation(DEFAULT_ORIENTATION), mode: "perspective" });

/** Parse the persisted JSON. Anything invalid falls back to defaults field by field. */
export function parsePersist(json: string | null | undefined): NavPersist {
  const out = DEFAULT_PERSIST();
  if (!json) return out;
  try {
    const j = JSON.parse(json);
    out.home = validateHome(j?.home);
    out.orientation = normalizeOrientation(j?.orientation);
    if (j?.mode === "orthographic" || j?.mode === "perspective" || j?.mode === "perspective-ortho-faces") out.mode = j.mode;
  } catch { /* corrupted: defaults */ }
  return out;
}
export const serializePersist = (p: NavPersist): string => JSON.stringify({ v: 1, home: p.home, orientation: normalizeOrientation(p.orientation), mode: p.mode });

/* ───────────────────────── cube rendering ───────────────────────── */

export function quatRotate(q: Quat, v: V3): V3 {
  const [x, y, z, w] = q;
  const t = mul(cross([x, y, z], v), 2);
  return add(add(v, mul(t, w)), cross([x, y, z], t));
}
export const quatConj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]];

/** Camera quaternion for a camera at `dirToCamera` from the target, with the given up vector. */
export function viewQuaternion(dirToCamera: V3, up: V3): Quat {
  const back = norm(dirToCamera);
  let right = cross(up, back);
  if (len(right) < 1e-6) right = cross(leastAligned(back), back);
  right = norm(right);
  const u = cross(back, right);
  // rotation matrix columns: right, u, back
  const m00 = right[0], m10 = right[1], m20 = right[2], m01 = u[0], m11 = u[1], m21 = u[2], m02 = back[0], m12 = back[1], m22 = back[2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]; }
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

/**
 * CSS `matrix3d` (column-major) that draws the cube as the camera sees it. Local cube axes:
 * +x = Right, +y = DOWN (= -Top), +z = Front (towards the viewer in the front view).
 */
export function cubeMatrix3d(camQuat: Quat, o: OrientationMap): number[] {
  const b = basisOf(o), inv = quatConj(camQuat);
  const css = (w: V3): V3 => { const c = quatRotate(inv, w); return [c[0], -c[1], c[2]]; };
  const ex = css(b.right), ey = css(mul(b.top, -1)), ez = css(b.front);
  return [ex[0], ex[1], ex[2], 0, ey[0], ey[1], ey[2], 0, ez[0], ez[1], ez[2], 0, 0, 0, 0, 1];
}

/** World direction of project north / east for a true-north angle (degrees clockwise, north = +Z, east = +X). */
export function northVectors(trueNorthDeg: number): { north: V3; east: V3 } {
  const a = (Number.isFinite(trueNorthDeg) ? trueNorthDeg : 0) * Math.PI / 180;
  return { north: [Math.sin(a), 0, Math.cos(a)], east: [Math.cos(a), 0, -Math.sin(a)] };
}

/** Position of a compass letter on the cube's ground plane (unit circle in the Right/Front plane). */
export function compassLocal(o: OrientationMap, worldDir: V3): { x: number; z: number } {
  const b = basisOf(o), h = sub(worldDir, mul(b.top, dot(worldDir, b.top)));
  const d = len(h) > 1e-6 ? norm(h) : [0, 0, 0] as V3;
  return { x: dot(d, b.right), z: dot(d, b.front) };
}

/* ───────────────────────── transitions ───────────────────────── */

export const quatDot = (a: Quat, b: Quat): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

/** Spherical interpolation along the SHORT arc (no flips between opposite faces). */
export function quatSlerp(a: Quat, b0: Quat, t: number): Quat {
  let b: Quat = b0, d = quatDot(a, b);
  if (d < 0) { b = [-b[0], -b[1], -b[2], -b[3]]; d = -d; }
  let s0: number, s1: number;
  if (d > 0.9995) { s0 = 1 - t; s1 = t; }
  else { const th = Math.acos(Math.min(1, d)), sn = Math.sin(th); s0 = Math.sin((1 - t) * th) / sn; s1 = Math.sin(t * th) / sn; }
  const q: Quat = [a[0] * s0 + b[0] * s1, a[1] * s0 + b[1] * s1, a[2] * s0 + b[2] * s1, a[3] * s0 + b[3] * s1];
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}

export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export interface Pose { target: V3; quat: Quat; dist: number; zoom?: number }

/** Pose of a camera that sits `dist` away from `target` towards `dirToCamera`, rolled so `up` is up. */
export function poseFromView(target: V3, dirToCamera: V3, up: V3, dist: number, zoom?: number): Pose {
  return { target: [...target] as V3, quat: viewQuaternion(dirToCamera, up), dist: Math.max(dist, 1e-6), zoom };
}

export function poseDirUp(p: Pose): { dir: V3; up: V3 } {
  return { dir: norm(quatRotate(p.quat, [0, 0, 1])), up: norm(quatRotate(p.quat, [0, 1, 0])) };
}
export function poseCameraPosition(p: Pose): V3 {
  return add(p.target, mul(poseDirUp(p).dir, p.dist));
}

/** Interpolated pose at t in [0,1]: target lerps, orientation slerps, distance and zoom interpolate in log space. */
export function poseAt(a: Pose, b: Pose, t: number): Pose {
  const k = Math.max(0, Math.min(1, t));
  const lerp = (x: number, y: number) => x + (y - x) * k;
  const logLerp = (x: number, y: number) => Math.exp(lerp(Math.log(Math.max(x, 1e-9)), Math.log(Math.max(y, 1e-9))));
  return {
    target: [lerp(a.target[0], b.target[0]), lerp(a.target[1], b.target[1]), lerp(a.target[2], b.target[2])],
    quat: quatSlerp(a.quat, b.quat, k),
    dist: logLerp(a.dist, b.dist),
    zoom: a.zoom != null && b.zoom != null ? logLerp(a.zoom, b.zoom) : b.zoom ?? a.zoom,
  };
}

/** Direction (from target to camera) and orthogonal up from raw camera data. Degenerate input -> world up. */
export function dirUpFromCamera(pos: V3, target: V3, up: V3): { dir: V3; up: V3 } {
  const dir = norm(sub(pos, target), [0, 0, 1]);
  let u = sub(up, mul(dir, dot(up, dir)));
  if (len(u) < 1e-6) u = sub([0, 1, 0], mul(dir, dot([0, 1, 0], dir)));
  if (len(u) < 1e-6) u = sub([0, 0, -1], mul(dir, dot([0, 0, -1], dir)));
  return { dir, up: norm(u) };
}

/* ───────────────────────── scene / default home ───────────────────────── */

export interface Sphere { center: V3; radius: number }

/** Is a saved Home still meaningful for the scene that is loaded now? */
export function sceneSimilar(saved: Sphere, now: Sphere): boolean {
  if (!(saved.radius > 0) || !(now.radius > 0)) return false;
  const ratio = now.radius / saved.radius;
  if (ratio < 0.2 || ratio > 5) return false;
  return len(sub(saved.center, now.center)) <= 0.6 * Math.max(saved.radius, now.radius);
}

export const DEFAULT_HOME_DIR: V3 = [1.2, 0.7, 1.2];

/** Home for a scene sphere: the classic 3/4 view that frames everything. */
export function defaultHomePose(s: Sphere, projection: ProjectionName, fovDeg: number, aspect: number, margin = 1.15): HomeView {
  const dir = norm(DEFAULT_HOME_DIR);
  const r = Math.max(s.radius, 0.5);
  const height = orthoFitHeight(r, aspect, margin);
  const dist = projection === "orthographic" ? Math.max(r * 1.5, 5) : perspectiveFitDistance(r, fovDeg, aspect, margin);
  return { pos: add(s.center, mul(dir, dist)), target: [...s.center] as V3, up: [0, 1, 0], projection, fov: fovDeg, height };
}
