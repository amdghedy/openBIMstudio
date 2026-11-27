/**
 * Pure 2D geometry helpers shared by the DXF reader and the DWG converter.
 * No DOM, no THREE.
 */
import type { DxfDocument, DxfEntity, DxfPoint, DxfUnits } from "./dxf-types";
import { explodeTable, mirrorTable, tableCorners, tableHeight, tableTextHeight } from "./cad-table";

const DEG = Math.PI / 180;

/** Metres per drawing unit. */
export const UNIT_TO_METRES: Record<DxfUnits, number> = {
  unitless: 1,
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
};

/** DXF $INSUNITS code to a unit (0 / unknown = unitless). */
export function insUnitsToUnits(code: number): DxfUnits {
  switch (Math.round(code)) {
    case 1: return "in";
    case 2: return "ft";
    case 4: return "mm";
    case 5: return "cm";
    case 6: return "m";
    default: return "unitless";
  }
}

/**
 * Points between p0 and p1 (exclusive of both) for a polyline segment with
 * the given bulge (tan of a quarter of the included angle; + = CCW).
 */
export function bulgePoints(p0: DxfPoint, p1: DxfPoint, bulge: number): DxfPoint[] {
  if (!bulge || !Number.isFinite(bulge)) return [];
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const c = Math.hypot(dx, dy);
  if (c < 1e-12) return [];
  const theta = 4 * Math.atan(bulge);
  const h = c / 2 / Math.tan(theta / 2);
  const cx = (p0.x + p1.x) / 2 + (-dy / c) * h;
  const cy = (p0.y + p1.y) / 2 + (dx / c) * h;
  const a0 = Math.atan2(p0.y - cy, p0.x - cx);
  const n = Math.max(2, Math.ceil(Math.abs(theta) / (Math.PI / 16)));
  const r = Math.hypot(p0.x - cx, p0.y - cy);
  const out: DxfPoint[] = [];
  for (let k = 1; k < n; k++) {
    const a = a0 + (theta * k) / n;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z: p0.z });
  }
  return out;
}

/** Vertices with bulges expanded into short straight segments. */
export function expandBulges(
  verts: Array<DxfPoint & { bulge?: number }>,
  closed: boolean,
): DxfPoint[] {
  const out: DxfPoint[] = [];
  const n = verts.length;
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    out.push({ x: a.x, y: a.y, z: a.z });
    const last = i === n - 1;
    if (last && !closed) break;
    const b = verts[(i + 1) % n];
    if (a.bulge) { const bp = bulgePoints(a, b, a.bulge); for (let q = 0; q < bp.length; q++) out.push(bp[q]); }
  }
  return out;
}

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Structural clean-up for a polyline read from a file or built by a tool:
 * bulge/width arrays are padded or truncated to `points.length`, NaN and
 * negative widths are dropped to 0, and an all-zero bulge array is
 * removed. Never changes the geometry, only the bookkeeping.
 */
export function normalizePolyline<T extends Extract<DxfEntity, { type: "LWPOLYLINE" }>>(e: T): T {
  const n = e.points.length;
  const align = (arr: number[] | undefined): number[] | undefined => {
    if (!arr) return undefined;
    const out = new Array<number>(n).fill(0);
    for (let i = 0; i < Math.min(n, arr.length); i++) out[i] = isFiniteNum(arr[i]) ? arr[i] : 0;
    return out;
  };
  const bulges = align(e.bulges);
  const startWidths = align(e.startWidths);
  const endWidths = align(e.endWidths);
  const width = isFiniteNum(e.width) && e.width > 0 ? e.width : undefined;
  const cleanWidths = (arr: number[] | undefined): number[] | undefined => {
    if (!arr) return undefined;
    // Clamp only (negatives and NaN are invalid DXF); an explicit 0 at a
    // vertex is meaningful — per DXF rules it overrides the constant
    // width there (a taper to a point) — so all-zero arrays are kept.
    return arr.map((w) => (isFiniteNum(w) && w > 0 ? w : 0));
  };
  return {
    ...e,
    ...(bulges?.some((b) => b !== 0) ? { bulges } : { bulges: undefined }),
    ...(width != null ? { width } : { width: undefined }),
    ...(cleanWidths(startWidths) ? { startWidths: cleanWidths(startWidths) } : { startWidths: undefined }),
    ...(cleanWidths(endWidths) ? { endWidths: cleanWidths(endWidths) } : { endWidths: undefined }),
  };
}

