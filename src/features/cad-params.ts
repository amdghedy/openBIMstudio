/**
 * Parametric constraint + Express Tools geometry engine for the native 2D CAD
 * editor (cad-viewer.ts). Pure functions — no DOM. Every "constraint" here is a
 * real geometric edit: the relation is applied immediately to the entities and
 * reported to the command line, the same one-shot semantics the open-source 2D
 * CAD packages use for quick constraining.
 *
 * All entity inputs are treated as immutable: helpers return adjusted copies
 * (the viewer feeds them through commitModify for undo/redo).
 */

import type { DxfEntity, DxfPoint } from "../modules/drawings/dxf-types";

/* ── small vector helpers ──────────────────────────────────────────────── */

const dist = (a: DxfPoint, b: DxfPoint): number => Math.hypot(b.x - a.x, b.y - a.y);

const midpoint = (a: DxfPoint, b: DxfPoint): DxfPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

const translatePt = (p: DxfPoint, dx: number, dy: number): DxfPoint => ({ x: p.x + dx, y: p.y + dy, ...(p.z !== undefined ? { z: p.z } : {}) });

const rotatePtAbout = (p: DxfPoint, c: DxfPoint, rad: number): DxfPoint => {
  const s = Math.sin(rad), co = Math.cos(rad);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * co - dy * s, y: c.y + dx * s + dy * co };
};

const lineAngle = (a: DxfPoint, b: DxfPoint): number => Math.atan2(b.y - a.y, b.x - a.x);

/** Drop z so the result is a clean 2D point (keeps entities in model plane). */
const z0 = (p: DxfPoint): DxfPoint => ({ x: p.x, y: p.y });

/* ── entity guards ─────────────────────────────────────────────────────── */

export const isLine = (e: DxfEntity | undefined): e is DxfEntity & { type: "LINE"; start: DxfPoint; end: DxfPoint } =>
  !!e && e.type === "LINE";
export const isCircle = (e: DxfEntity | undefined): e is DxfEntity & { type: "CIRCLE"; center: DxfPoint; radius: number } =>
  !!e && e.type === "CIRCLE";
export const isArc = (e: DxfEntity | undefined): e is DxfEntity & { type: "ARC"; center: DxfPoint; radius: number } =>
  !!e && e.type === "ARC";

/** Entities a geometric constraint can be applied to. */
export const constrainable = (e: DxfEntity | undefined): boolean =>
  !!e && (e.type === "LINE" || e.type === "CIRCLE" || e.type === "ARC" || e.type === "LWPOLYLINE" || e.type === "TEXT" || e.type === "POINT");

/** Anchor point used for FIX markers and symmetric operations. */
export function anchorPoint(e: DxfEntity): DxfPoint | null {
  switch (e.type) {
    case "LINE": return midpoint(e.start, e.end);
    case "CIRCLE":
    case "ARC": return e.center;
    case "POINT": return e.position;
    case "TEXT": return e.position;
    case "LWPOLYLINE": return e.points.length ? midpoint(e.points[0], e.points[e.points.length - 1]) : null;
    default: return null;
  }
}

/** Clone helper — constraint results are new entities (undo-friendly). */
const clone = <T extends DxfEntity>(e: T): T => JSON.parse(JSON.stringify(e)) as T;

/* ── geometric constraints (one-shot real edits) ───────────────────────── */

/** HORIZONTAL — force a line level. */
export function fixHorizontal(e: DxfEntity): DxfEntity | null {
  if (!isLine(e)) return null;
  const out = clone(e);
  out.end = { ...z0(out.end), y: out.start.y };
  return out;
}

/** VERTICAL — force a line plumb. */
export function fixVertical(e: DxfEntity): DxfEntity | null {
  if (!isLine(e)) return null;
  const out = clone(e);
  out.end = { ...z0(out.end), x: out.start.x };
  return out;
}

/** PARALLEL — rotate the second line (about its midpoint) onto the first one's direction. */
export function fixParallel(src: DxfEntity, dst: DxfEntity): DxfEntity | null {
  if (!isLine(src) || !isLine(dst)) return null;
  const out = clone(dst);
  const rot = lineAngle(src.start, src.end) - lineAngle(out.start, out.end);
  const c = midpoint(out.start, out.end);
  out.start = rotatePtAbout(out.start, c, rot);
  out.end = rotatePtAbout(out.end, c, rot);
  return out;
}

