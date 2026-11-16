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
}

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
  const pts = (e.vertices ?? []).map(x.pt);
  if (pts.length < 2) { x.note("MLINE (<2 vertices)"); return []; }
  x.note("MLINE (centre path only, parallel lines not drawn)");
  return [{ ...c, type: "LWPOLYLINE", points: pts, closed: false } as DxfEntity];
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