/**
 * The circle behind one bulged segment, as a counter-clockwise arc.
 * `startAngleDeg`/`endAngleDeg` are the CCW sweep that draws the same
 * geometric arc (0 < sweep < 360); the arc runs from p0 to p1 along that
 * sweep exactly when bulge > 0, and against it (clockwise) when bulge < 0.
 * null for a zero bulge or a degenerate (zero-length) chord.
 */
export interface BulgeArc {
  center: DxfPoint;
  radius: number;
  /** Degrees, CCW start of the arc. */
  startAngleDeg: number;
  /** Degrees, CCW end of the arc. */
  endAngleDeg: number;
  /** Degrees, 0 < sweep < 360, the CCW sweep from start to end. */
  sweepDeg: number;
}
export function bulgeArc(p0: DxfPoint, p1: DxfPoint, bulge: number): BulgeArc | null {
  if (!bulge || !Number.isFinite(bulge)) return null;
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const c = Math.hypot(dx, dy);
  if (c < 1e-12) return null;
  const theta = 4 * Math.atan(bulge); // signed sweep, radians
  const h = c / 2 / Math.tan(theta / 2);
  const cx = (p0.x + p1.x) / 2 + (-dy / c) * h;
  const cy = (p0.y + p1.y) / 2 + (dx / c) * h;
  const radius = Math.hypot(p0.x - cx, p0.y - cy);
  const a0 = Math.atan2(p0.y - cy, p0.x - cx) / DEG;
  // The CCW sweep from p0 to p1 is theta when bulge > 0; when bulge < 0
  // the arc runs clockwise, so the CCW arc starts at p1 instead.
  const sweepDeg = ((Math.abs(theta) / DEG) % 360) || 360;
  const start = bulge > 0 ? a0 : a0 + (theta / DEG);
  const norm = (d: number): number => ((d % 360) + 360) % 360;
  return { center: { x: cx, y: cy, z: p0.z }, radius, startAngleDeg: norm(start), endAngleDeg: norm(start + sweepDeg), sweepDeg };
}

/** Included angle of a bulge in degrees (signed: + = CCW). */
export function bulgeSweepDeg(bulge: number): number {
  return (4 * Math.atan(bulge)) / DEG;
}

/**
 * Display vertices for a polyline whose segments may bulge: the stored
 * vertices plus the tessellated arc points in between (bulgePoints).
 * `bulges` is index-aligned with `points` (bulges[i] = segment i→i+1,
 * last entry = closing segment when closed). Straight segments pass
 * through unchanged, so a bulge-free polyline returns its own vertices.
 */
export function tessellatePolyline(points: DxfPoint[], bulges: number[] | undefined, closed: boolean): DxfPoint[] {
  if (!bulges || !bulges.some((b) => b)) return points.map((p) => ({ ...p }));
  return expandBulges(points.map((p, i) => ({ ...p, bulge: bulges[i] || undefined })), closed);
}

/** True (arc-aware) length of a polyline: bulged segments count as arcs. */
export function polylineLength(points: DxfPoint[], bulges: number[] | undefined, closed: boolean): number {
  const n = points.length;
  if (n < 2) return 0;
  const segs = closed ? n : n - 1;
  let len = 0;
  for (let i = 0; i < segs; i++) {
    const a = points[i], b = points[(i + 1) % n];
    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    const bg = bulges?.[i] ?? 0;
    if (!bg) { len += chord; continue; }
    const arc = bulgeArc(a, b, bg);
    len += arc ? arc.radius * (arc.sweepDeg * DEG) : chord;
  }
  return len;
}