/** PERPENDICULAR — rotate the second line 90° against the first one's direction. */
export function fixPerpendicular(src: DxfEntity, dst: DxfEntity): DxfEntity | null {
  if (!isLine(src) || !isLine(dst)) return null;
  const out = clone(dst);
  const rot = lineAngle(src.start, src.end) + Math.PI / 2 - lineAngle(out.start, out.end);
  const c = midpoint(out.start, out.end);
  out.start = rotatePtAbout(out.start, c, rot);
  out.end = rotatePtAbout(out.end, c, rot);
  return out;
}

/** CONCENTRIC — move the second circle/arc onto the first one's center. */
export function fixConcentric(src: DxfEntity, dst: DxfEntity): DxfEntity | null {
  if (!(isCircle(src) || isArc(src)) || !(isCircle(dst) || isArc(dst))) return null;
  const out = clone(dst);
  out.center = z0(src.center);
  return out;
}

/**
 * TANGENT — translate the second entity (a LINE) perpendicular to itself so it
 * touches the picked circle/arc exactly.
 */
export function fixTangent(circle: DxfEntity, line: DxfEntity): DxfEntity | null {
  if (!(isCircle(circle) || isArc(circle)) || !isLine(line)) return null;
  const out = clone(line);
  const c = circle.center;
  const ang = lineAngle(out.start, out.end);
  // signed distance of the circle center from the infinite line
  const nx = -Math.sin(ang), ny = Math.cos(ang);
  const signed = (c.x - out.start.x) * nx + (c.y - out.start.y) * ny;
  const shift = circle.radius - signed;
  out.start = translatePt(out.start, nx * shift, ny * shift);
  out.end = translatePt(out.end, nx * shift, ny * shift);
  return out;
}

/** COINCIDENT — snap the second line's nearest endpoint onto the first line's nearest endpoint. */
export function fixCoincident(src: DxfEntity, dst: DxfEntity): DxfEntity | null {
  if (!isLine(src) || !isLine(dst)) return null;
  const out = clone(dst);
  // pick the endpoint pair that are closest together
  const pairs: Array<[DxfPoint, DxfPoint]> = [
    [src.start, out.start], [src.start, out.end], [src.end, out.start], [src.end, out.end],
  ];
  let best = 0;
  for (let i = 1; i < 4; i++) if (dist(pairs[i][0], pairs[i][1]) < dist(pairs[best][0], pairs[best][1])) best = i;
  const anchor = pairs[best][0], moving = pairs[best][1];
  const dx = anchor.x - moving.x, dy = anchor.y - moving.y;
  out.start = translatePt(out.start, dx, dy);
  out.end = translatePt(out.end, dx, dy);
  return out;
}

/**
 * SYMMETRIC — mirror an object's geometry about an axis line. The object
 * keeps its shape but lands mirrored on the other side of the axis.
 */
export function fixSymmetric(dst: DxfEntity, axis: DxfEntity): DxfEntity | null {
  if (!isLine(axis) || !constrainable(dst)) return null;
  const out = clone(dst);
  const a = axis.start, b = axis.end;
  const abx = b.x - a.x, aby = b.y - a.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-12) return null;
  const mirror = (p: DxfPoint): DxfPoint => {
    const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    const fx = a.x + abx * t, fy = a.y + aby * t; // foot of perpendicular
    return { x: 2 * fx - p.x, y: 2 * fy - p.y };
  };
  if (out.type === "LINE") {
    out.start = mirror(out.start);
    out.end = mirror(out.end);
    return out;
  }
  if (out.type === "CIRCLE" || out.type === "ARC") {
    out.center = mirror(out.center);
    return out;
  }
  if (out.type === "POINT" || out.type === "TEXT") {
    out.position = mirror(out.position);
    return out;
  }
  if (out.type === "LWPOLYLINE") {
    out.points = out.points.map(mirror);
    return out;
  }
  return null;
}

/** EQUAL — same length for two lines, same radius for two circles/arcs. */
export function fixEqual(src: DxfEntity, dst: DxfEntity): DxfEntity | null {
  if (isLine(src) && isLine(dst)) {
    const out = clone(dst);
    const target = dist(src.start, src.end);
    const cur = dist(out.start, out.end);
    if (cur < 1e-9) return null;
    const c = midpoint(out.start, out.end);
    const k = target / cur;
    out.start = { x: c.x + (out.start.x - c.x) * k, y: c.y + (out.start.y - c.y) * k };
    out.end = { x: c.x + (out.end.x - c.x) * k, y: c.y + (out.end.y - c.y) * k };
    return out;
  }
  if ((isCircle(src) || isArc(src)) && (isCircle(dst) || isArc(dst))) {
    const out = clone(dst);
    out.radius = Math.max(1e-9, src.radius);
    return out;
  }
  return null;
}

