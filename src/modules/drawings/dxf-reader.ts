/**
 * DXF ASCII reader.
 *
 * Reads: LINE, CIRCLE, ARC, LWPOLYLINE (with bulges), POLYLINE/VERTEX,
 * TEXT, MTEXT, POINT, RAY, XLINE, SPLINE, ELLIPSE, SOLID/TRACE/3DFACE,
 * INSERT/MINSERT with nested BLOCKS, DIMENSION (through its anonymous
 * block), the layer table and the drawing units ($INSUNITS).
 *
 * Everything is flattened into the simple DxfEntity set (LINE, RAY, XLINE,
 * CIRCLE, ARC, LWPOLYLINE, TEXT, POINT) so every consumer (3D, plan, snap) handles one
 * small vocabulary. Entity types that are present but not drawn are counted
 * in `doc.skipped` so the UI can tell the user instead of failing silently.
 *
 * Pure TypeScript, no dependencies.
 */
import { lineweightFromDxf } from "./cad-styles";
import { parseWithAcadEngine } from "./acad-engine";
import type { DxfDimStyle, DxfDocument, DxfEntity, DxfHatch, DxfLayer, DxfLayout, DxfPoint, DxfTextStyle, DxfUnits, DxfViewport } from "./dxf-types";
import {
  arcPoints, computeExtents, ellipsePoints, evalBSpline, expandBulges,
  insUnitsToUnits, transformEntity, flipEntityX, isMirroredOcs, type InsertXform,
} from "./dxf-geometry";

/** IMAGEDEF handle -> file path, filled per parse (parsing is synchronous). */
let imageDefs = new Map<string, string>();
/** STYLE table by upper-case name, filled per parse. */
let textStyles = new Map<string, DxfTextStyle>();
/** DIMSTYLE table by upper-case name, filled per parse. */
let dimStyleTable: Record<string, DxfDimStyle> = {};

/** Resolve style-derived text fields for TEXT/ATTRIB/MTEXT (entity overrides win over the style). */
function textStyleFields(d: Data, mtextSrc?: string): { style?: string; font?: string; bold?: boolean; italic?: boolean; widthFactor?: number; oblique?: number } {
  const name = d.s(7)?.trim();
  const st = name ? textStyles.get(name.toUpperCase()) : undefined;
  const inl = mtextSrc !== undefined ? mtextFont(mtextSrc) : {};
  const wf = (mtextSrc === undefined && d.has(41) ? d.n(41) : undefined) ?? (mtextSrc !== undefined ? mtextWidthFactor(mtextSrc) : undefined) ?? st?.width;
  const ob = mtextSrc === undefined && d.has(51) ? d.n(51) : st?.oblique;
  const out: ReturnType<typeof textStyleFields> = {};
  if (name) out.style = name;
  const font = inl.font ?? st?.font; if (font) out.font = font;
  const bold = inl.bold ?? st?.bold; if (bold) out.bold = true;
  const italic = inl.italic ?? st?.italic; if (italic) out.italic = true;
  if (wf && Math.abs(wf - 1) > 1e-6) out.widthFactor = wf;
  if (ob && Math.abs(ob) > 1e-6) out.oblique = ob;
  return out;
}

/**
 * Text height for TEXT/ATTRIB/MTEXT: the entity's group 40, falling back to
 * the STYLE table's fixed height (group 40) when the entity says 0 — exactly
 * what DWG does for fixed-height styles.
 */
function textHeight(d: Data, code: number, fallback: number): number {
  const h = d.n(code, 0);
  if (h > 0) return h;
  const st = d.s(7)?.trim() ? textStyles.get(d.s(7)!.trim().toUpperCase()) : undefined;
  return st?.height && st.height > 0 ? st.height : fallback;
}