/**
 * True (arc-aware) area of a closed polyline: the chord-polygon area plus
 * one circular-segment correction per bulged edge,
 * (r²/2)·(θ − sin θ) with θ the signed included angle. Open polylines
 * have no area.
 */
export function polylineArea(points: DxfPoint[], bulges: number[] | undefined, closed: boolean): number {
  const n = points.length;
  if (!closed || n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i], q = points[(i + 1) % n];
    a += p.x * q.y - q.x * p.y;
  }
  a /= 2;
  for (let i = 0; i < n; i++) {
    const bg = bulges?.[i] ?? 0;
    if (!bg) continue;
    const arc = bulgeArc(points[i], points[(i + 1) % n], bg);
    if (!arc) continue;
    const theta = (bulgeSweepDeg(bg) * DEG);
    a += (arc.radius * arc.radius / 2) * (theta - Math.sin(theta));
  }
  return Math.abs(a);
}

/**
 * Bounding box of a polyline including bulged-arc extremes (the arc's
 * cardinal points that fall inside its sweep) and, when `halfWidth` is
 * given, the stroke width around it. With no bulges this is exactly the
 * vertex box, so existing callers see no change.
 */
export function polylineBBox(
  points: DxfPoint[], bulges: number[] | undefined, closed: boolean, halfWidth = 0,
): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const p of points) add(p.x, p.y);
  const n = points.length;
  const segs = closed ? n : Math.max(0, n - 1);
  for (let i = 0; i < segs; i++) {
    const bg = bulges?.[i] ?? 0;
    if (!bg) continue;
    const arc = bulgeArc(points[i], points[(i + 1) % n], bg);
    if (!arc) continue;
    for (const q of [0, 90, 180, 270]) {
      // Is the cardinal angle inside the CCW sweep from start to end?
      const rel = ((q - arc.startAngleDeg) % 360 + 360) % 360;
      if (rel <= arc.sweepDeg + 1e-9) {
        const a = q * DEG;
        add(arc.center.x + arc.radius * Math.cos(a), arc.center.y + arc.radius * Math.sin(a));
      }
    }
  }
  if (halfWidth > 0 && Number.isFinite(minX)) {
    minX -= halfWidth; minY -= halfWidth; maxX += halfWidth; maxY += halfWidth;
  }
  return { minX, minY, maxX, maxY };
}

/** Points along an arc/circle (angles in radians, CCW from a0 to a1). */
export function arcPoints(
  cx: number, cy: number, r: number, a0: number, a1: number, z = 0,
): DxfPoint[] {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(8, Math.ceil(sweep / (Math.PI / 24)));
  const out: DxfPoint[] = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + (sweep * k) / n;
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), z });
  }
  return out;
}

/** Evaluate an open B-spline with the given knots/degree. null if inconsistent. */
export function evalBSpline(
  ctrl: DxfPoint[], knots: number[], degree: number, samples = 0,
): DxfPoint[] | null {
  const n = ctrl.length;
  const p = Math.max(1, Math.round(degree));
  if (n < p + 1 || knots.length !== n + p + 1) return null;
  const t0 = knots[p];
  const t1 = knots[n];
  if (!(t1 > t0)) return null;
  const count = samples || Math.min(400, Math.max(24, n * 12));
  const out: DxfPoint[] = [];
  for (let s = 0; s <= count; s++) {
    const t = s === count ? t1 : t0 + ((t1 - t0) * s) / count;
    let k = p;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d = ctrl.slice(k - p, k + 1).map((q) => ({ x: q.x, y: q.y, z: q.z ?? 0 }));
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const den = knots[j + 1 + k - r] - knots[j + k - p];
        const a = den === 0 ? 0 : (t - knots[j + k - p]) / den;
        d[j] = {
          x: (1 - a) * d[j - 1].x + a * d[j].x,
          y: (1 - a) * d[j - 1].y + a * d[j].y,
          z: (1 - a) * d[j - 1].z + a * d[j].z,
        };
      }
    }
    out.push(d[p]);
  }
  return out;
}

