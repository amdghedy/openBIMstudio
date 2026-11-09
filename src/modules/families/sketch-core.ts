/**
 * Family sketch core: turns a 2-D outline drawn in the family sketch editor into a parametric extrusion
 * (profile polygon + depth parameter + elevation parameter) and adds it to a FamilyDefinition. Pure: no DOM, no THREE.
 *
 * Sketch plane: the PLAN. The outline is drawn as seen from above (x right, y up the screen = +Z / north in the app) and
 * extruded upwards from an elevation. In family space that is an `extrusion` rotated +90° about X (profile XY -> plan XZ,
 * extrusion axis Z -> vertical) and translated so the solid's base sits at the elevation.
 * Limits (documented in docs/FAMILY-SKETCH.md): single outline per extrusion, straight edges only (circles are polygons),
 * no holes or voids yet, no arcs/splines, no sweep/revolve from the sketch.
 */
import type { FamilyCategory, FamilyDefinition, FamilyGeometrySpec, FamilyParameter } from "./types";

export type Pt = [number, number];

export const MAX_POINTS = 500;
const EPS = 1e-9;

export const snap = (v: number, grid: number): number => (grid > 0 ? Math.round(v / grid) * grid : v);
export const snapPt = (p: Pt, grid: number): Pt => [snap(p[0], grid), snap(p[1], grid)];

/** Drop consecutive duplicates and a repeated closing point. */
export function cleanPoints(points: Pt[], eps = 1e-6): Pt[] {
  const out: Pt[] = [];
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const q = out[out.length - 1];
    if (q && Math.abs(q[0] - p[0]) < eps && Math.abs(q[1] - p[1]) < eps) continue;
    out.push([p[0], p[1]]);
  }
  while (out.length > 1 && Math.abs(out[0][0] - out[out.length - 1][0]) < eps && Math.abs(out[0][1] - out[out.length - 1][1]) < eps) out.pop();
  return out;
}

/** Signed area (positive = counter-clockwise). */
export function signedArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; a += x1 * y2 - x2 * y1; }
  return a / 2;
}

const cross = (a: Pt, b: Pt, c: Pt) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
  return ((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS));
}

/** True if any two non-adjacent edges of the closed outline properly cross each other. */
export function selfIntersects(pts: Pt[]): boolean {
  const n = pts.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (j === i + 1 || (i === 0 && j === n - 1)) continue;
    if (segmentsCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return true;
  }
  return false;
}

export interface SketchCheck { ok: boolean; errors: string[]; area: number; bbox: { minX: number; minY: number; maxX: number; maxY: number } | null; points: Pt[] }

/** Validate an outline and return it cleaned and counter-clockwise. */
export function validateSketch(points: Pt[]): SketchCheck {
  const errors: string[] = [];
  const pts = cleanPoints(points);
  if (pts.length > MAX_POINTS) errors.push(`At most ${MAX_POINTS} points are allowed (this outline has ${pts.length}).`);
  if (pts.length < 3) errors.push("An outline needs at least 3 distinct points.");
  let area = 0, bbox: SketchCheck["bbox"] = null;
  if (pts.length >= 3) {
    area = signedArea(pts);
    bbox = { minX: Math.min(...pts.map((p) => p[0])), minY: Math.min(...pts.map((p) => p[1])), maxX: Math.max(...pts.map((p) => p[0])), maxY: Math.max(...pts.map((p) => p[1])) };
    if (pts.length <= MAX_POINTS && selfIntersects(pts)) errors.push("The outline crosses itself. Edges may touch at corners but not cross.");
    else if (Math.abs(area) < 1e-8) errors.push("The outline has no area (all points are on one line).");
  }
  const ccw = area < 0 ? [...pts].reverse() : pts;
  return { ok: errors.length === 0, errors, area: Math.abs(area), bbox, points: ccw };
}

export const rectPoints = (x0: number, y0: number, x1: number, y1: number): Pt[] => {
  const a = Math.min(x0, x1), b = Math.max(x0, x1), c = Math.min(y0, y1), d = Math.max(y0, y1);
  return [[a, c], [b, c], [b, d], [a, d]];
};
export function circlePoints(cx: number, cy: number, r: number, segments = 48): Pt[] {
  const n = Math.max(8, Math.min(256, Math.floor(segments)));
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2; out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  return out;
}

