/**
 * Family sketch core: turns a 2-D outline drawn in the family sketch editor into a parametric extrusion
 * (profile polygon + depth parameter + elevation parameter) and adds it to a FamilyDefinition. Pure: no DOM, no THREE.
 *
 * Sketch plane: the PLAN. The outline is drawn as seen from above (x right, y up the screen = +Z / north in the app) and
 * extruded upwards from an elevation. In family space that is an `extrusion` rotated +90° about X (profile XY -> plan XZ,
 * extrusion axis Z -> vertical) and translated so the solid's base sits at the elevation.
 * Shapes: a free polygon (optionally with polygon holes), or a PARAMETRIC rectangle / circle / arc-sector whose width, length, radius or
 * angles are family parameters (so it resizes). Limits (docs/FAMILY-SKETCH.md): one outer outline per extrusion, straight edges only
 * except arc sectors (a free circle is a polygon), no splines, no sweep/revolve, holes are fixed polygons inside a polygon outline.
 */
import type { FamilyCategory, FamilyDefinition, FamilyGeometrySpec, FamilyParameter } from "./types";
import { solveConstraints, validateConstraints, type Constraint, type ConstraintResult } from "./constraint-graph";

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

/** Sweep of an arc in degrees, from start to end (counter-clockwise from +X). */
export const arcSweepDeg = (startDeg: number, endDeg: number): number => endDeg - startDeg;

/** Area of a circular sector: ½·r²·sweep (sweep in degrees). */
export const arcSectorArea = (r: number, sweepDeg: number): number =>
  0.5 * r * r * (sweepDeg * Math.PI / 180);

/** Points along a circular arc, start to end inclusive (degrees, CCW from +X). */
export function arcPoints(cx: number, cy: number, r: number, startDeg: number, endDeg: number, segments = 48): Pt[] {
  const sweep = arcSweepDeg(startDeg, endDeg);
  const n = Math.max(2, Math.min(256, Math.floor(segments)));
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (startDeg + (sweep * i) / n) * Math.PI / 180;
    out.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]);
  }
  return out;
}

/** Closed outline of a circular sector: the arc plus the centre point (pie slice). */
export function sectorPoints(cx: number, cy: number, r: number, startDeg: number, endDeg: number, segments = 48): Pt[] {
  return [...arcPoints(cx, cy, r, startDeg, endDeg, segments), [cx, cy] as Pt];
}

export interface ArcCheck { ok: boolean; errors: string[]; area: number; sweepDeg: number; points: Pt[] }

/** Validate an arc sector and return its closed outline (arc + centre). */
export function validateArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number, segments = 48): ArcCheck {
  const errors: string[] = [];
  if (![cx, cy, r, startDeg, endDeg].every(Number.isFinite)) errors.push("Arc centre, radius and angles must be numbers.");
  if (Number.isFinite(r) && !(r > 0)) errors.push("Arc radius must be positive.");
  const sweep = arcSweepDeg(startDeg, endDeg);
  if (Number.isFinite(sweep) && !(sweep > 0 && sweep <= 360)) errors.push("Arc sweep must be between 0 and 360 degrees (end angle after start angle).");
  const points = errors.length === 0 ? sectorPoints(cx, cy, r, startDeg, endDeg, segments) : [];
  return { ok: errors.length === 0, errors, area: errors.length === 0 ? arcSectorArea(r, sweep) : 0, sweepDeg: sweep, points };
}

/* ───────────── reference planes ───────────── */

/**
 * A reference plane is a named datum line in the sketch plane that
 * sketch constraints can be solved against: `axis: "x"` is the vertical
 * line x = offset, `axis: "y"` the horizontal line y = offset. Its
 * offset is exposed as a parameter named `plane_<id>` so a
 * `symmetric` constraint can mirror two sketch dimensions about it.
 */
export interface ReferencePlane {
  /** [A-Za-z_][A-Za-z0-9_]* — also the parameter suffix. */
  id: string;
  name: string;
  axis: "x" | "y";
  /** Offset in metres from the sketch origin along the plane's axis. */
  offset: number;
}

export const referencePlaneParamName = (plane: ReferencePlane): string => `plane_${plane.id}`;

