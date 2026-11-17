/**
 * Converters for engine entities that the acadrust bridge sends with geometry but the viewer
 * used to drop: MLEADER, TABLE, MLINE, IMAGE, TOLERANCE.
 *
 * Pure functions over the engine's JSON (see cad-engine-rust/src/json.rs), unit-tested in Node.
 * Honest limits (reported through `note`): MLINE is drawn as its centre path only, IMAGE as its
 * frame only (no pixels), TABLE as grid + cell text (merged cells are not merged, borders styles ignored).
 */
import type { DxfEntity, DxfPoint } from "./dxf-types";

type Any = Record<string, any>;
export interface ExtraCtx {
  pt: (a: Any) => DxfPoint;
  clean: (s: string) => string;
  /** radians -> degrees factor used by the engine converter */
  deg: number;
  note: (msg: string) => void;
  /** MLINE style lookup (by style handle, else by name) from the engine's `mlineStyles`. */
  mlineStyle?: (handle?: string, name?: string) => MlineStyle | undefined;
}
export interface MlineStyle { offsets: number[]; startCap?: boolean; endCap?: boolean; fill?: boolean }

const MAX_TABLE_CELLS = 20000;

export function convertMleader(e: Any, c: Any, x: ExtraCtx): DxfEntity[] {
  const out: DxfEntity[] = [];
  for (const ln of (e.lines ?? []) as Any[]) {
    const pts = (Array.isArray(ln) ? ln : []).map(x.pt);
    if (pts.length >= 2) out.push({ ...c, type: "LWPOLYLINE", points: pts, closed: false } as DxfEntity);
  }
  const text = x.clean(String(e.text ?? ""));
  if (text.trim()) {
    out.push({
      ...c, type: "TEXT", position: x.pt(e.textLocation ?? e.contentBase),
      height: Number(e.textHeight ?? 0) || 2.5, value: text, rotation: Number(e.textRotation ?? 0) * x.deg,
    } as DxfEntity);
  }
  if (!out.length) x.note("MLEADER (no lines or text)");
  return out;
}

export function convertTable(e: Any, c: Any, x: ExtraCtx): DxfEntity[] {
  const cols: number[] = (e.colWidths ?? []).map(Number).filter((n: number) => Number.isFinite(n));
  const rows: number[] = (e.rowHeights ?? []).map(Number).filter((n: number) => Number.isFinite(n));
  if (!cols.length || !rows.length) { x.note("TABLE (no rows or columns)"); return []; }
  const o = x.pt(e.position), d = x.pt(e.dir);
  let ux = d.x, uy = d.y; const dl = Math.hypot(ux, uy);
  if (dl < 1e-9) { ux = 1; uy = 0; } else { ux /= dl; uy /= dl; }
  const vx = -uy, vy = ux; // table rows run in -v
  const W = cols.reduce((a, b) => a + b, 0), H = rows.reduce((a, b) => a + b, 0);
  const at = (a: number, b: number): DxfPoint => ({ x: o.x + ux * a - vx * b, y: o.y + uy * a - vy * b, z: o.z ?? 0 });
  const out: DxfEntity[] = [];
  let yy = 0;
  for (let j = 0; j <= rows.length; j++) {
    out.push({ ...c, type: "LINE", start: at(0, yy), end: at(W, yy) } as DxfEntity);
    if (j < rows.length) yy += rows[j];
  }
  let xx = 0;
  for (let i = 0; i <= cols.length; i++) {
    out.push({ ...c, type: "LINE", start: at(xx, 0), end: at(xx, H) } as DxfEntity);
    if (i < cols.length) xx += cols[i];
  }
  const rot = Math.atan2(uy, ux) * (180 / Math.PI);
  const cells: string[][] = Array.isArray(e.cells) ? e.cells : [];
  let y0 = 0, n = 0;
  for (let j = 0; j < rows.length; j++) {
    let x0 = 0;
    const rowCells = cells[j] ?? [];
    for (let i = 0; i < cols.length; i++) {
      const raw = rowCells[i];
      if (raw && ++n <= MAX_TABLE_CELLS) {
        const t = x.clean(String(raw));
        if (t.trim()) {
          const h = Number(e.textHeight ?? 0) || Math.min(2.5, rows[j] * 0.5);
          out.push({
            ...c, type: "TEXT", position: at(x0 + Math.min(cols[i] * 0.05, h * 0.5), y0 + rows[j] / 2),
            height: Math.min(h, rows[j] * 0.8) || h, value: t, rotation: rot,
          } as DxfEntity);
        }
      }
      x0 += cols[i];
    }
    y0 += rows[j];
  }
  return out;
}

