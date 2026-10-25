/**
 * DXF ASCII reader.
 *
 * Reads: LINE, CIRCLE, ARC, LWPOLYLINE (with bulges), POLYLINE/VERTEX,
 * TEXT, MTEXT, POINT, SPLINE, ELLIPSE, SOLID/TRACE/3DFACE, INSERT/MINSERT
 * with nested BLOCKS, DIMENSION (through its anonymous block), the layer
 * table and the drawing units ($INSUNITS).
 *
 * Everything is flattened into the simple DxfEntity set (LINE, CIRCLE, ARC,
 * LWPOLYLINE, TEXT, POINT) so every consumer (3D, plan, snap) handles one
 * small vocabulary. Entity types that are present but not drawn are counted
 * in `doc.skipped` so the UI can tell the user instead of failing silently.
 *
 * Pure TypeScript, no dependencies.
 */
import type { DxfDocument, DxfEntity, DxfLayer, DxfPoint, DxfUnits } from "./dxf-types";
import {
  arcPoints, computeExtents, ellipsePoints, evalBSpline, expandBulges,
  insUnitsToUnits, transformEntity, flipEntityX, isMirroredOcs, type InsertXform,
} from "./dxf-geometry";

interface Pair { code: number; value: string }
interface Rec { type: string; pairs: Pair[] }
interface Block { name: string; base: DxfPoint; recs: Rec[] }

/** Record types whose coordinates live in the object coordinate system (extrusion-dependent). */
const OCS_TYPES = new Set(["CIRCLE", "ARC", "LWPOLYLINE", "POLYLINE", "TEXT", "INSERT", "SOLID", "TRACE"]);
const DEG = Math.PI / 180;
const MAX_DEPTH = 8;
const MAX_ENTITIES = 3_000_000;

function tokenize(text: string): Pair[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = src.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const pairs: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isFinite(code)) continue;
    pairs.push({ code, value: (lines[i + 1] ?? "").trimEnd() });
  }
  return pairs;
}

