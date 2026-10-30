/**
 * Pure 2D geometry helpers shared by the DXF reader and the DWG converter.
 * No DOM, no THREE.
 */
import type { DxfDocument, DxfEntity, DxfPoint, DxfUnits } from "./dxf-types";

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
    if (a.bulge) out.push(...bulgePoints(a, b, a.bulge));
  }
  return out;
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
  const base = { layer: e.layer, color: e.color, rgb: e.rgb, lineType: e.lineType };

  switch (e.type) {
    case "LINE":
      return [{ ...base, type: "LINE", start: xp(m, e.start), end: xp(m, e.end) }];
    case "POINT":
      return [{ ...base, type: "POINT", position: xp(m, e.position) }];
    case "LWPOLYLINE":
      return [{
        ...base, type: "LWPOLYLINE", points: e.points.map((p) => xp(m, p)), closed: e.closed,
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
      case "LWPOLYLINE": for (const p of e.points) add(p.x, p.y); break;
      case "CIRCLE":
        add(e.center.x - e.radius, e.center.y - e.radius);
        add(e.center.x + e.radius, e.center.y + e.radius);
        break;
      case "ARC":
        for (const p of arcPoints(e.center.x, e.center.y, e.radius, e.startAngle * DEG, e.endAngle * DEG)) add(p.x, p.y);
        break;
      case "TEXT": case "POINT": add(e.position.x, e.position.y); break;
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
    case "LINE": return { ...e, start: fp(e.start), end: fp(e.end) };
    case "POINT": return { ...e, position: fp(e.position) };
    case "CIRCLE": return { ...e, center: fp(e.center) };
    case "ARC": return { ...e, center: fp(e.center), startAngle: 180 - e.endAngle, endAngle: 180 - e.startAngle };
    case "LWPOLYLINE": return { ...e, points: e.points.map(fp), ...(e.hatch ? { hatch: { ...e.hatch, angle: 180 - (e.hatch.angle ?? 0), loops: e.hatch.loops.map((l) => l.map(fp)) } } : {}) };
    case "TEXT": return { ...e, position: fp(e.position), rotation: 180 - (e.rotation ?? 0), align: e.align === "left" ? "right" : e.align === "right" ? "left" : e.align };
  }
}

/** True when an extrusion vector is (0,0,-1) within tolerance, i.e. the OCS is X-mirrored. */
export function isMirroredOcs(nx: number, ny: number, nz: number): boolean {
  return nz < -0.5 && Math.abs(nx) < 1e-6 && Math.abs(ny) < 1e-6;
}