/** DXF group 71 text-generation flags present on a TEXT/ATTRIB entity (2 = backwards, 4 = upside down). */
function textFlags(d: Data): { backwards?: boolean; upsideDown?: boolean } {
  const f = d.n(71);
  const out: { backwards?: boolean; upsideDown?: boolean } = {};
  if ((f & 2) === 2) out.backwards = true;
  if ((f & 4) === 4) out.upsideDown = true;
  return out;
}

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

import { cleanText, mtextFont, mtextWidthFactor, mtextColor, mtextExtras } from "./mtext";
import { imageGeometry, clipBoundaryLoop, fileLabel } from "./dxf-image";
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

interface Common { layer: string; color?: number; rgb?: number; lineType?: string; lineweight?: number; ltScale?: number; transparency?: number; invisible?: boolean }

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
  const lw = d.has(370) ? lineweightFromDxf(d.n(370)) : undefined;
  const ltScale = d.has(48) && d.n(48) > 0 && Math.abs(d.n(48) - 1) > 1e-9 ? d.n(48) : undefined;
  const transparency = d.has(440) ? dxfTransparency(d.n(440)) : undefined;
  // Group 60 Invisible flag — object-level hidden state (HIDEOBJECTS / ISOLATEOBJECTS).
  const invisible = d.n(60) === 1 ? true : undefined;
  const c0: Common = { layer, color, rgb, lineType, ...(ltScale !== undefined ? { ltScale } : {}), ...(transparency ? { transparency } : {}), ...(invisible ? { invisible } : {}) };
  return lw != null ? { ...c0, lineweight: lw } : c0;
}