export function convertMline(e: Any, c: Any, x: ExtraCtx): DxfEntity[] {
  const pts = (e.vertices ?? []).map(x.pt) as DxfPoint[];
  if (pts.length < 2) { x.note("MLINE (<2 vertices)"); return []; }
  const centre = (): DxfEntity[] => [{ ...c, type: "LWPOLYLINE", points: pts, closed: !!e.closed && pts.length > 2 } as DxfEntity];
  const st = x.mlineStyle?.(e.styleHandle, e.style);
  const miters = (e.miters ?? []).map(x.pt) as DxfPoint[];
  const offs = (st?.offsets ?? []).map(Number).filter((n) => Number.isFinite(n));
  if (!offs.length || miters.length !== pts.length) {
    x.note("MLINE (centre path only, style offsets unavailable)");
    return centre();
  }
  const scale = Number.isFinite(Number(e.scale)) && Number(e.scale) !== 0 ? Number(e.scale) : 1;
  const n = pts.length, closed = !!e.closed && n > 2, segs = closed ? n : n - 1;
  // Unit miter at each vertex, and the factor 1/cos that keeps the element a constant distance from the centre path
  // on both adjoining segments (a true mitred corner). Falls back to the plain segment normal if no miter is stored.
  const dirOf = (i: number) => { const a = pts[i], b = pts[(i + 1) % n]; const l = Math.hypot(b.x - a.x, b.y - a.y) || 1; return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }; };
  const mit = pts.map((_, i) => {
    const prev = closed ? dirOf((i - 1 + n) % n) : dirOf(Math.max(0, i - 1));
    const next = closed || i < n - 1 ? dirOf(i) : prev;
    let mx = miters[i].x, my = miters[i].y; const l = Math.hypot(mx, my);
    if (l > 1e-9) { mx /= l; my /= l; } else { const bx = prev.x + next.x, by = prev.y + next.y; mx = -by; my = bx; const bl = Math.hypot(mx, my) || 1; mx /= bl; my /= bl; if (bl === 1 && !bx && !by) { mx = -next.y; my = next.x; } }
    const k = Math.min(Math.abs(mx * -prev.y + my * prev.x), Math.abs(mx * -next.y + my * next.x));
    return { x: mx, y: my, f: k > 0.2 ? 1 / k : 5 };
  });
  const out: DxfEntity[] = [];
  const at = (i: number, o: number): DxfPoint => ({ x: pts[i].x + mit[i].x * o * scale * mit[i].f, y: pts[i].y + mit[i].y * o * scale * mit[i].f, z: pts[i].z ?? 0 });
  for (const o of offs) {
    const line: DxfPoint[] = []; for (let i = 0; i < n; i++) line.push(at(i, o));
    out.push({ ...c, type: "LWPOLYLINE", points: line, closed } as DxfEntity);
  }
  const lo = Math.min(...offs), hi = Math.max(...offs);
  if (!closed && offs.length >= 2 && hi > lo) {
    if (st?.startCap && !e.noStartCap) out.push({ ...c, type: "LINE", start: at(0, lo), end: at(0, hi) } as DxfEntity);
    if (st?.endCap && !e.noEndCap) out.push({ ...c, type: "LINE", start: at(n - 1, lo), end: at(n - 1, hi) } as DxfEntity);
  }
  if (st?.fill) x.note("MLINE (fill not drawn)");
  return out;
}

export function convertImage(e: Any, c: Any, x: ExtraCtx): DxfEntity[] {
  const p = x.pt(e.position), u = x.pt(e.u), v = x.pt(e.v);
  const sz: number[] = Array.isArray(e.size) ? e.size.map(Number) : [Number(e.width ?? 0), Number(e.height ?? 0)];
  const sx = sz[0] || 0, sy = sz[1] || 0;
  if (!(sx > 0 && sy > 0)) { x.note("IMAGE (no size)"); return []; }
  const q = (a: number, b: number): DxfPoint => ({ x: p.x + u.x * a + v.x * b, y: p.y + u.y * a + v.y * b, z: p.z ?? 0 });
  x.note("IMAGE (frame only, pixels not drawn)");
  return [{ ...c, type: "LWPOLYLINE", points: [q(0, 0), q(sx, 0), q(sx, sy), q(0, sy)], closed: true } as DxfEntity];
}

export function convertTolerance(e: Any, c: Any, x: ExtraCtx): DxfEntity[] {
  const t = x.clean(String(e.text ?? ""));
  if (!t.trim()) return [];
  return [{ ...c, type: "TEXT", position: x.pt(e.position), height: 2.5, value: t, rotation: 0 } as DxfEntity];
}

/**
 * WIPEOUT: a masking region. The clip boundary is in image space (pixel centres, so +0.5 maps the
 * unit square onto the u/v frame); a 2-vertex rectangular clip means opposite corners.
 * Drawn as a solid fill with the drawing background, like the platform's own Wipeout tool.
 */
export function convertWipeout(e: Any, c: Any, x: ExtraCtx): DxfEntity[] {
  const p = x.pt(e.position), u = x.pt(e.u), v = x.pt(e.v);
  const clip: number[][] = Array.isArray(e.clip) ? e.clip.filter((q: any) => Array.isArray(q) && q.length >= 2) : [];
  let img: Array<[number, number]>;
  if (e.clipEnabled && clip.length >= 3) img = clip.map((q) => [Number(q[0]), Number(q[1])] as [number, number]);
  else if (e.clipEnabled && clip.length === 2) {
    const [a, b] = clip; img = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]];
  } else img = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
  const pts: DxfPoint[] = img.map(([a, b]) => ({
    x: p.x + u.x * (a + 0.5) + v.x * (b + 0.5), y: p.y + u.y * (a + 0.5) + v.y * (b + 0.5), z: p.z ?? 0,
  }));
  if (pts.some((q) => !Number.isFinite(q.x) || !Number.isFinite(q.y))) { x.note("WIPEOUT (bad boundary)"); return []; }
  return [{ ...c, type: "LWPOLYLINE", points: pts, closed: true, hatch: { solid: true, loops: [pts], wipeout: true } } as DxfEntity];
}