/** Validation errors for one reference plane (empty = valid). */
export function validateReferencePlane(plane: unknown, existingIds: Set<string> = new Set()): string[] {
  const errors: string[] = [];
  if (!plane || typeof plane !== "object") return ["Reference plane must be an object."];
  const p = plane as ReferencePlane;
  if (typeof p.id !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.id)) errors.push("Reference plane id must be a valid parameter name.");
  else if (existingIds.has(p.id)) errors.push(`Duplicate reference plane id "${p.id}".`);
  if (typeof p.name !== "string" || !p.name.trim()) errors.push("Reference plane needs a name.");
  if (p.axis !== "x" && p.axis !== "y") errors.push("Reference plane axis must be \"x\" or \"y\".");
  if (typeof p.offset !== "number" || !Number.isFinite(p.offset)) errors.push("Reference plane offset must be a number.");
  return errors;
}

/** Parameter values for a set of reference planes (`plane_<id>` -> offset). */
export function referencePlaneValues(planes: ReferencePlane[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of planes) out[referencePlaneParamName(p)] = p.offset;
  return out;
}

/** Mirror a sketch point across a reference plane. */
export function mirrorPointAcrossPlane(p: Pt, plane: ReferencePlane): Pt {
  return plane.axis === "x" ? [2 * plane.offset - p[0], p[1]] : [p[0], 2 * plane.offset - p[1]];
}

/** Perpendicular distance from a sketch point to a reference plane. */
export function distanceToPlane(p: Pt, plane: ReferencePlane): number {
  return Math.abs(plane.axis === "x" ? p[0] - plane.offset : p[1] - plane.offset);
}

/* ───────────── sketch constraints (dimension-driven) ───────────── */

/**
 * A set of dimension constraints over a family's sketch parameters,
 * solved by the family constraint graph (`constraint-graph.ts`).
 * Constraints are NOT stored on the family definition — they travel
 * with the sketch operation and are solved at build time, with the
 * solved values passed as overrides to `buildParametricFamily`
 * (see `ParametricBuildOptions.constraints`, which the engine solves
 * after formula evaluation). Reference planes in the set contribute
 * their `plane_<id>` offset parameters to the solve.
 */
export interface SketchConstraintSet {
  constraints: Constraint[];
  referencePlanes?: ReferencePlane[];
}

/** Validation errors for a constraint set against a family (empty = valid). */
export function validateSketchConstraints(family: FamilyDefinition, set: SketchConstraintSet): string[] {
  const errors: string[] = [];
  const names = new Set(family.parameters.map((p) => p.name));
  const ids = new Set<string>();
  for (const plane of set.referencePlanes ?? []) {
    for (const e of validateReferencePlane(plane, ids)) errors.push(e);
    ids.add((plane as ReferencePlane).id);
    names.add(referencePlaneParamName(plane as ReferencePlane));
  }
  errors.push(...validateConstraints(set.constraints, names));
  return errors;
}

/**
 * Solve a sketch constraint set over a family's parameter defaults
 * (plus `seed` overrides). Returns the constraint-graph result:
 * solved values, errors (including cycle diagnostics), applied count
 * and iteration count. The caller passes `result.values` as overrides
 * when building, so a driven sketch dimension follows its driver.
 */
