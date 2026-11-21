/**
 * Native SPLINE / ELLIPSE preservation.
 *
 * The viewer draws, picks and snaps every curve through its tessellated points, so SPLINE and
 * ELLIPSE entities are still carried as LWPOLYLINE geometry. Previously the true definition (control
 * points, knots, weights, fit points, ellipse axes and parameter range) was thrown away at read time
 * and a saved drawing contained only a polyline approximation.
 *
 * `native` keeps that definition next to the tessellation, and `nativeSig` is a signature of the
 * tessellated points at the moment `native` was last known to match them. Every consumer calls
 * `nativeIfValid` first: if any command changed the points without carrying the native data along,
 * the signature no longer matches, the native definition is treated as stale and the entity is written
 * as the (current) polyline. Stale native data can therefore never overwrite the user's edits.
 *
 * Affine edits (move, rotate, uniform scale, mirror) are carried exactly via `carryNative`.
 */
import type { DxfPoint } from "./dxf-types";

export interface NativeSpline {
  kind: "SPLINE";
  degree: number;
  closed: boolean;
  controlPoints: DxfPoint[];
  knots: number[];
  /** Present only for rational (NURBS) splines; one weight per control point. */
  weights?: number[];
  fitPoints?: DxfPoint[];
}

export interface NativeEllipse {
  kind: "ELLIPSE";
  center: DxfPoint;
  /** Major-axis end point relative to the centre (DXF group 11). */
  majorAxis: DxfPoint;
  /** Minor/major length ratio (group 40). */
  ratio: number;
  /** Start / end parameter in radians (groups 41 / 42). */
  startParam: number;
  endParam: number;
}

export type NativeCurve = NativeSpline | NativeEllipse;

type Pt = { x: number; y: number; z?: number };
const TWO_PI = Math.PI * 2;

/** FNV-1a over the coordinates rounded to 1e-7, plus the point count. */
export function pointsSignature(points: ReadonlyArray<Pt>): string {
  let h = 0x811c9dc5;
  const mix = (v: number) => {
    const s = (Math.round(v * 1e7) / 1e7).toString();
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    h ^= 0x2c; h = Math.imul(h, 0x01000193) >>> 0;
  };
  for (const p of points) { mix(p.x); mix(p.y); }
  return `${points.length}:${h.toString(16)}`;
}

interface HasNative { points: Pt[]; native?: NativeCurve; nativeSig?: string }

/** Stores the native definition on a polyline entity and signs the current tessellation. */
export function attachNative<T extends HasNative>(ent: T, native: NativeCurve): T {
  ent.native = native;
  ent.nativeSig = pointsSignature(ent.points);
  return ent;
}

/** The native definition, or null when absent or stale (points were edited without carrying it). */
export function nativeIfValid(ent: HasNative): NativeCurve | null {
  if (!ent.native || !ent.nativeSig) return null;
  return ent.nativeSig === pointsSignature(ent.points) ? ent.native : null;
}

export interface AffineOps {
  pt: (p: Pt) => Pt;
  /** Maps a direction vector (no translation). */
  vec: (v: Pt) => Pt;
  /** True for mirror-like maps that reverse orientation. */
  reflect?: boolean;
}

const normAngle = (a: number): number => { const r = a % TWO_PI; return r < 0 ? r + TWO_PI : r; };

/** Applies an affine map to a native definition (exact for similarity transforms). */
export function transformNative(n: NativeCurve, ops: AffineOps): NativeCurve {
  const P = (p: Pt): DxfPoint => { const q = ops.pt(p); return { x: q.x, y: q.y, z: p.z ?? 0 }; };
  if (n.kind === "SPLINE") {
    return {
      ...n,
      controlPoints: n.controlPoints.map(P),
      fitPoints: n.fitPoints?.map(P),
      knots: [...n.knots],
      weights: n.weights ? [...n.weights] : undefined,
    };
  }
  const v = ops.vec(n.majorAxis);
  let t0 = n.startParam, t1 = n.endParam;
  if (ops.reflect) {
    const full = Math.abs(t1 - t0 - TWO_PI) < 1e-9 || Math.abs(t1 - t0) < 1e-12;
    if (!full) { const a = -t1, b = -t0; t0 = normAngle(a); t1 = normAngle(b); if (t1 <= t0) t1 += TWO_PI; }
  }
  return { ...n, center: P(n.center), majorAxis: { x: v.x, y: v.y, z: n.majorAxis.z ?? 0 }, startParam: t0, endParam: t1 };
}

/**
 * Re-binds native data after a transform: when `src` had valid native data it is transformed and
 * signed against `out.points`; otherwise any stale data is dropped from `out`.
 */
export function carryNative<S extends HasNative, O extends HasNative>(src: S, out: O, ops: AffineOps): O {
  const n = nativeIfValid(src);
  if (!n) { delete out.native; delete out.nativeSig; return out; }
  out.native = transformNative(n, ops);
  out.nativeSig = pointsSignature(out.points);
  return out;
}

/** DXF group-code text for a SPLINE body (after the common entity head). */
export function splineDxfBody(n: NativeSpline, pair: (c: number, v: string | number) => string): string {
  const rational = !!n.weights && n.weights.length === n.controlPoints.length;
  let flags = 8; // planar
  if (n.closed) flags |= 1;
  if (rational) flags |= 4;
  let s = pair(100, "AcDbSpline");
  s += pair(210, 0) + pair(220, 0) + pair(230, 1);
  s += pair(70, flags) + pair(71, n.degree);
  s += pair(72, n.knots.length) + pair(73, n.controlPoints.length) + pair(74, n.fitPoints?.length ?? 0);
  s += pair(42, 1e-7) + pair(43, 1e-7) + pair(44, 1e-10);
  for (const k of n.knots) s += pair(40, k);
  if (rational) for (const w of n.weights!) s += pair(41, w);
  for (const p of n.controlPoints) s += pair(10, p.x) + pair(20, p.y) + pair(30, p.z ?? 0);
  for (const p of n.fitPoints ?? []) s += pair(11, p.x) + pair(21, p.y) + pair(31, p.z ?? 0);
  return s;
}

/** DXF group-code text for an ELLIPSE body (after the common entity head). */
export function ellipseDxfBody(n: NativeEllipse, pair: (c: number, v: string | number) => string): string {
  let s = pair(100, "AcDbEllipse");
  s += pair(10, n.center.x) + pair(20, n.center.y) + pair(30, n.center.z ?? 0);
  s += pair(11, n.majorAxis.x) + pair(21, n.majorAxis.y) + pair(31, n.majorAxis.z ?? 0);
  s += pair(210, 0) + pair(220, 0) + pair(230, 1);
  s += pair(40, n.ratio) + pair(41, n.startParam) + pair(42, n.endParam);
  return s;
}
