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
import type { DxfDocument, DxfEntity, DxfHatch, DxfLayer, DxfLayout, DxfPoint, DxfUnits, DxfViewport } from "./dxf-types";
import {
  arcPoints, computeExtents, ellipsePoints, evalBSpline, expandBulges,
  insUnitsToUnits, transformEntity, flipEntityX, isMirroredOcs, type InsertXform,
} from "./dxf-geometry";

interface Pair { code: number; value: string }
interface Rec { type: string; pairs: Pair[] }
interface Block { name: string; base: DxfPoint; recs: Rec[] }

/** Record types whose coordinates live in the object coordinate system (extrusion-dependent). */
const OCS_TYPES = new Set(["CIRCLE", "ARC", "LWPOLYLINE", "POLYLINE", "TEXT", "ATTRIB", "HATCH", "INSERT", "SOLID", "TRACE"]);
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

import { cleanText } from "./mtext";
export { cleanText };

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

interface Common { layer: string; color?: number; rgb?: number; lineType?: string }

function common(d: Data): Common {
  const layer = d.s(8) ?? "0";
  let color: number | undefined;
  if (d.has(62)) {
    const c = Math.abs(d.n(62));
    if (c >= 1 && c <= 255) color = c; // 0 = BYBLOCK, 256 = BYLAYER
  }
  const rgb = d.has(420) ? d.n(420) & 0xffffff : undefined;
  const lt = d.s(6)?.trim();
  const up = lt?.toUpperCase();
  const lineType = lt && up !== "BYLAYER" && up !== "BYBLOCK" && up !== "CONTINUOUS" ? lt : undefined;
  return { layer, color, rgb, lineType };
}

function headerUnits(pairs: Pair[]): DxfUnits | undefined {
  for (let i = 0; i < pairs.length - 1; i++) {
    if (pairs[i].code === 9 && pairs[i].value.trim().toUpperCase() === "$INSUNITS") {
      return insUnitsToUnits(num(pairs[i + 1].value));
    }
  }
  return undefined;
}

function headerNumber(pairs: Pair[], name: string): number | undefined {
  for (let i = 0; i < pairs.length - 1; i++) {
    if (pairs[i].code === 9 && pairs[i].value.trim().toUpperCase() === name) return num(pairs[i + 1].value, NaN);
  }
  return undefined;
}