/** Points of an ellipse. major = major-axis endpoint relative to centre. */
export function ellipsePoints(
  center: DxfPoint, major: DxfPoint, ratio: number, t0: number, t1: number,
): DxfPoint[] {
  const mx = major.x, my = major.y;
  const nx = -my * ratio, ny = mx * ratio;
  let sweep = t1 - t0;
  while (sweep <= 0) sweep += Math.PI * 2;
  const n = Math.max(24, Math.ceil(sweep / (Math.PI / 32)));
  const out: DxfPoint[] = [];
  for (let k = 0; k <= n; k++) {
    const t = t0 + (sweep * k) / n;
    out.push({
      x: center.x + mx * Math.cos(t) + nx * Math.sin(t),
      y: center.y + my * Math.cos(t) + ny * Math.sin(t),
      z: center.z ?? 0,
    });
  }
  return out;
}

/** Block-insert transform: p' = ins + R(rot) * S * (p - base). */
export interface InsertXform {
  sx: number;
  sy: number;
  sz: number;
  /** Rotation in degrees. */
  rot: number;
  base: DxfPoint;
  ins: DxfPoint;
}

export const IDENTITY_XFORM: InsertXform = {
  sx: 1, sy: 1, sz: 1, rot: 0, base: { x: 0, y: 0, z: 0 }, ins: { x: 0, y: 0, z: 0 },
};

function xp(m: InsertXform, p: DxfPoint): DxfPoint {
  const x = (p.x - m.base.x) * m.sx;
  const y = (p.y - m.base.y) * m.sy;
  const z = ((p.z ?? 0) - (m.base.z ?? 0)) * m.sz;
  const a = m.rot * DEG;
  const c = Math.cos(a), s = Math.sin(a);
  return {
    x: m.ins.x + x * c - y * s,
    y: m.ins.y + x * s + y * c,
    z: (m.ins.z ?? 0) + z,
  };
}

/** Direction of text (deg) after scale, mirror and rotation of an insert: exact for any sign combination. */
export function textAngleThrough(m: InsertXform, angleDeg: number): number {
  const a = angleDeg * DEG;
  const dx = Math.cos(a) * m.sx, dy = Math.sin(a) * m.sy;
  const out = Math.atan2(dy, dx) / DEG + m.rot;
  return ((out % 360) + 360) % 360;
}