export function solveSketchDimensions(
  family: FamilyDefinition,
  set: SketchConstraintSet,
  seed: Record<string, any> = {},
): ConstraintResult {
  const values: Record<string, any> = {};
  for (const p of family.parameters) values[p.name] = p.default;
  Object.assign(values, referencePlaneValues(set.referencePlanes ?? []), seed);
  return solveConstraints(values, set.constraints);
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

/** Ray-casting point-in-polygon (points exactly on an edge count as outside, which is what we want for holes). */
export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const MAX_HOLES = 20;

/** Check holes against an outer outline: each valid, strictly inside the outer, and not touching/overlapping each other. */
export function validateHoles(outer: Pt[], holes: Pt[][]): { ok: boolean; errors: string[]; holes: Pt[][] } {
  const errors: string[] = [];
  if (holes.length > MAX_HOLES) errors.push(`At most ${MAX_HOLES} holes are allowed.`);
  const clean: Pt[][] = [];
  holes.slice(0, MAX_HOLES).forEach((h, i) => {
    const v = validateSketch(h);
    if (!v.ok) { errors.push(`Hole ${i + 1}: ${v.errors[0]}`); return; }
    if (!v.points.every((p) => pointInPolygon(p, outer))) { errors.push(`Hole ${i + 1} is not fully inside the outline.`); return; }
    const n = outer.length;
    for (let a = 0; a < v.points.length; a++) for (let b = 0; b < n; b++) {
      if (segmentsCross(v.points[a], v.points[(a + 1) % v.points.length], outer[b], outer[(b + 1) % n])) { errors.push(`Hole ${i + 1} crosses the outline.`); return; }
    }
    clean.push(v.points);
  });
  for (let i = 0; i < clean.length; i++) for (let j = i + 1; j < clean.length; j++) {
    const A = clean[i], B = clean[j];
    const cross = A.some((p, a) => B.some((_, b) => segmentsCross(p, A[(a + 1) % A.length], B[b], B[(b + 1) % B.length])));
    if (cross || A.some((p) => pointInPolygon(p, B)) || B.some((p) => pointInPolygon(p, A))) errors.push(`Holes ${i + 1} and ${j + 1} overlap.`);
  }
  return { ok: errors.length === 0, errors, holes: clean };
}

export type ShapeInput =
  | { kind: "polygon"; points: Pt[]; holes?: Pt[][] }
  | { kind: "rect"; cx: number; cy: number; width: number; length: number }
  | { kind: "circle"; cx: number; cy: number; radius: number }
  | { kind: "arc"; cx: number; cy: number; radius: number; startAngle: number; endAngle: number };

const poly = (points: Pt[]) => ({ kind: "polygon" as const, points: points.map((p) => [round6(p[0]), round6(p[1])] as Pt) });

/** The extrusion spec for a free polygon outline (with optional holes), referencing depth/elevation parameters by name. */
export function extrusionSpec(points: Pt[], depthParam: string, elevParam: string, holes: Pt[][] = []): FamilyGeometrySpec {
  const spec: any = {
    kind: "extrusion",
    profile: poly(points),
    depth: { ref: depthParam },
    transform: {
      rotate: [{ const: Math.PI / 2 }, { const: 0 }, { const: 0 }],
      translate: [{ const: 0 }, { expr: `${elevParam} + ${depthParam} / 2` }, { const: 0 }],
    },
  };
  if (holes.length) spec.holes = holes.map(poly);
  return spec as FamilyGeometrySpec;
}
const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

export type SketchResult = { ok: true; family: FamilyDefinition; depthParam: string; elevationParam: string; area: number; sizeParams: string[] } | { ok: false; errors: string[] };

const lengthParam = (name: string, label: string, value: number, min = 0.001): FamilyParameter =>
  ({ name, label, type: "length", scope: "type", default: value, editable: true, min, step: 0.05, unit: "m", group: "Sketch" });

const angleParam = (name: string, label: string, value: number): FamilyParameter =>
  ({ name, label, type: "angle", scope: "type", default: value, editable: true, step: 5, unit: "deg", group: "Sketch" });

/** Add a shape to a family as a new extrusion (the original definition is not mutated). */
export function addShapeToFamily(def: FamilyDefinition, shape: ShapeInput, opts: SketchOptions): SketchResult {
  if (!(opts.depth > 0) || !Number.isFinite(opts.depth) || opts.depth > 1000) return { ok: false, errors: ["Depth must be a positive length of at most 1000 m."] };
  const elev = opts.elevation ?? 0;
  if (!Number.isFinite(elev)) return { ok: false, errors: ["Elevation must be a number."] };
  const names = new Set(def.parameters.map((p) => p.name));
  const take = (base: string) => { const n = uniqueName(names, base); names.add(n); return n; };
  const label = opts.label ? ` (${opts.label})` : "";
  const depthParam = take("sketchDepth"), elevParam = take("sketchElevation");
  const params: FamilyParameter[] = [lengthParam(depthParam, "Sketch depth" + label, opts.depth), lengthParam(elevParam, "Sketch elevation" + label, elev, -1000)];
  params[1].min = undefined;
  let part: FamilyGeometrySpec; let area = 0; const sizeParams: string[] = [];
  const lift = { expr: `${elevParam} + ${depthParam} / 2` };
  const rot = [{ const: Math.PI / 2 }, { const: 0 }, { const: 0 }];
  if (shape.kind === "polygon") {
    const v = validateSketch(shape.points);
    if (!v.ok) return { ok: false, errors: v.errors };
    const h = validateHoles(v.points, shape.holes ?? []);
    if (!h.ok) return { ok: false, errors: h.errors };
    area = v.area - h.holes.reduce((s, x) => s + Math.abs(signedArea(x)), 0);
    part = extrusionSpec(v.points, depthParam, elevParam, h.holes);
  } else if (shape.kind === "rect") {
    if (!(shape.width > 0 && shape.length > 0) || !Number.isFinite(shape.width + shape.length + shape.cx + shape.cy)) return { ok: false, errors: ["Width and length must be positive."] };
    const w = take("sketchWidth"), l = take("sketchLength");
    params.push(lengthParam(w, "Sketch width" + label, round6(shape.width)), lengthParam(l, "Sketch length" + label, round6(shape.length)));
    sizeParams.push(w, l); area = shape.width * shape.length;
    part = { kind: "extrusion", profile: { kind: "rect", w: { ref: w }, h: { ref: l } }, depth: { ref: depthParam }, transform: { rotate: rot as any, translate: [{ const: round6(shape.cx) }, lift, { const: round6(shape.cy) }] } } as FamilyGeometrySpec;
  } else if (shape.kind === "circle") {
    if (!(shape.radius > 0) || !Number.isFinite(shape.radius + shape.cx + shape.cy)) return { ok: false, errors: ["Radius must be positive."] };
    const r = take("sketchRadius");
    params.push(lengthParam(r, "Sketch radius" + label, round6(shape.radius)));
    sizeParams.push(r); area = Math.PI * shape.radius * shape.radius;
    part = { kind: "extrusion", profile: { kind: "circle", r: { ref: r }, segments: 64 }, depth: { ref: depthParam }, transform: { rotate: rot as any, translate: [{ const: round6(shape.cx) }, lift, { const: round6(shape.cy) }] } } as FamilyGeometrySpec;
  } else {
    // Arc sector: radius + start/end angles are all sketch parameters,
    // so the sector reshapes when any of them changes.
    const v = validateArc(shape.cx, shape.cy, shape.radius, shape.startAngle, shape.endAngle);
    if (!v.ok) return { ok: false, errors: v.errors };
    const r = take("sketchRadius"), a0 = take("sketchStartAngle"), a1 = take("sketchEndAngle");
    params.push(lengthParam(r, "Sketch radius" + label, round6(shape.radius)));
    params.push(angleParam(a0, "Sketch start angle" + label, round6(shape.startAngle)));
    params.push(angleParam(a1, "Sketch end angle" + label, round6(shape.endAngle)));
    sizeParams.push(r, a0, a1); area = v.area;
    part = { kind: "extrusion", profile: { kind: "arc", r: { ref: r }, startAngle: { ref: a0 }, endAngle: { ref: a1 }, segments: 64 }, depth: { ref: depthParam }, transform: { rotate: rot as any, translate: [{ const: round6(shape.cx) }, lift, { const: round6(shape.cy) }] } } as FamilyGeometrySpec;
  }
  const geometry: FamilyGeometrySpec = def.geometry && !(def.geometry.kind === "custom" && !def.geometry.builder)
    ? (def.geometry.kind === "composed" ? { kind: "composed", parts: [...def.geometry.parts, part] } : { kind: "composed", parts: [def.geometry, part] })
    : part;
  return { ok: true, family: { ...def, parameters: [...def.parameters, ...params], geometry, builtIn: false }, depthParam, elevationParam: elevParam, area, sizeParams };
}

/** Add a free polygon outline (the original, simple entry point). */
export function addSketchToFamily(def: FamilyDefinition, points: Pt[], opts: SketchOptions & { holes?: Pt[][] }): SketchResult {
  return addShapeToFamily(def, { kind: "polygon", points, holes: opts.holes }, opts);
}

export interface NewFamilyInput { id: string; name: string; category?: FamilyCategory; ifcEntity?: string; points?: Pt[]; holes?: Pt[][]; shape?: ShapeInput; depth: number; elevation?: number }

/** A brand-new user family whose whole geometry is the sketched extrusion, with one default type. */
export function newFamilyFromSketch(input: NewFamilyInput): SketchResult {
  if (!input.name.trim()) return { ok: false, errors: ["Give the family a name."] };
  const shape: ShapeInput = input.shape ?? { kind: "polygon", points: input.points ?? [], holes: input.holes };
  const empty: FamilyDefinition = {
    id: input.id, name: input.name.trim().slice(0, 100), category: input.category ?? "generic", ifcEntity: input.ifcEntity ?? "IfcBuildingElementProxy",
    schemaVersion: 1, parameters: [], geometry: { kind: "custom", builder: "" }, types: [], builtIn: false,
  };
  const r = addShapeToFamily(empty, shape, { depth: input.depth, elevation: input.elevation });
  if (!r.ok) return r;
  r.family.types = [{ id: `${input.id}.default`, name: "Default", values: {} }];
  return r;
}