/* ───────────── family building ───────────── */

function uniqueName(existing: Set<string>, base: string): string {
  if (!existing.has(base)) return base;
  let i = 2; while (existing.has(base + i)) i++;
  return base + i;
}

export interface SketchOptions {
  /** Depth (extrusion height) in metres. */
  depth: number;
  /** Elevation of the base above the family origin, in metres. */
  elevation?: number;
  /** Label for the generated parameters. */
  label?: string;
}

/** The extrusion spec for an outline, referencing parameters by name. */
export function extrusionSpec(points: Pt[], depthParam: string, elevParam: string): FamilyGeometrySpec {
  return {
    kind: "extrusion",
    profile: { kind: "polygon", points: points.map((p) => [round6(p[0]), round6(p[1])] as Pt) },
    depth: { ref: depthParam },
    transform: {
      rotate: [{ const: Math.PI / 2 }, { const: 0 }, { const: 0 }],
      translate: [{ const: 0 }, { expr: `${elevParam} + ${depthParam} / 2` }, { const: 0 }],
    },
  } as FamilyGeometrySpec;
}
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export type SketchResult = { ok: true; family: FamilyDefinition; depthParam: string; elevationParam: string; area: number } | { ok: false; errors: string[] };

/** Add the outline to a family as a new extrusion (the original definition is not mutated). */
export function addSketchToFamily(def: FamilyDefinition, points: Pt[], opts: SketchOptions): SketchResult {
  const v = validateSketch(points);
  if (!v.ok) return { ok: false, errors: v.errors };
  if (!(opts.depth > 0) || !Number.isFinite(opts.depth) || opts.depth > 1000) return { ok: false, errors: ["Depth must be a positive length of at most 1000 m."] };
  const elev = opts.elevation ?? 0;
  if (!Number.isFinite(elev)) return { ok: false, errors: ["Elevation must be a number."] };
  const names = new Set(def.parameters.map((p) => p.name));
  const depthParam = uniqueName(names, "sketchDepth"); names.add(depthParam);
  const elevParam = uniqueName(names, "sketchElevation");
  const label = opts.label ? ` (${opts.label})` : "";
  const params: FamilyParameter[] = [
    { name: depthParam, label: "Sketch depth" + label, type: "length", scope: "type", default: opts.depth, editable: true, min: 0.001, step: 0.05, unit: "m", group: "Sketch" },
    { name: elevParam, label: "Sketch elevation" + label, type: "length", scope: "type", default: elev, editable: true, step: 0.05, unit: "m", group: "Sketch" },
  ];
  const part = extrusionSpec(v.points, depthParam, elevParam);
  const geometry: FamilyGeometrySpec = def.geometry && !(def.geometry.kind === "custom" && !def.geometry.builder)
    ? (def.geometry.kind === "composed" ? { kind: "composed", parts: [...def.geometry.parts, part] } : { kind: "composed", parts: [def.geometry, part] })
    : part;
  return { ok: true, family: { ...def, parameters: [...def.parameters, ...params], geometry, builtIn: false }, depthParam, elevationParam: elevParam, area: v.area };
}

export interface NewFamilyInput { id: string; name: string; category?: FamilyCategory; ifcEntity?: string; points: Pt[]; depth: number; elevation?: number }

/** A brand-new user family whose whole geometry is the sketched extrusion, with one default type. */
export function newFamilyFromSketch(input: NewFamilyInput): SketchResult {
  if (!input.name.trim()) return { ok: false, errors: ["Give the family a name."] };
  const empty: FamilyDefinition = {
    id: input.id, name: input.name.trim().slice(0, 100), category: input.category ?? "generic", ifcEntity: input.ifcEntity ?? "IfcBuildingElementProxy",
    schemaVersion: 1, parameters: [], geometry: { kind: "composed", parts: [] }, types: [], builtIn: false,
  };
  const r = addSketchToFamily({ ...empty, geometry: { kind: "custom", builder: "" } }, input.points, { depth: input.depth, elevation: input.elevation });
  if (!r.ok) return r;
  r.family.types = [{ id: `${input.id}.default`, name: "Default", values: {} }];
  return r;
}