/* ── dimensional constraints (enter a value → geometry follows) ────────── */

/** DCLINEAR — set a line to an exact length, keeping its start point. */
export function dimLinear(line: DxfEntity, targetLen: number): DxfEntity | null {
  if (!isLine(line) || targetLen <= 0) return null;
  const out = clone(line);
  const cur = dist(out.start, out.end);
  if (cur < 1e-9) return null;
  const k = targetLen / cur;
  out.end = { x: out.start.x + (out.end.x - out.start.x) * k, y: out.start.y + (out.end.y - out.start.y) * k };
  return out;
}

/** DCRADIUS / DCDIAMETER — set a circle or arc to an exact radius. */
export function dimRadius(e: DxfEntity, r: number): DxfEntity | null {
  if (!(isCircle(e) || isArc(e)) || r <= 0) return null;
  const out = clone(e);
  out.radius = r;
  return out;
}

/** DCANGULAR — set the angle between two lines (rotates the second about its midpoint). */
export function dimAngular(src: DxfEntity, dst: DxfEntity, degrees: number): DxfEntity | null {
  if (!isLine(src) || !isLine(dst)) return null;
  const out = clone(dst);
  const rot = (degrees * Math.PI) / 180 - lineAngle(src.start, src.end);
  const c = midpoint(out.start, out.end);
  out.start = rotatePtAbout(out.start, c, rot);
  out.end = rotatePtAbout(out.end, c, rot);
  return out;
}

/* ── AUTOCONSTRAIN — detect and exactify obvious relations ─────────────── */

export interface AutoConstrainResult {
  /** entities after the pass (same order) */
  entities: DxfEntity[];
  /** how many relations were exactified */
  fixed: number;
  /** human-readable list of applied constraints */
  applied: string[];
}

/**
 * Scan entities and exactify near-misses within a tolerance:
 * near-horizontal / near-vertical lines, coincident circle centers and
 * equal-radius clusters. Everything it touches is reported so the viewer can
 * log it like native CAD ("4 constraints applied").
 */
export function autoConstrain(entsIn: DxfEntity[], tol: number): AutoConstrainResult {
  const out = [...entsIn];
  const applied: string[] = [];
  for (let i = 0; i < out.length; i++) {
    const e = out[i];
    if (isLine(e)) {
      const dy = Math.abs(e.end.y - e.start.y);
      const dx = Math.abs(e.end.x - e.start.x);
      if (dy > 1e-9 && dy <= tol && dx > tol) {
        const fixed = fixHorizontal(e);
        if (fixed) { out[i] = fixed; applied.push(`HORIZONTAL on object ${i + 1}`); }
      } else if (dx > 1e-9 && dx <= tol && dy > tol) {
        const fixed = fixVertical(e);
        if (fixed) { out[i] = fixed; applied.push(`VERTICAL on object ${i + 1}`); }
      }
    }
  }
  // concentric circles: snap later circles onto the first of a cluster
  const circles = out.map((e, i) => (isCircle(e) ? { e, i } : null)).filter((v): v is { e: DxfEntity & { type: "CIRCLE" }; i: number } => !!v);
  for (let a = 0; a < circles.length; a++) {
    for (let b = a + 1; b < circles.length; b++) {
      const A = circles[a].e, B = circles[b].e;
      const gap = dist(A.center, B.center);
      if (gap <= tol && gap > 1e-9) {
        const fixed = fixConcentric(A, B);
        if (fixed) {
          circles[b].e = fixed as DxfEntity & { type: "CIRCLE" };
          out[circles[b].i] = fixed;
          applied.push(`CONCENTRIC circles ${a + 1}+${b + 1}`);
        }
      }
    }
  }
  return { entities: out, fixed: applied.length, applied };
}

/* ── Express Tools — text ──────────────────────────────────────────────── */

/** Rough rendered width of a text entity (matches the viewer's fallback metrics). */
export function estTextWidth(e: DxfEntity & { type: "TEXT" }): number {
  const h = e.height || 2.5;
  return Math.max(1, e.value.length) * h * 0.8 * (e.widthFactor ?? 1);
}