/** HATCH record -> boundary loops + pattern info. Returns null when no loop could be read. */
export function parseHatch(P: Pair[]): DxfHatch | null {
  let i = P.findIndex((p) => p.code === 91);
  if (i < 0) return null;
  const nPaths = Math.max(0, Math.min(2000, num(P[i].value)));
  i++;
  const rd = (code: number): string | undefined => (i < P.length && P[i].code === code ? P[i++].value : undefined);
  const rn = (code: number, d = 0) => num(rd(code), d);
  const loops: DxfPoint[][] = [];
  for (let k = 0; k < nPaths && i < P.length; k++) {
    const flags = rn(92);
    const pts: DxfPoint[] = [];
    if (flags & 2) {
      const hasBulge = rn(72) !== 0, closed = rn(73) !== 0, n = Math.min(1_000_000, rn(93));
      const verts: Array<DxfPoint & { bulge?: number }> = [];
      for (let v = 0; v < n && i < P.length; v++) {
        const x = rn(10), y = rn(20); const b = hasBulge ? rn(42) : 0;
        verts.push({ x, y, z: 0, bulge: b || undefined });
      }
      pts.push(...expandBulges(verts, closed));
    } else {
      const nEdges = Math.min(1_000_000, rn(93));
      for (let e = 0; e < nEdges && i < P.length; e++) {
        const type = rn(72);
        if (type === 1) { const a = { x: rn(10), y: rn(20), z: 0 }, b = { x: rn(11), y: rn(21), z: 0 }; if (!pts.length) pts.push(a); pts.push(b); }
        else if (type === 2) {
          const cx = rn(10), cy = rn(20), r = rn(40), a0 = rn(50), a1 = rn(51), ccw = rn(73, 1) !== 0;
          const arc = ccw ? arcPoints(cx, cy, r, a0 * DEG, (a1 <= a0 ? a1 + 360 : a1) * DEG, 0) : arcPoints(cx, cy, r, a1 * DEG, (a0 <= a1 ? a0 + 360 : a0) * DEG, 0).reverse();
          pts.push(...arc);
        } else if (type === 3) {
          const c = { x: rn(10), y: rn(20), z: 0 }, m = { x: rn(11), y: rn(21), z: 0 }, ratio = rn(40, 1), a0 = rn(50), a1 = rn(51), ccw = rn(73, 1) !== 0;
          const e1 = ccw ? ellipsePoints(c, m, ratio, a0 * DEG, (a1 <= a0 ? a1 + 360 : a1) * DEG) : ellipsePoints(c, m, ratio, a1 * DEG, (a0 <= a1 ? a0 + 360 : a0) * DEG).reverse();
          pts.push(...e1);
        } else if (type === 4) {
          const degree = rn(94, 3), rational = rn(73) !== 0; rn(74);
          const nk = Math.min(100000, rn(95)), nc = Math.min(100000, rn(96));
          const knots: number[] = []; for (let q = 0; q < nk; q++) knots.push(rn(40));
          const ctrl: DxfPoint[] = []; for (let q = 0; q < nc; q++) { const x = rn(10), y = rn(20); if (rational) rn(42); ctrl.push({ x, y, z: 0 }); }
          const nf = rn(97); for (let q = 0; q < nf; q++) { rn(11); rn(21); }
          rd(12); rd(22); rd(13); rd(23);
          const curve = ctrl.length >= degree + 1 ? evalBSpline(ctrl, knots, degree) : null;
          pts.push(...(curve ?? ctrl));
        } else break;
      }
    }
    // source boundary object references
    const nSrc = rn(97); for (let q = 0; q < nSrc; q++) rd(330);
    const clean = pts.filter((p, q) => q === 0 || Math.hypot(p.x - pts[q - 1].x, p.y - pts[q - 1].y) > 1e-12);
    if (clean.length > 2 && Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].y - clean[clean.length - 1].y) < 1e-9) clean.pop();
    if (clean.length >= 3) loops.push(clean);
  }
  if (!loops.length) return null;
  const head = new Data(P.slice(0, P.findIndex((p) => p.code === 91)));
  const tail = new Data(P.slice(i));
  const solid = head.n(70) === 1;
  const pattern = head.s(2)?.trim();
  return { solid: solid || pattern?.toUpperCase() === "SOLID", pattern, angle: tail.has(52) ? tail.n(52) : 0, scale: tail.has(41) ? tail.n(41, 1) : 1, loops };
}