/** Apply an insert transform to one entity (arcs/circles become polylines if the scale is non-uniform). */
export function transformEntity(e: DxfEntity, m: InsertXform): DxfEntity[] {
  const uniform = Math.abs(Math.abs(m.sx) - Math.abs(m.sy)) < 1e-9 * Math.max(1, Math.abs(m.sx));
  const flip = m.sx < 0 && m.sy < 0 ? 180 : 0; // (-s,-s) is a rotation by 180
  const mirrored = m.sx * m.sy < 0;
  // Keep every display property through an INSERT: dropping lineweight / ltScale / transparency made block content
  // print and draw with the wrong weight and pattern scale.
  const base = {
    layer: e.layer, color: e.color, rgb: e.rgb, lineType: e.lineType,
    ...(e.lineweight !== undefined ? { lineweight: e.lineweight } : {}),
    ...(e.ltScale !== undefined ? { ltScale: e.ltScale } : {}),
    ...(e.transparency !== undefined ? { transparency: e.transparency } : {}),
  };

  switch (e.type) {
    case "LINE":
      return [{ ...base, type: "LINE", start: xp(m, e.start), end: xp(m, e.end) }];
    case "POINT":
      return [{ ...base, type: "POINT", position: xp(m, e.position) }];
    case "LWPOLYLINE":
      // Bulges travel with the polyline: a mirror (sx·sy < 0) reverses the
      // arc direction, so the bulge sign flips; a rotation or uniform scale
      // leaves it alone. Widths are drawing-unit strokes: they scale with
      // the mean absolute scale (exact for uniform scales, the honest
      // average for non-uniform ones, where a width has no single scale).
      return [{
        ...base, type: "LWPOLYLINE", points: e.points.map((p) => xp(m, p)), closed: e.closed,
        ...(e.bulges?.some((b) => b) ? { bulges: e.bulges.map((b) => (mirrored ? -b : b)) } : {}),
        ...(e.width != null ? { width: e.width * ((Math.abs(m.sx) + Math.abs(m.sy)) / 2) } : {}),
        ...(e.startWidths ? { startWidths: e.startWidths.map((w) => w * ((Math.abs(m.sx) + Math.abs(m.sy)) / 2)) } : {}),
        ...(e.endWidths ? { endWidths: e.endWidths.map((w) => w * ((Math.abs(m.sx) + Math.abs(m.sy)) / 2)) } : {}),
        ...(e.hatch ? { hatch: { ...e.hatch, angle: textAngleThrough(m, e.hatch.angle ?? 0), scale: (e.hatch.scale ?? 1) * Math.abs(m.sx), loops: e.hatch.loops.map((l) => l.map((p) => xp(m, p))) } } : {}),
      }];
    case "TEXT":
      return [{
        ...base, type: "TEXT", position: xp(m, e.position),
        height: e.height * Math.abs(m.sy),
        value: e.value, rotation: textAngleThrough(m, e.rotation ?? 0), align: e.align, valign: e.valign,
        ...(e.style ? { style: e.style } : {}), ...(e.font ? { font: e.font } : {}),
        ...(e.bold ? { bold: true } : {}), ...(e.italic ? { italic: true } : {}),
        ...(e.widthFactor ? { widthFactor: e.widthFactor } : {}), ...(e.oblique ? { oblique: e.oblique } : {}),
      }];
    case "CIRCLE":
      if (uniform && !mirrored) {
        return [{ ...base, type: "CIRCLE", center: xp(m, e.center), radius: e.radius * Math.abs(m.sx) }];
      }
      return [{
        ...base, type: "LWPOLYLINE", closed: true,
        points: arcPoints(e.center.x, e.center.y, e.radius, 0, Math.PI * 2, e.center.z ?? 0)
          .slice(0, -1).map((p) => xp(m, p)),
      }];
    case "ARC":
      if (uniform && !mirrored) {
        return [{
          ...base, type: "ARC", center: xp(m, e.center), radius: e.radius * Math.abs(m.sx),
          startAngle: e.startAngle + m.rot + flip, endAngle: e.endAngle + m.rot + flip,
        }];
      }
      return [{
        ...base, type: "LWPOLYLINE", closed: false,
        points: arcPoints(e.center.x, e.center.y, e.radius, e.startAngle * DEG, e.endAngle * DEG, e.center.z ?? 0)
          .map((p) => xp(m, p)),
      }];
    case "DIMENSION":
      // A dimension moves rigidly with its definition points; the drawn
      // geometry (anonymous block) is transformed separately by the caller.
      return [{
        ...base, type: "DIMENSION", dimId: e.dimId, dimType: e.dimType, styleName: e.styleName,
        defPoint: xp(m, e.defPoint),
        ...(e.extOrigin1 ? { extOrigin1: xp(m, e.extOrigin1) } : {}),
        ...(e.extOrigin2 ? { extOrigin2: xp(m, e.extOrigin2) } : {}),
        ...(e.curvePoint ? { curvePoint: xp(m, e.curvePoint) } : {}),
        ...(e.leaderEnd ? { leaderEnd: xp(m, e.leaderEnd) } : {}),
        ...(e.text !== undefined ? { text: e.text } : {}),
        ...(e.textPoint ? { textPoint: xp(m, e.textPoint) } : {}),
      }];
    case "TABLE": {
      // A similarity (uniform scale, rotation, optional mirror) keeps the
      // table a table: the frame rotates/reflects exactly, widths and
      // heights scale, and a mirror reverses the rows (see mirrorTable).
      // A non-uniform scale shears the rectangle into a parallelogram no
      // TABLE can hold — explode to the exact loose grid + text instead.
      if (uniform) {
        const s = Math.abs(m.sx);
        const rot = textAngleThrough(m, e.rotation ?? 0);
        const h = tableHeight(e) * s;
        const th = tableTextHeight(e) * s;
        let position = xp(m, e.position);
        let rowHeights = e.rowHeights.map((x) => x * s);
        let cells = e.cells;
        if (mirrored) {
          const ra = rot * DEG;
          position = { x: position.x - Math.sin(ra) * h, y: position.y + Math.cos(ra) * h, z: position.z ?? 0 };
          rowHeights = [...rowHeights].reverse();
          cells = [...cells].reverse().map((r) => [...r]);
        }
        const rotNorm = (((rot % 360) + 360) % 360 + 180) % 360 - 180;
        return [{
          ...base, type: "TABLE", position,
          colWidths: e.colWidths.map((x) => x * s),
          rowHeights,
          cells: cells.map((r) => [...r]),
          textHeight: th,
          ...(Math.abs(rotNorm) > 1e-9 ? { rotation: rotNorm } : {}),
          ...(e.headerRow ? { headerRow: true } : {}),
        }];
      }
      return explodeTable(e).flatMap((part) => transformEntity(part, m));
    }
  }
  return [];
}