/** DXF group 440 transparency -> percent 0-90. Writers store (percent << 24); plain values also accepted. */
function dxfTransparency(v: number): number {
  const pct = v > 0xff ? (v >>> 24) & 0xff : v;
  if (!(pct > 0) || !Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(90, Math.round(pct)));
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
  // Pattern definition lines (78 families of 53/43/44/45/46/79 + 49 dashes),
  // written by our own editor and most native CAD files. Pattern space —
  // the hatch's own angle (52) / scale (41) still apply on top.
  let patternLines: DxfHatch["patternLines"];
  if (!solid && tail.has(78)) {
    const nFam = Math.max(0, Math.min(64, tail.n(78)));
    const dashVals = tail.all(49).map(num);
    const fams: NonNullable<DxfHatch["patternLines"]> = [];
    let di = 0;
    for (let fi = 0; fi < nFam; fi++) {
      const nDash = Math.max(0, Math.min(128, tail.n(79, 0, fi)));
      fams.push({
        angle: (tail.n(53, 0, fi) * Math.PI) / 180,
        base: [tail.n(43, 0, fi), tail.n(44, 0, fi)],
        offset: [tail.n(45, 0, fi), tail.n(46, 0, fi)],
        dashes: dashVals.slice(di, di + nDash),
      });
      di += nDash;
    }
    if (fams.length) patternLines = fams;
  }
  const hatch: DxfHatch = {
    solid: solid || pattern?.toUpperCase() === "SOLID",
    pattern,
    angle: tail.has(52) ? tail.n(52) : 0,
    scale: tail.has(41) ? tail.n(41, 1) : 1,
    loops,
    ...(patternLines ? { patternLines, patternSpace: true } : {}),
  };
  return hatch;
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

/**
 * Native dimension geometry from the DIMENSION entity's definition points —
 * used when the anonymous geometry block is missing (third-party writers).
 * Covers the types that carry the measurement in their points:
 *   0 rotated linear, 1 aligned, 4 radius, 3 diameter.
 * Style sizes come from the file's DIMSTYLE table (DIMTXT/DIMASZ/DIMEXO/
 * DIMEXE/DIMGAP × DIMSCALE) with metric defaults, like DWG's.
 */
function nativeDimension(d: Data, styles: Record<string, DxfDimStyle>): DxfEntity[] | null {
  const dimType = d.n(70, 0) & 7;
  const out: DxfEntity[] = [];
  const styleName = (d.s(3) ?? "").trim().toUpperCase();
  const st = styles[styleName];
  const dimScale = (st?.scale ?? d.n(40, 1)) || 1;
  const txtH = (st?.textHeight ?? d.n(140, 2.5)) * dimScale || 2.5 * dimScale;
  const arrowSz = (st?.arrowSize ?? d.n(41, 2.5)) * dimScale || 2.5 * dimScale;
  const extOff = (st?.extOffset ?? d.n(42, 0.625)) * dimScale;
  const extExt = (st?.extExtend ?? d.n(44, 1.25)) * dimScale;
  const gap = (st?.textGap ?? d.n(147, 0.625)) * dimScale;
  // Measurement text: decimal places (DIMDEC), suffix/prefix (DIMPOST) and the
  // linear factor (DIMLFAC) come from the style, like native CAD. An entity-level
  // override (the DIMENSION carries the group itself) wins over the style. Note
  // group 3 of a DIMENSION entity is the style NAME, never DIMPOST.
  const decimals = Math.max(0, Math.min(8, d.has(271) ? d.n(271) : st?.decimals ?? 2));
  const postFix = st?.postFix ?? "";
  const linFac = d.has(143) && d.n(143) > 0 ? d.n(143) : st?.linearFactor ?? 1;

  const arrow = (tip: DxfPoint, ux: number, uy: number): DxfEntity => {
    const tri = [
      { x: tip.x, y: tip.y, z: tip.z },
      { x: tip.x - ux * arrowSz - uy * arrowSz * 0.25, y: tip.y - uy * arrowSz + ux * arrowSz * 0.25, z: tip.z },
      { x: tip.x - ux * arrowSz + uy * arrowSz * 0.25, y: tip.y - uy * arrowSz - ux * arrowSz * 0.25, z: tip.z },
    ];
    return { type: "LWPOLYLINE", points: tri, closed: true, hatch: { solid: true, loops: [tri] } } as DxfEntity;
  };
  const line = (a: DxfPoint, b: DxfPoint): DxfEntity => ({ type: "LINE", start: a, end: b }) as DxfEntity;
  const textRot = (deg: number): number => {
    let a = ((deg % 360) + 360) % 360;
    if (a > 90 && a < 270) a += 180; // keep the measurement readable
    return a;
  };
  const measText = (m: number, prefix = ""): string => {
    const num = `${prefix}${(m * linFac).toFixed(decimals)}${postFix}`;
    const override = cleanText(d.s(1) ?? "");
    return !override || override === "<>" ? num : override.replace(/<>/g, num);
  };

  if (dimType === 0 || dimType === 1) {
    const p1 = d.pt(13, 23, 33), p2 = d.pt(14, 24, 34), dl = d.pt(10, 20, 30);
    const span = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (!(d.has(13) && d.has(14)) || span < 1e-9) return null;
    const rotDeg = dimType === 0 ? (d.has(50) ? d.n(50) : 0) : (Math.atan2(p2.y - p1.y, p2.x - p1.x) / DEG);
    const a = rotDeg * DEG;
    const ux = Math.cos(a), uy = Math.sin(a);
    // Project both origins onto the dimension line direction (through dl).
    const t1 = (p1.x - dl.x) * ux + (p1.y - dl.y) * uy;
    const t2 = (p2.x - dl.x) * ux + (p2.y - dl.y) * uy;
    const q1 = { x: dl.x + ux * t1, y: dl.y + uy * t1, z: dl.z };
    const q2 = { x: dl.x + ux * t2, y: dl.y + uy * t2, z: dl.z };
    const meas = Math.abs(t2 - t1);
    if (meas < 1e-9) return null;
    // Extension lines: origin -> dimension line, offset from the origin and past the dim line.
    for (const [p, q] of [[p1, q1], [p2, q2]] as const) {
      const ex = q.x - p.x, ey = q.y - p.y;
      const el = Math.hypot(ex, ey);
      if (el < 1e-9) continue;
      out.push(line({ x: p.x + (ex / el) * extOff, y: p.y + (ey / el) * extOff, z: p.z }, { x: q.x + (ex / el) * extExt, y: q.y + (ey / el) * extExt, z: p.z }));
    }
    out.push(line(q1, q2));
    const sgn = t2 >= t1 ? 1 : -1;
    out.push(arrow(q1, ux * sgn, uy * sgn));
    out.push(arrow(q2, -ux * sgn, -uy * sgn));
    // Text above the dim line midpoint, rotated with the dimension.
    const perpX = -uy, perpY = ux;
    const mid = { x: (q1.x + q2.x) / 2, y: (q1.y + q2.y) / 2, z: q1.z };
    const flipped = (((rotDeg % 360) + 360) % 360) > 90 && (((rotDeg % 360) + 360) % 360) < 270;
    const side = flipped ? -1 : 1;
    out.push({
      type: "TEXT", position: { x: mid.x + perpX * (txtH / 2 + gap) * side, y: mid.y + perpY * (txtH / 2 + gap) * side, z: mid.z },
      height: txtH, value: measText(meas), rotation: textRot(rotDeg), align: "center", valign: "bottom",
    } as DxfEntity);
    return out;
  }

  if (dimType === 4 || dimType === 3) {
    // Radius / diameter: center (10,20), point on the curve (15,25), leader length (40).
    const cp = d.pt(10, 20, 30), pp = d.pt(15, 25, 35);
    const r = Math.hypot(pp.x - cp.x, pp.y - cp.y);
    if (!d.has(15) || r < 1e-9) return null;
    const ux = (pp.x - cp.x) / r, uy = (pp.y - cp.y) / r;
    const meas = dimType === 3 ? r * 2 : r;
    if (dimType === 3) {
      // Diameter: line through the circle between the two opposite points.
      const a = { x: cp.x - ux * r, y: cp.y - uy * r, z: cp.z };
      const b = { x: cp.x + ux * r, y: cp.y + uy * r, z: cp.z };
      out.push(line(a, b));
      out.push(arrow(a, ux, uy));
      out.push(arrow(b, -ux, -uy));
      out.push({
        type: "TEXT", position: { x: pp.x + ux * (txtH / 2 + gap), y: pp.y + uy * (txtH / 2 + gap), z: pp.z },
        height: txtH, value: measText(meas, "⌀"), rotation: textRot(Math.atan2(uy, ux) / DEG), align: "left", valign: "bottom",
      } as DxfEntity);
    } else {
      const lead = d.n(40, 0) || arrowSz;
      const elbow = { x: pp.x + ux * lead, y: pp.y + uy * lead, z: pp.z };
      out.push(line(cp, elbow));
      out.push(arrow(pp, -ux, -uy));
      out.push({
        type: "TEXT", position: { x: elbow.x + ux * (txtH / 2 + gap), y: elbow.y + uy * (txtH / 2 + gap), z: elbow.z },
        height: txtH, value: measText(meas, "R"), rotation: textRot(Math.atan2(uy, ux) / DEG), align: "left", valign: "bottom",
      } as DxfEntity);
    }
    return out;
  }
  return null;
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
  const docTextStyles: Record<string, DxfTextStyle> = {};
  const dimStyleNames: string[] = [];
  dimStyleTable = {};
  const layoutNames: Array<{ name: string; order: number }> = [];
  let units: DxfUnits | undefined;
  let ltscale: number | undefined;
  let section = "";
  let table = "";
  let curBlock: Block | null = null;
  imageDefs = new Map();
  textStyles = new Map();

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
      } else if (r.type === "STYLE" && table === "STYLE") {
        const d = new Data(r.pairs);
        const nm = d.s(2)?.trim().toUpperCase();
        if (nm) {
          const face = d.s(1000)?.trim();
          const f71 = d.has(1071) ? d.n(1071) : 0;
          const file = d.s(3)?.trim();
          const flags = d.n(71);
          const def: DxfTextStyle = {
            font: face || file || undefined,
            ...(d.has(4) ? { bigFont: d.s(4)?.trim() || undefined } : {}),
            ...(d.has(40) && d.n(40) > 0 ? { height: d.n(40) } : {}),
            ...(d.has(41) && Math.abs(d.n(41, 1) - 1) > 1e-9 ? { width: d.n(41, 1) } : {}),
            ...(d.has(50) && Math.abs(d.n(50)) > 1e-9 ? { oblique: d.n(50) } : {}),
            bold: (f71 & 0x2000000) !== 0 || undefined,
            italic: (f71 & 0x1000000) !== 0 || undefined,
            backwards: (flags & 2) === 2 || undefined,
            upsideDown: (flags & 4) === 4 || undefined,
          };
          textStyles.set(nm, def);
          docTextStyles[nm] = def;
        }
      } else if (r.type === "DIMSTYLE" && table === "DIMSTYLE") {
        const d = new Data(r.pairs);
        const nm = d.s(2)?.trim();
        if (nm) {
          dimStyleNames.push(nm);
          // Dimension variables the native renderer needs (DXF reference):
          // DIMSCALE 40, DIMTXT 140, DIMASZ 41, DIMEXO 42, DIMEXE 44, DIMGAP 147.
          dimStyleTable[nm.toUpperCase()] = {
            ...(d.has(40) && d.n(40) !== 1 ? { scale: d.n(40) } : {}),
            ...(d.has(140) ? { textHeight: d.n(140) } : {}),
            ...(d.has(41) ? { arrowSize: d.n(41) } : {}),
            ...(d.has(42) ? { extOffset: d.n(42) } : {}),
            ...(d.has(44) ? { extExtend: d.n(44) } : {}),
            ...(d.has(147) ? { textGap: d.n(147) } : {}),
            ...(d.has(271) ? { decimals: Math.max(0, Math.min(8, d.n(271))) } : {}),
            ...(d.has(3) ? { postFix: d.s(3) } : {}),
            ...(d.has(143) && d.n(143) > 0 ? { linearFactor: d.n(143) } : {}),
          };
        }
      } else if (r.type === "LAYER" && table === "LAYER") {
        const d = new Data(r.pairs);
        const rawColor = d.n(62, 7);
        const transparency = d.has(440) ? dxfTransparency(d.n(440)) : 0;
        layers.push({
          name: d.s(2) ?? "0",
          color: Math.abs(rawColor) || 7,
          ...(d.has(420) ? { rgb: d.n(420) & 0xffffff } : {}),
          lineType: d.s(6),
          frozen: (d.n(70) & 1) === 1,
          locked: (d.n(70) & 4) === 4,
          off: rawColor < 0,
          ...(d.has(370) && lineweightFromDxf(d.n(370)) != null ? { lineweight: lineweightFromDxf(d.n(370)) } : {}),
          ...(transparency ? { transparency } : {}),
          ...(d.has(290) ? { plot: d.n(290, 1) !== 0 } : {}),
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
      if (r.type === "IMAGEDEF") {
        const d = new Data(r.pairs);
        const h = d.s(5)?.trim().toUpperCase(), p = d.s(1);
        if (h && p) imageDefs.set(h, p);
      }
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
    textStyles: Object.keys(docTextStyles).length ? docTextStyles : undefined,
    dimStyles: dimStyleNames.length ? dimStyleNames : undefined,
    dimStyleTable: Object.keys(dimStyleTable).length ? dimStyleTable : undefined,
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
          ...c, type: "TEXT", position: a.position, height: textHeight(d, 40, 2.5),
          value: cleanText(d.s(1) ?? ""), rotation: d.has(50) ? d.n(50) : undefined, align: a.align, valign: a.valign,
          ...textFlags(d),
          ...textStyleFields(d),
        });
        break;
      }

      case "ATTRIB": {
        if (d.n(70) & 1) break; // invisible attribute
        const a = textAnchor(d, 74);
        const value = cleanText(d.s(1) ?? "");
        if (value) push({ ...c, type: "TEXT", position: a.position, height: textHeight(d, 40, 2.5), value, rotation: d.has(50) ? d.n(50) : undefined, align: a.align, valign: a.valign, ...textFlags(d), ...textStyleFields(d) });
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
        if (pts.length < 2) { skip("LEADER"); break; }
        push({ ...c, type: "LWPOLYLINE", points: pts, closed: false });
        // Arrowhead at the first vertex, pointing along the first segment
        // (group 71 arrowhead flag; absent = draw it, as most files do).
        const arrowFlag = d.has(71) ? d.n(71, 1) : 1;
        const lh = d.n(41, 2.5) || 2.5;
        if (arrowFlag !== 0) {
          const a = pts[0], b = pts[1];
          const L = Math.hypot(b.x - a.x, b.y - a.y);
          if (L > 1e-9) {
            const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
            const tri = [
              { x: a.x, y: a.y, z: a.z },
              { x: a.x + ux * lh - uy * lh * 0.25, y: a.y + uy * lh + ux * lh * 0.25, z: a.z },
              { x: a.x + ux * lh + uy * lh * 0.25, y: a.y + uy * lh - ux * lh * 0.25, z: a.z },
            ];
            push({ ...c, type: "LWPOLYLINE", points: tri, closed: true, hatch: { solid: true, loops: [tri] } });
          }
        }
        // Inline annotation text (group 1) is placed past the last vertex along the last segment.
        const ltxt = cleanText(d.s(1) ?? "");
        if (ltxt) {
          const a = pts[pts.length - 2], b = pts[pts.length - 1];
          const L = Math.hypot(b.x - a.x, b.y - a.y);
          const ux = L > 1e-9 ? (b.x - a.x) / L : 1, uy = L > 1e-9 ? (b.y - a.y) / L : 0;
          push({ ...c, type: "TEXT", position: { x: b.x + ux * lh * 0.6, y: b.y + uy * lh * 0.6 + lh * 0.3, z: b.z }, height: lh, value: ltxt });
        }
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
        const col = mtextColor(chunks);
        // Native CAD wraps MTEXT at its column width (41) and honours the line-spacing
        // factor (44); the inline \C/\f codes become styled runs so notes keep their colours.
        push({
          ...c, type: "TEXT", position: d.pt(10, 20, 30), height: textHeight(d, 40, 2.5),
          value: cleanText(chunks), rotation: rot,
          align: (["left", "center", "right"] as const)[Math.max(0, Math.min(2, (ap - 1) % 3))],
          valign: (["top", "middle", "bottom"] as const)[Math.max(0, Math.min(2, Math.floor((ap - 1) / 3)))],
          ...mtextExtras(chunks, d.n(41, 0), d.n(44, 1)),
          ...(col.color != null ? { color: col.color } : {}),
          ...(col.rgb != null ? { rgb: col.rgb } : {}),
          ...textStyleFields(d, chunks),
        });
        break;
      }

      case "POINT":
        push({ ...c, type: "POINT", position: d.pt(10, 20, 30) });
        break;

      // RAY (10/20/30 start, 11/21/31 direction — one-sided infinity) and
      // XLINE (same groups — infinite both ways): construction lines drawn
      // edge-to-edge by native CAD.
      case "RAY":
      case "XLINE": {
        const start = d.pt(10, 20, 30);
        const dir = d.pt(11, 21, 31);
        if (!Number.isFinite(start.x + start.y + dir.x + dir.y) || (dir.x === 0 && dir.y === 0)) { skip(r.type); break; }
        push({ ...c, type: r.type, start, direction: dir });
        break;
      }

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
        if (blk && depth < MAX_DEPTH) {
          for (const e of expandRecs(blk.recs, blocks, depth + 1, skip, c.layer)) push(e);
          break;
        }
        // No anonymous block (written by third-party tools): compute the
        // geometry natively from the definition points, like DWG does.
        const dim = nativeDimension(d, dimStyleTable);
        if (dim) for (const e of dim) push({ ...c, ...e });
        else skip("DIMENSION");
        break;
      }

      // Present in many files but not drawn by this engine.
      case "IMAGE": case "WIPEOUT": {
        const ins = d.pt(10, 20, 30), u = d.pt(11, 21, 31), vv = d.pt(12, 22, 32);
        const pxW = d.n(13, 0), pxH = d.n(23, 0);
        const g = imageGeometry(ins, u, vv, pxW, pxH);
        if (!g) { skip(r.type); break; }
        if (r.type === "WIPEOUT") {
          const loop = clipBoundaryLoop(ins, u, vv, pxW, pxH, d.n(71, 1), d.all(14).map((x) => num(x)), d.all(24).map((x) => num(x)));
          if (!loop) { skip("WIPEOUT"); break; }
          push({ ...c, type: "LWPOLYLINE", points: loop, closed: true, hatch: { solid: true, loops: [loop], wipeout: true } });
          break;
        }
        // Raster images are external files: draw frame + diagonals + file name so the placement is visible.
        push({ ...c, type: "LWPOLYLINE", points: g.corners, closed: true });
        push({ ...c, type: "LWPOLYLINE", points: [g.corners[0], g.corners[2]] });
        push({ ...c, type: "LWPOLYLINE", points: [g.corners[1], g.corners[3]] });
        const label = fileLabel(imageDefs.get((d.s(340) ?? "").trim().toUpperCase()));
        if (label) push({ ...c, type: "TEXT", position: g.center, height: Math.max(Math.min(g.worldH / 12, g.worldW / Math.max(label.length, 4) / 0.6), 1e-6), value: label, align: "center", valign: "middle" });
        skip("IMAGE (placeholder frame; raster not embedded)");
        break;
      }
      case "MLINE":
      case "OLE2FRAME": case "REGION": case "3DSOLID": case "BODY":
      case "VIEWPORT":
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