function num(v: string | undefined, d = 0): number {
  if (v == null) return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** Strip MTEXT / TEXT formatting codes down to readable text. */
export function cleanText(s: string): string {
  return s
    .replace(/\\[Pp]/g, " ")
    .replace(/\\~/g, " ")
    .replace(/\\[A-Za-z][^;\\]*;/g, "")
    .replace(/\\([\\{}])/g, "$1")
    .replace(/[{}]/g, "")
    .replace(/%%[cC]/g, "Ø")
    .replace(/%%[dD]/g, "°")
    .replace(/%%[pP]/g, "±")
    .trim();
}

class Data {
  private m = new Map<number, string[]>();
  constructor(pairs: Pair[]) {
    for (const p of pairs) {
      const a = this.m.get(p.code);
      if (a) a.push(p.value); else this.m.set(p.code, [p.value]);
    }
  }
  s(code: number, idx = 0): string | undefined { return this.m.get(code)?.[idx]; }
  n(code: number, d = 0, idx = 0): number { return num(this.s(code, idx), d); }
  all(code: number): string[] { return this.m.get(code) ?? []; }
  has(code: number): boolean { return this.m.has(code); }
  pt(cx: number, cy: number, cz: number, idx = 0): DxfPoint {
    return { x: this.n(cx, 0, idx), y: this.n(cy, 0, idx), z: this.n(cz, 0, idx) };
  }
}

interface Common { layer: string; color?: number; rgb?: number }

function common(d: Data): Common {
  const layer = d.s(8) ?? "0";
  let color: number | undefined;
  if (d.has(62)) {
    const c = Math.abs(d.n(62));
    if (c >= 1 && c <= 255) color = c; // 0 = BYBLOCK, 256 = BYLAYER
  }
  const rgb = d.has(420) ? d.n(420) & 0xffffff : undefined;
  return { layer, color, rgb };
}

function headerUnits(pairs: Pair[]): DxfUnits | undefined {
  for (let i = 0; i < pairs.length - 1; i++) {
    if (pairs[i].code === 9 && pairs[i].value.trim().toUpperCase() === "$INSUNITS") {
      return insUnitsToUnits(num(pairs[i + 1].value));
    }
  }
  return undefined;
}

export function parseDxf(text: string): DxfDocument {
  const pairs = tokenize(text);

  // 1. Split into records (every code 0 starts one).
  const recs: Rec[] = [];
  let cur: Rec | null = null;
  for (const p of pairs) {
    if (p.code === 0) { cur = { type: p.value.trim(), pairs: [] }; recs.push(cur); }
    else if (cur) cur.pairs.push(p);
  }

  // 2. Sort records into header / layers / blocks / model space.
  const layers: DxfLayer[] = [];
  const blocks = new Map<string, Block>();
  const modelRecs: Rec[] = [];
  let units: DxfUnits | undefined;
  let section = "";
  let table = "";
  let curBlock: Block | null = null;

  for (const r of recs) {
    if (r.type === "EOF") break;
    if (r.type === "SECTION") {
      section = r.pairs.find((p) => p.code === 2)?.value.trim() ?? "";
      if (section === "HEADER") units = headerUnits(r.pairs);
      continue;
    }
    if (r.type === "ENDSEC") { section = ""; curBlock = null; continue; }

    if (section === "TABLES") {
      if (r.type === "TABLE") table = r.pairs.find((p) => p.code === 2)?.value.trim() ?? "";
      else if (r.type === "ENDTAB") table = "";
      else if (r.type === "LAYER" && table === "LAYER") {
        const d = new Data(r.pairs);
        const rawColor = d.n(62, 7);
        layers.push({
          name: d.s(2) ?? "0",
          color: Math.abs(rawColor) || 7,
          lineType: d.s(6),
          frozen: (d.n(70) & 1) === 1,
          locked: (d.n(70) & 4) === 4,
          off: rawColor < 0,
        });
      }
      continue;
    }

    if (section === "BLOCKS") {
      if (r.type === "BLOCK") {
        const d = new Data(r.pairs);
        const name = d.s(2) ?? "";
        curBlock = { name, base: d.pt(10, 20, 30), recs: [] };
        blocks.set(name, curBlock);
      } else if (r.type === "ENDBLK") curBlock = null;
      else curBlock?.recs.push(r);
      continue;
    }

    if (section === "ENTITIES") modelRecs.push(r);
  }

  // 3. Convert (expanding blocks) into the flat entity list.
  const skipped: Record<string, number> = {};
  const skip = (t: string) => { skipped[t] = (skipped[t] ?? 0) + 1; };
  const entities = expandRecs(modelRecs, blocks, 0, skip, null);

  if (!layers.some((l) => l.name === "0")) layers.unshift({ name: "0", color: 7 });
  // Layers used by entities but missing from the table still need an entry.
  const known = new Set(layers.map((l) => l.name));
  for (const e of entities) {
    if (!known.has(e.layer)) { known.add(e.layer); layers.push({ name: e.layer, color: 7 }); }
  }

  return {
    layers,
    entities,
    extents: computeExtents(entities),
    units: units ?? "unitless",
    sourceFormat: "dxf",
    skipped: Object.keys(skipped).length ? skipped : undefined,
  };
}

function expandRecs(
  recs: Rec[],
  blocks: Map<string, Block>,
  depth: number,
  skip: (t: string) => void,
  insertLayer: string | null,
): DxfEntity[] {
  const out: DxfEntity[] = [];
  const push = (e: DxfEntity) => {
    if (out.length < MAX_ENTITIES) out.push(e);
  };

  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const d = new Data(r.pairs);
    if (d.n(67) === 1) continue; // paper space
    const c = common(d);
    if (insertLayer && c.layer === "0") c.layer = insertLayer; // layer 0 inside a block inherits
    const outStart = out.length;
    const ocsFlip = OCS_TYPES.has(r.type) && isMirroredOcs(d.n(210), d.n(220), d.n(230, 1));

    switch (r.type) {
      case "LINE":
        push({ ...c, type: "LINE", start: d.pt(10, 20, 30), end: d.pt(11, 21, 31) });
        break;

      case "CIRCLE":
        push({ ...c, type: "CIRCLE", center: d.pt(10, 20, 30), radius: d.n(40) });
        break;

      case "ARC":
        push({
          ...c, type: "ARC", center: d.pt(10, 20, 30), radius: d.n(40),
          startAngle: d.n(50), endAngle: d.n(51, 360),
        });
        break;

      case "LWPOLYLINE": {
        const verts: Array<DxfPoint & { bulge?: number }> = [];
        for (const p of r.pairs) {
          if (p.code === 10) verts.push({ x: num(p.value), y: 0, z: d.n(38) });
          else if (p.code === 20 && verts.length) verts[verts.length - 1].y = num(p.value);
          else if (p.code === 42 && verts.length) verts[verts.length - 1].bulge = num(p.value);
        }
        const closed = (d.n(70) & 1) === 1;
        if (verts.length >= 2) push({ ...c, type: "LWPOLYLINE", points: expandBulges(verts, closed), closed });
        break;
      }

      case "POLYLINE": {
        const flags = d.n(70);
        const verts: Array<DxfPoint & { bulge?: number }> = [];
        let j = i + 1;
        for (; j < recs.length && recs[j].type !== "SEQEND"; j++) {
          if (recs[j].type !== "VERTEX") continue;
          const vd = new Data(recs[j].pairs);
          const vf = vd.n(70);
          if (vf & 16) continue; // spline-frame control point
          if (vf & 128) continue; // polyface vertex/face record
          verts.push({ ...vd.pt(10, 20, 30), bulge: vd.n(42) || undefined });
        }
        i = j; // skip VERTEX records and SEQEND
        if (flags & (16 | 64)) { skip("POLYLINE (mesh)"); break; }
        const closed = (flags & 1) === 1;
        if (verts.length >= 2) push({ ...c, type: "LWPOLYLINE", points: expandBulges(verts, closed), closed });
        break;
      }

      case "TEXT":
        push({
          ...c, type: "TEXT", position: d.pt(10, 20, 30), height: d.n(40, 2.5),
          value: cleanText(d.s(1) ?? ""), rotation: d.has(50) ? d.n(50) : undefined,
        });
        break;

      case "MTEXT": {
        const chunks = d.all(3).join("") + (d.s(1) ?? "");
        let rot = d.has(50) ? d.n(50) : undefined;
        if (rot === undefined && (d.has(11) || d.has(21))) rot = Math.atan2(d.n(21), d.n(11)) / DEG;
        push({
          ...c, type: "TEXT", position: d.pt(10, 20, 30), height: d.n(40, 2.5),
          value: cleanText(chunks), rotation: rot,
        });
        break;
      }

      case "POINT":
        push({ ...c, type: "POINT", position: d.pt(10, 20, 30) });
        break;

      case "SPLINE": {
        const closed = (d.n(70) & 1) === 1;
        const degree = d.n(71, 3);
        const ctrl: DxfPoint[] = d.all(10).map((x, k) => ({ x: num(x), y: d.n(20, 0, k), z: d.n(30, 0, k) }));
        const fit: DxfPoint[] = d.all(11).map((x, k) => ({ x: num(x), y: d.n(21, 0, k), z: d.n(31, 0, k) }));
        const knots = d.all(40).map((k) => num(k));
        let pts: DxfPoint[] | null = null;
        if (ctrl.length >= degree + 1) pts = evalBSpline(ctrl, knots, degree);
        if (!pts) pts = fit.length >= 2 ? fit : ctrl;
        if (pts.length >= 2) push({ ...c, type: "LWPOLYLINE", points: pts, closed });
        break;
      }

      case "ELLIPSE": {
        const full = Math.PI * 2;
        const t0 = d.n(41, 0);
        const t1 = d.n(42, full);
        const pts = ellipsePoints(d.pt(10, 20, 30), d.pt(11, 21, 31), d.n(40, 1), t0, t1);
        push({ ...c, type: "LWPOLYLINE", points: pts, closed: Math.abs(t1 - t0 - full) < 1e-6 });
        break;
      }

      case "SOLID":
      case "TRACE":
      case "3DFACE": {
        // SOLID/TRACE store corners 1,2,4,3; 3DFACE stores 1,2,3,4.
        const p1 = d.pt(10, 20, 30), p2 = d.pt(11, 21, 31);
        const p3 = d.pt(12, 22, 32), p4 = d.has(13) ? d.pt(13, 23, 33) : p3;
        const ring = r.type === "3DFACE" ? [p1, p2, p3, p4] : [p1, p2, p4, p3];
        const dedup = ring.filter((p, k) => k === 0 || Math.hypot(p.x - ring[k - 1].x, p.y - ring[k - 1].y) > 1e-12);
        push({ ...c, type: "LWPOLYLINE", points: dedup, closed: true });
        break;
      }

      case "INSERT": {
        const name = d.s(2) ?? "";
        const blk = blocks.get(name);
        if (!blk || depth >= MAX_DEPTH) { skip(blk ? "INSERT (too deeply nested)" : "INSERT (missing block)"); break; }
        const inner = expandRecs(blk.recs, blocks, depth + 1, skip, c.layer);
        const cols = Math.max(1, Math.min(500, Math.round(d.n(70, 1))));
        const rows = Math.max(1, Math.min(500, Math.round(d.n(71, 1))));
        const dc = d.n(44), dr = d.n(45);
        const ins = d.pt(10, 20, 30);
        for (let rr = 0; rr < rows; rr++) {
          for (let cc = 0; cc < cols; cc++) {
            // Array offsets are in the insert's rotated frame.
            const a = d.n(50) * DEG;
            const ox = cc * dc, oy = rr * dr;
            const xf: InsertXform = {
              sx: d.n(41, 1), sy: d.n(42, 1), sz: d.n(43, 1), rot: d.n(50), base: blk.base,
              ins: {
                x: ins.x + ox * Math.cos(a) - oy * Math.sin(a),
                y: ins.y + ox * Math.sin(a) + oy * Math.cos(a),
                z: ins.z,
              },
            };
            for (const e of inner) for (const t of transformEntity(e, xf)) push(t);
          }
        }
        break;
      }

      case "DIMENSION": {
        // The drawn dimension (lines, arrows, text) lives in an anonymous block.
        const blk = blocks.get(d.s(2) ?? "");
        if (!blk || depth >= MAX_DEPTH) { skip("DIMENSION"); break; }
        for (const e of expandRecs(blk.recs, blocks, depth + 1, skip, c.layer)) push(e);
        break;
      }

      // Present in many files but not drawn by this engine.
      case "HATCH": case "LEADER": case "MLEADER": case "MLINE": case "IMAGE":
      case "WIPEOUT": case "OLE2FRAME": case "REGION": case "3DSOLID": case "BODY":
      case "RAY": case "XLINE": case "ATTRIB": case "ATTDEF": case "VIEWPORT":
      case "TOLERANCE": case "MESH": case "SURFACE":
        skip(r.type);
        break;

      default:
        break; // unknown/structural records are ignored
    }
    if (ocsFlip) for (let k = outStart; k < out.length; k++) out[k] = flipEntityX(out[k]);
  }
  return out;
}

export async function parseDxfFile(file: File | Blob): Promise<DxfDocument> {
  return parseDxf(await file.text());
}

// Re-exported for tests / callers that tessellate arcs themselves.
export { arcPoints };