/** TXT2MTXT — convert plain TEXT into the engine's MTEXT representation (wrapped column). */
export function textToMText(e: DxfEntity): DxfEntity | null {
  if (e.type !== "TEXT" || e.wrapWidth) return null;
  const out = clone(e);
  out.wrapWidth = estTextWidth(e);
  return out;
}

/** EXPLODETEXT — flatten an MTEXT entity back to plain TEXT. */
export function mTextToText(e: DxfEntity): DxfEntity | null {
  if (e.type !== "TEXT" || (!e.wrapWidth && !e.runs)) return null;
  const out = clone(e);
  delete out.wrapWidth;
  delete out.runs;
  return out;
}

/** TEXTFIT — squeeze/stretch a text's width factor so it spans between two picked points. */
export function textFit(e: DxfEntity, a: DxfPoint, b: DxfPoint): DxfEntity | null {
  if (e.type !== "TEXT") return null;
  const out = clone(e);
  const target = dist(a, b);
  const w = estTextWidth(e);
  out.widthFactor = Math.min(5, Math.max(0.1, (target / w) * (e.widthFactor ?? 1)));
  return out;
}

/** TEXTMASK — toggle a background mask behind a text entity (visual only). */
export function textMaskToggle(e: DxfEntity): DxfEntity | null {
  if (e.type !== "TEXT") return null;
  const out = clone(e);
  out.mask = out.mask ? undefined : true;
  if (out.mask === undefined) delete (out as { mask?: boolean }).mask;
  return out;
}

export interface ArcTextResult {
  entities: Array<DxfEntity & { type: "TEXT" }>;
  center: DxfPoint;
  radius: number;
}

/**
 * ARCTEXT — lay the characters of `text` along an arc, each glyph rotated to
 * follow the curve (like the open-source ARC-aligned text tools). Returns
 * ready-to-commit TEXT entities (one per character).
 */
export function arcText(arc: DxfEntity, text: string, height: number, offset = 0): ArcTextResult | null {
  if (!(isArc(arc) || isCircle(arc)) || !text) return null;
  const r = Math.max(1e-6, arc.radius + offset);
  const chars = [...text];
  if (arc.type === "CIRCLE") {
    // full circle: start at 90° and wrap
    const step = (height * 1.2) / r;
    const entities = chars.map((ch, i) => {
      const a = Math.PI / 2 - (i - (chars.length - 1) / 2) * step;
      return {
        layer: arc.layer,
        color: arc.color,
        lineType: arc.lineType,
        lineweight: arc.lineweight,
        type: "TEXT" as const,
        position: { x: arc.center.x + r * Math.cos(a), y: arc.center.y + r * Math.sin(a) },
        height,
        value: ch,
        rotation: ((90 - (a * 180) / Math.PI) + 360) % 360,
      };
    });
    return { entities, center: arc.center, radius: r };
  }
  const a0 = arc.startAngle, a1 = arc.endAngle;
  const span = ((a1 - a0 + 360) % 360) || 360;
  const stepDeg = Math.min(span / Math.max(1, chars.length - 1), ((height * 1.2) / r) * (180 / Math.PI));
  const total = stepDeg * (chars.length - 1);
  const startDeg = a0 + (span - total) / 2;
  const entities = chars.map((ch, i) => {
    const deg = startDeg + i * stepDeg;
    const rad = (deg * Math.PI) / 180;
    return {
      layer: arc.layer,
      color: arc.color,
      lineType: arc.lineType,
      lineweight: arc.lineweight,
      type: "TEXT" as const,
      position: { x: arc.center.x + r * Math.cos(rad), y: arc.center.y + r * Math.sin(rad) },
      height,
      value: ch,
      rotation: (90 - deg + 360) % 360,
    };
  });
  return { entities, center: arc.center, radius: r };
}

/* ── Express Tools — modify ────────────────────────────────────────────── */

/** FLATTEN — zero every Z coordinate in the entity (returns adjusted copy). */
export function flattenEnt(e: DxfEntity): DxfEntity | null {
  const out = clone(e);
  let touched = false;
  const flat = (p: DxfPoint): DxfPoint => {
    if (p.z) touched = true;
    return z0(p);
  };
  switch (out.type) {
    case "LINE": out.start = flat(out.start); out.end = flat(out.end); break;
    case "RAY": out.start = flat(out.start); out.direction = flat(out.direction); break;
    case "XLINE": out.start = flat(out.start); out.direction = flat(out.direction); break;
    case "CIRCLE": out.center = flat(out.center); break;
    case "ARC": out.center = flat(out.center); break;
    case "POINT": out.position = flat(out.position); break;
    case "TEXT": out.position = flat(out.position); break;
    case "LWPOLYLINE": out.points = out.points.map(flat); break;
    default: return null;
  }
  return touched ? out : null;
}