/** TEXT/ATTRIB anchor from the justification codes. */
function textAnchor(d: Data, vCode: number): { position: DxfPoint; align: "left" | "center" | "right"; valign: "top" | "middle" | "bottom" | "baseline" } {
  const h = d.n(72), v = d.n(vCode);
  const aligned = (h !== 0 || v !== 0) && d.has(11);
  const position = aligned ? d.pt(11, 21, 31) : d.pt(10, 20, 30);
  const align = h === 1 || h === 4 ? "center" : h === 2 ? "right" : "left";
  const valign = h === 4 ? "middle" : v === 1 ? "bottom" : v === 2 ? "middle" : v === 3 ? "top" : "baseline";
  return { position, align, valign };
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
  const paperRecs: Rec[] = [];
  const linetypes: Record<string, number[]> = {};
  const layoutNames: Array<{ name: string; order: number }> = [];
  let units: DxfUnits | undefined;
  let ltscale: number | undefined;
  let section = "";
  let table = "";
  let curBlock: Block | null = null;

  for (const r of recs) {
    if (r.type === "EOF") break;
    if (r.type === "SECTION") {
      section = r.pairs.find((p) => p.code === 2)?.value.trim() ?? "";
      if (section === "HEADER") { units = headerUnits(r.pairs); const ls = headerNumber(r.pairs, "$LTSCALE"); if (ls != null && Number.isFinite(ls) && ls > 0) ltscale = ls; }
      continue;
    }
    if (r.type === "ENDSEC") { section = ""; curBlock = null; continue; }

    if (section === "TABLES") {
      if (r.type === "TABLE") table = r.pairs.find((p) => p.code === 2)?.value.trim() ?? "";
      else if (r.type === "ENDTAB") table = "";
      else if (r.type === "LTYPE" && table === "LTYPE") {
        const d = new Data(r.pairs);
        const nm = d.s(2)?.trim().toUpperCase();
        if (nm) linetypes[nm] = d.all(49).map((v) => num(v));
      } else if (r.type === "LAYER" && table === "LAYER") {
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

    if (section === "OBJECTS") {
      if (r.type === "LAYOUT") {
        const d = new Data(r.pairs);
        const nm = d.s(1)?.trim();
        if (nm && nm.toLowerCase() !== "model") layoutNames.push({ name: nm, order: d.n(71) });
      }
      continue;
    }

    if (section === "ENTITIES") {
      const ps = r.pairs.find((p) => p.code === 67);
      if (ps && num(ps.value) === 1) paperRecs.push(r); else modelRecs.push(r);
    }
  }

  // 3. Convert (expanding blocks) into the flat entity list.
  const skipped: Record<string, number> = {};
  const skip = (t: string) => { skipped[t] = (skipped[t] ?? 0) + 1; };
  const entities = expandRecs(modelRecs, blocks, 0, skip, null);

  // 3b. Paper-space layouts: the active layout lives in ENTITIES (flag 67), the others in *Paper_Space blocks.
  const sheets: Array<{ recs: Rec[] }> = [];
  if (paperRecs.length) sheets.push({ recs: paperRecs });
  const paperBlocks = [...blocks.entries()].filter(([n]) => /^\*paper_space\d*$/i.test(n)).sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  for (const [n, b] of paperBlocks) { if (!b.recs.length) continue; if (n.toLowerCase() === "*paper_space" && paperRecs.length) continue; sheets.push({ recs: b.recs }); }
  const orderedNames = layoutNames.sort((a, b) => a.order - b.order).map((l) => l.name);
  const layouts: DxfLayout[] = [];
  for (const sh of sheets) {
    const vps: DxfViewport[] = [];
    const rest = sh.recs.filter((r) => {
      if (r.type !== "VIEWPORT") return true;
      const vd = new Data(r.pairs);
      if (vd.n(69, 2) !== 1 && vd.n(68, 1) !== 0 && vd.n(40) > 0 && vd.n(41) > 0 && vd.n(45) > 0) {
        vps.push({ center: vd.pt(10, 20, 30), width: vd.n(40), height: vd.n(41), viewCenter: vd.pt(12, 22, 0), viewHeight: vd.n(45), twist: vd.n(51) || undefined });
      }
      return false;
    });
    const ents = expandRecs(rest, blocks, 0, skip, null, true);
    if (ents.length || vps.length) layouts.push({ name: orderedNames[layouts.length] ?? `Layout ${layouts.length + 1}`, entities: ents, viewports: vps });
  }

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
    layouts: layouts.length ? layouts : undefined,
    linetypes: Object.keys(linetypes).length ? linetypes : undefined,
    ltscale,
    skipped: Object.keys(skipped).length ? skipped : undefined,
  };
}

function expandRecs(
  recs: Rec[],
  blocks: Map<string, Block>,
  depth: number,
  skip: (t: string) => void,
  insertLayer: string | null,
  allowPaper = false,
): DxfEntity[] {
  const out: DxfEntity[] = [];
  const push = (e: DxfEntity) => {
    if (out.length < MAX_ENTITIES) out.push(e);
  };

  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    const d = new Data(r.pairs);
    if (!allowPaper && d.n(67) === 1) continue; // paper space (collected separately as layouts)
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

      case "TEXT": {
        const a = textAnchor(d, 73);
        push({
          ...c, type: "TEXT", position: a.position, height: d.n(40, 2.5),
          value: cleanText(d.s(1) ?? ""), rotation: d.has(50) ? d.n(50) : undefined, align: a.align, valign: a.valign,
        });
        break;
      }

      case "ATTRIB": {
        if (d.n(70) & 1) break; // invisible attribute
        const a = textAnchor(d, 74);
        const value = cleanText(d.s(1) ?? "");
        if (value) push({ ...c, type: "TEXT", position: a.position, height: d.n(40, 2.5), value, rotation: d.has(50) ? d.n(50) : undefined, align: a.align, valign: a.valign });
        break;
      }

      case "HATCH": {
        const h = parseHatch(r.pairs);
        if (!h) { skip("HATCH"); break; }
        push({ ...c, type: "LWPOLYLINE", points: h.loops[0], closed: true, hatch: h });
        break;
      }

      case "LEADER": {
        const xs = d.all(10), pts: DxfPoint[] = xs.map((x, k) => ({ x: num(x), y: d.n(20, 0, k), z: d.n(30, 0, k) }));
        if (pts.length >= 2) push({ ...c, type: "LWPOLYLINE", points: pts, closed: false });
        else skip("LEADER");
        break;
      }

      case "MLEADER": {
        // Best effort: leader lines sit between "LEADER_LINE{" and "}" markers; text is group 304.
        let any = false, line: DxfPoint[] | null = null, textPos: DxfPoint | null = null, str = "", height = d.n(40, 2.5) || 2.5, curX: number | null = null;
        for (const p of r.pairs) {
          if (p.code === 304 && /LEADER_LINE\{/i.test(p.value)) { line = []; continue; }
          if (p.code === 305 && line) { if (line.length >= 2) { push({ ...c, type: "LWPOLYLINE", points: line, closed: false }); any = true; } line = null; continue; }
          if (p.code === 304 && !/[{}]$/.test(p.value)) { str = p.value; continue; }
          if (p.code === 12) textPos = { x: num(p.value), y: 0, z: 0 };
          else if (p.code === 22 && textPos) textPos.y = num(p.value);
          else if (p.code === 140) height = num(p.value, height) || height;
          if (line) { if (p.code === 10) curX = num(p.value); else if (p.code === 20 && curX != null) { line.push({ x: curX, y: num(p.value), z: 0 }); curX = null; } }
        }
        if (str && textPos) { push({ ...c, type: "TEXT", position: textPos, height: d.n(41, height) || height, value: cleanText(str) }); any = true; }
        if (!any) skip("MLEADER");
        break;
      }

      case "MTEXT": {
        const chunks = d.all(3).join("") + (d.s(1) ?? "");
        let rot = d.has(50) ? d.n(50) : undefined;
        if (rot === undefined && (d.has(11) || d.has(21))) rot = Math.atan2(d.n(21), d.n(11)) / DEG;
        const ap = d.n(71, 1);
        push({
          ...c, type: "TEXT", position: d.pt(10, 20, 30), height: d.n(40, 2.5),
          value: cleanText(chunks), rotation: rot,
          align: (["left", "center", "right"] as const)[Math.max(0, Math.min(2, (ap - 1) % 3))],
          valign: (["top", "middle", "bottom"] as const)[Math.max(0, Math.min(2, Math.floor((ap - 1) / 3)))],
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
      case "MLINE": case "IMAGE":
      case "WIPEOUT": case "OLE2FRAME": case "REGION": case "3DSOLID": case "BODY":
      case "RAY": case "XLINE": case "VIEWPORT":
      case "TOLERANCE": case "MESH": case "SURFACE":
        skip(r.type);
        break;

      case "ATTDEF":
        break; // attribute definitions are placeholders; the inserted ATTRIBs carry the values
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