/**
 * Parse a DXF file. Primary path: the acadrust WASM engine (native-grade
 * reading — binary DXF, R2018+, automatic code pages, failsafe recovery).
 * Falls back to the pure-TS ASCII reader when the engine artifact is not
 * available; binary DXF without the engine raises a clear error instead of
 * mojibake.
 */
export async function parseDxfFile(file: File | Blob): Promise<DxfDocument> {
  const name = file instanceof File ? file.name : "drawing.dxf";
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 22));
  const isBinary = head.startsWith(String.fromCharCode(65, 117, 116, 111, 67, 65, 68, 32, 66, 105, 110, 97, 114, 121, 32, 68, 88, 70));
  try {
    const acad = await parseWithAcadEngine(bytes, name);
    if (acad && acad.entityCount > 0) {
      acad.doc.sourceFormat = acad.format === "dwg" ? "dwg" : "dxf";
      return acad.doc;
    }
    if (acad) {
      console.warn(`[dxf-reader] acadrust read ${name} but drew nothing: ${acad.summary}`);
    }
  } catch (e) {
    console.warn(`[dxf-reader] acadrust path failed for ${name}:`, e);
  }
  if (isBinary) {
    throw new Error(
      `${name} is a binary DXF and the native CAD engine is not available. Serve public/cad-engine/obim-cad-engine.wasm or convert the file to ASCII DXF.`,
    );
  }
  return parseDxf(new TextDecoder().decode(bytes));
}

// Re-exported for tests / callers that tessellate arcs themselves.
export { arcPoints };