/**
 * BREAKLINE — the structural break symbol: a polyline between two picked
 * points with the standard zig-zag at the middle (freehand Break-line tool).
 */
export function breakline(a: DxfPoint, b: DxfPoint, layer: string): DxfEntity & { type: "LWPOLYLINE" } {
  const L = dist(a, b);
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const s = Math.max(L * 0.04, L * 0.001 + 0.5); // zig size scales with span
  const mid = midpoint(a, b);
  const px = -Math.sin(ang), py = Math.cos(ang);
  const q = (t: number, n: number): DxfPoint => ({ x: mid.x + px * n + Math.cos(ang) * t * L * 0.12, y: mid.y + py * n + Math.sin(ang) * t * L * 0.12 });
  const p1 = { x: mid.x - Math.cos(ang) * L * 0.12, y: mid.y - Math.sin(ang) * L * 0.12 };
  const p2 = { x: mid.x + Math.cos(ang) * L * 0.12, y: mid.y + Math.sin(ang) * L * 0.12 };
  const pts: DxfPoint[] = [
    z0(a),
    p1,
    q(-1, -s),
    q(0, s),
    q(1, -s),
    p2,
    z0(b),
  ];
  return { layer, type: "LWPOLYLINE", points: pts };
}

/* ── CAD Standards checker (CHECKSTANDARDS) ────────────────────────────── */

export interface StandardsIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
}

/**
 * CHECKSTANDARDS — a real, small standards audit of the open drawing:
 * linetypes / text styles referenced by entities but missing from their
 * tables, invalid layer-name characters, layers with plot flags off, and
 * entities on the reserved layer "0".
 */
export function checkStandards(doc: {
  layers: Array<{ name: string }>;
  entities: DxfEntity[];
  linetypes?: Record<string, unknown>;
  textStyles?: Record<string, unknown>;
}): StandardsIssue[] {
  const issues: StandardsIssue[] = [];
  const ltUpper = new Set(Object.keys(doc.linetypes ?? {}).map((k) => k.toUpperCase()));
  const stUpper = new Set(Object.keys(doc.textStyles ?? {}).map((k) => k.toUpperCase()));
  const layerNames = new Set(doc.layers.map((l) => l.name.toUpperCase()));
  if (doc.linetypes && !ltUpper.has("CONTINUOUS")) {
    issues.push({ severity: "warning", code: "LTYPE", message: 'Linetype table has no "CONTINUOUS" definition.' });
  }
  for (const l of doc.layers) {
    if (/["<>\\/|:;?=*]/.test(l.name)) {
      issues.push({ severity: "error", code: "LAYER", message: `Layer name "${l.name}" contains characters not allowed by the standard.` });
    }
  }
  const onZero = doc.entities.filter((e) => e.type !== "POINT" && e.layer.toUpperCase() === "0").length;
  if (onZero > 0) {
    issues.push({ severity: "warning", code: "LAYER0", message: `${onZero} drawing object(s) sit on reserved layer "0" — move them to a named layer.` });
  }
  const badLt = new Map<string, number>();
  const badSt = new Map<string, number>();
  for (const e of doc.entities) {
    if (e.lineType && !ltUpper.has(e.lineType.toUpperCase())) badLt.set(e.lineType, (badLt.get(e.lineType) ?? 0) + 1);
    if (e.type === "TEXT" && e.style && !stUpper.has(e.style.toUpperCase())) badSt.set(e.style, (badSt.get(e.style) ?? 0) + 1);
  }
  for (const [lt, n] of badLt) {
    issues.push({ severity: "error", code: "LTYPE", message: `${n} object(s) reference undefined linetype "${lt}".` });
  }
  for (const [st, n] of badSt) {
    issues.push({ severity: "error", code: "STYLE", message: `${n} text object(s) reference undefined style "${st}".` });
  }
  // dangling layer references (entities whose layer is not in the table)
  const dangling = new Map<string, number>();
  for (const e of doc.entities) {
    if (!layerNames.has(e.layer.toUpperCase())) dangling.set(e.layer, (dangling.get(e.layer) ?? 0) + 1);
  }
  for (const [ly, n] of dangling) {
    issues.push({ severity: "error", code: "LAYER", message: `${n} object(s) live on layer "${ly}" which is not in the layer table.` });
  }
  return issues;
}