/** Bounding box of all entity geometry (arcs/circles by their full extent). */
export function computeExtents(entities: DxfEntity[]): DxfDocument["extents"] | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const e of entities) {
    switch (e.type) {
      case "LINE": add(e.start.x, e.start.y); add(e.end.x, e.end.y); break;
      case "LWPOLYLINE": { const mw = Math.max(0, e.width ?? 0, ...(e.startWidths ?? []), ...(e.endWidths ?? [])); const b = polylineBBox(e.points, e.bulges, !!e.closed, mw / 2); add(b.minX, b.minY); add(b.maxX, b.maxY); break; }
      case "CIRCLE":
        add(e.center.x - e.radius, e.center.y - e.radius);
        add(e.center.x + e.radius, e.center.y + e.radius);
        break;
      case "ARC":
        for (const p of arcPoints(e.center.x, e.center.y, e.radius, e.startAngle * DEG, e.endAngle * DEG)) add(p.x, p.y);
        break;
      case "TEXT": case "POINT": add(e.position.x, e.position.y); break;
      case "TABLE": for (const p of tableCorners(e)) add(p.x, p.y); break;
      case "DIMENSION":
        add(e.defPoint.x, e.defPoint.y);
        if (e.extOrigin1) add(e.extOrigin1.x, e.extOrigin1.y);
        if (e.extOrigin2) add(e.extOrigin2.x, e.extOrigin2.y);
        if (e.curvePoint) add(e.curvePoint.x, e.curvePoint.y);
        if (e.leaderEnd) add(e.leaderEnd.x, e.leaderEnd.y);
        if (e.textPoint) add(e.textPoint.x, e.textPoint.y);
        break;
    }
  }
  if (!Number.isFinite(minX)) return undefined;
  return { min: { x: minX, y: minY, z: 0 }, max: { x: maxX, y: maxY, z: 0 } };
}

/**
 * Drop wildly distant strays. CAD files often carry a few entities near the
 * world origin or at huge coordinates that would make the extents (and a
 * "centre to centre" placement) useless. Uses the median centre of the
 * entities and a generous multiple of the median spread.
 */
export function robustExtents(entities: DxfEntity[]): DxfDocument["extents"] | undefined {
  const pts: Array<[number, number]> = [];
  for (const e of entities) {
    if (e.type === "LINE") { pts.push([e.start.x, e.start.y], [e.end.x, e.end.y]); }
    else if (e.type === "LWPOLYLINE") { for (const p of e.points) pts.push([p.x, p.y]); }
    else if (e.type === "CIRCLE" || e.type === "ARC") pts.push([e.center.x, e.center.y]);
  }
  if (pts.length < 8) return computeExtents(entities);
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const mx = med(pts.map((p) => p[0]));
  const my = med(pts.map((p) => p[1]));
  const dev = pts.map((p) => Math.hypot(p[0] - mx, p[1] - my));
  const limit = Math.max(med(dev) * 25, 1e-6);
  const keep = entities.filter((e) => {
    const p = e.type === "LINE" ? e.start
      : e.type === "LWPOLYLINE" ? e.points[0]
      : e.type === "CIRCLE" || e.type === "ARC" ? e.center
      : e.type === "TEXT" || e.type === "POINT" ? e.position : null;
    return !p || Math.hypot(p.x - mx, p.y - my) <= limit;
  });
  return computeExtents(keep.length ? keep : entities);
}

/**
 * Entities stored in an OCS whose extrusion points down (0,0,-1) are mirrored in X in the world.
 * Applies that mirror (x -> -x) to an already-converted entity. Arcs keep counter-clockwise order.
 */
export function flipEntityX(e: DxfEntity): DxfEntity {
  const fp = (p: DxfPoint): DxfPoint => ({ ...p, x: -p.x });
  switch (e.type) {
    case "INSERT":
      return {
        ...e, position: fp(e.position), rotation: 180 - (e.rotation ?? 0),
        scale: { x: e.scale?.x ?? 1, y: -(e.scale?.y ?? 1), z: e.scale?.z },
        attributes: e.attributes?.map((a) => ({ ...a, position: fp(a.position) })),
      };
    case "LINE": return { ...e, start: fp(e.start), end: fp(e.end) };
    case "POINT": return { ...e, position: fp(e.position) };
    case "CIRCLE": return { ...e, center: fp(e.center) };
    case "ARC": return { ...e, center: fp(e.center), startAngle: 180 - e.endAngle, endAngle: 180 - e.startAngle };
    case "LWPOLYLINE": return { ...e, points: e.points.map(fp), ...(e.bulges?.some((b) => b) ? { bulges: e.bulges.map((b) => -b) } : {}), ...(e.hatch ? { hatch: { ...e.hatch, angle: 180 - (e.hatch.angle ?? 0), loops: e.hatch.loops.map((l) => l.map(fp)) } } : {}) };
    case "RAY":
    case "XLINE": return { ...e, start: fp(e.start), direction: fp(e.direction) };
    case "TEXT": return { ...e, position: fp(e.position), rotation: 180 - (e.rotation ?? 0), align: e.align === "left" ? "right" : e.align === "right" ? "left" : e.align };
    case "TABLE":
      // Mirror across the Y axis (x -> -x): the frame reflects and the rows
      // reverse so every cell keeps its world position (see mirrorTable).
      return mirrorTable(e, { x: 0, y: 0 }, { x: 0, y: 1 });
    case "DIMENSION":
      return {
        ...e, defPoint: fp(e.defPoint),
        ...(e.extOrigin1 ? { extOrigin1: fp(e.extOrigin1) } : {}),
        ...(e.extOrigin2 ? { extOrigin2: fp(e.extOrigin2) } : {}),
        ...(e.curvePoint ? { curvePoint: fp(e.curvePoint) } : {}),
        ...(e.textPoint ? { textPoint: fp(e.textPoint) } : {}),
      };
  }
}

/** True when an extrusion vector is (0,0,-1) within tolerance, i.e. the OCS is X-mirrored. */
export function isMirroredOcs(nx: number, ny: number, nz: number): boolean {
  return nz < -0.5 && Math.abs(nx) < 1e-6 && Math.abs(ny) < 1e-6;
}
