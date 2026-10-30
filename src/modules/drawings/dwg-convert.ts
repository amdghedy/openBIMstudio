/**
 * Converts the database returned by `@mlightcad/libredwg-web`
 * (`libredwg.convert(dwg)`) into the flat DxfDocument the rest of the app uses.
 *
 * The library's typed database is "similar to @mlightcad/dxf-json". Because
 * the exact field spelling differs between versions, every read goes through
 * `pick()` with a list of accepted names, and whether angles are radians or
 * degrees is detected from the data. Nothing here throws on odd input: an
 * unreadable entity is counted in `skipped` and the rest is still returned.
 *
 * Pure TypeScript, no DOM, no THREE.
 */
import type { DxfDocument, DxfEntity, DxfHatch, DxfLayer, DxfLayout, DxfPoint, DxfViewport } from "./dxf-types";
import {
  arcPoints, computeExtents, ellipsePoints, evalBSpline, expandBulges, insUnitsToUnits,
  transformEntity, flipEntityX, isMirroredOcs, type InsertXform,
} from "./dxf-geometry";
import { cleanText } from "./dxf-reader";

type Any = Record<string, any>;
const TWO_PI = Math.PI * 2;
const DEG = Math.PI / 180;
const MAX_DEPTH = 8;

function pick(o: Any | null | undefined, names: string[]): any {
  if (!o) return undefined;
  for (const n of names) if (o[n] !== undefined && o[n] !== null) return o[n];
  return undefined;
}

function toNum(v: any, d = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : d;
}

function toPt(v: any): DxfPoint {
  if (Array.isArray(v)) return { x: toNum(v[0]), y: toNum(v[1]), z: toNum(v[2]) };
  return { x: toNum(v?.x), y: toNum(v?.y), z: toNum(v?.z) };
}

function entriesOf(table: any): Any[] {
  if (!table) return [];
  const e = table.entries ?? table;
  if (Array.isArray(e)) return e;
  if (e && typeof e === "object") return Object.values(e) as Any[];
  return [];
}

/** True when any angle in the database is clearly in degrees (> 2*PI). */
function anglesAreDegrees(entities: Any[], blocks: Map<string, Any>): boolean {
  const check = (list: Any[]): boolean => {
    for (const e of list) {
      const t = String(e?.type ?? e?.entityType ?? "").toUpperCase();
      const vals: any[] = [];
      if (t === "ARC") vals.push(pick(e, ["startAngle", "start_angle"]), pick(e, ["endAngle", "end_angle"]));
      else if (t === "INSERT" || t === "TEXT" || t === "MTEXT") vals.push(e?.rotation);
      else if (t === "ELLIPSE") vals.push(pick(e, ["startAngle", "startParameter"]), pick(e, ["endAngle", "endParameter"]));
      for (const v of vals) if (typeof v === "number" && Math.abs(v) > 2 * TWO_PI + 0.01) return true; // > two full turns in radians can only be degrees
    }
    return false;
  };
  if (check(entities)) return true;
  for (const b of blocks.values()) if (check(b.entities ?? [])) return true;
  return false;
}

interface Ctx {
  blocks: Map<string, Any>;
  /** Multiply database angles by this to get degrees. */
  toDeg: number;
  /** Multiply database angles by this to get radians. */
  toRad: number;
  /** A full turn expressed in database angle units (360 or 2*PI). */
  fullTurn: number;
  skip: (t: string) => void;
}

function colorOf(e: Any): { color?: number; rgb?: number } {
  const ci = pick(e, ["colorIndex", "aci", "colorNumber"]);
  if (typeof ci === "number" && Math.abs(ci) >= 1 && Math.abs(ci) <= 255) return { color: Math.abs(ci) };
  const c = e?.color;
  if (typeof c === "number") {
    if (c > 255) return { rgb: c & 0xffffff };
    if (c >= 1) return { color: c };
  }
  const tc = pick(e, ["trueColor", "rgb"]);
  if (typeof tc === "number" && tc > 0) return { rgb: tc & 0xffffff };
  return {};
}

const OCS_TYPES = new Set(["CIRCLE", "ARC", "LWPOLYLINE", "POLYLINE", "POLYLINE2D", "TEXT", "ATTRIB", "ATTDEF", "HATCH", "INSERT", "SOLID", "TRACE"]);

function textAlignOf(e: Any, type: string): { align: "left" | "center" | "right"; valign: "top" | "middle" | "bottom" | "baseline"; useAlignPoint: boolean; point?: DxfPoint } {
  if (type === "MTEXT") {
    const ap = toNum(pick(e, ["attachmentPoint", "attachment"]), 1);
    return {
      align: (["left", "center", "right"] as const)[Math.max(0, Math.min(2, (ap - 1) % 3))],
      valign: (["top", "middle", "bottom"] as const)[Math.max(0, Math.min(2, Math.floor((ap - 1) / 3)))],
      useAlignPoint: false,
    };
  }
  const h = toNum(pick(e, ["horizontalJustification", "horizontalAlignment", "halign", "horizJustification"]));
  const v = toNum(pick(e, ["verticalAlignment", "verticalJustification", "valign", "vertJustification"]));
  const ap = pick(e, ["endPoint", "alignmentPoint", "secondAlignmentPoint"]);
  return {
    align: h === 1 || h === 4 ? "center" : h === 2 ? "right" : "left",
    valign: h === 4 ? "middle" : v === 1 ? "bottom" : v === 2 ? "middle" : v === 3 ? "top" : "baseline",
    useAlignPoint: (h !== 0 || v !== 0) && !!ap,
    point: ap ? toPt(ap) : undefined,
  };
}

/** Best-effort HATCH conversion from a libredwg-style entity (field names vary between builds). */
function hatchOf(e: Any, cx: Ctx): DxfHatch | null {
  const paths: Any[] = pick(e, ["boundaryPaths", "paths", "loops", "boundaries"]) ?? [];
  const loops: DxfPoint[][] = [];
  for (const path of paths) {
    const pts: DxfPoint[] = [];
    const verts: Any[] | undefined = pick(path, ["polylineVertices", "vertices", "points", "polyline"]);
    if (Array.isArray(verts) && verts.length) {
      const closed = path.isClosed !== false;
      pts.push(...expandBulges(verts.map((v) => ({ ...toPt(v), bulge: toNum(v?.bulge) || undefined })), closed));
    } else {
      for (const ed of (pick(path, ["edges", "segments"]) ?? []) as Any[]) {
        const t = String(pick(ed, ["type", "edgeType"]) ?? "").toUpperCase();
        const tn = toNum(pick(ed, ["type", "edgeType"]), NaN);
        if (t === "LINE" || tn === 1) {
          const a = toPt(pick(ed, ["start", "startPoint"])), b = toPt(pick(ed, ["end", "endPoint"]));
          if (!pts.length) pts.push(a);
          pts.push(b);
        } else if (t === "ARC" || t === "CIRCULAR_ARC" || tn === 2) {
          const ctr = toPt(pick(ed, ["center", "centre"])), r = toNum(ed.radius);
          const a0 = toNum(pick(ed, ["startAngle"])) * cx.toRad, a1raw = toNum(pick(ed, ["endAngle"]), cx.fullTurn) * cx.toRad;
          const ccw = ed.isCCW !== false && ed.counterClockwise !== false && ed.isCounterClockwise !== false;
          const full = TWO_PI;
          const arc = ccw ? arcPoints(ctr.x, ctr.y, r, a0, a1raw <= a0 ? a1raw + full : a1raw, 0) : arcPoints(ctr.x, ctr.y, r, a1raw, a0 <= a1raw ? a0 + full : a0, 0).reverse();
          pts.push(...arc);
        } else if (t === "ELLIPSE" || t === "ELLIPTICAL_ARC" || tn === 3) {
          const ctr = toPt(pick(ed, ["center", "centre"])), maj = toPt(pick(ed, ["majorAxisEndPoint", "majorAxis", "endPoint"]));
          const ratio = toNum(pick(ed, ["axisRatio", "ratio", "minorToMajorRatio"]), 1);
          const a0 = toNum(pick(ed, ["startAngle"])) * cx.toRad, a1 = toNum(pick(ed, ["endAngle"]), cx.fullTurn) * cx.toRad;
          pts.push(...ellipsePoints(ctr, maj, ratio, a0, a1 <= a0 ? a1 + TWO_PI : a1));
        } else if (t === "SPLINE" || tn === 4) {
          const ctrl: DxfPoint[] = (pick(ed, ["controlPoints"]) ?? []).map(toPt);
          const knots: number[] = (pick(ed, ["knots", "knotValues"]) ?? []).map((k: any) => toNum(k));
          const deg = toNum(pick(ed, ["degree"]), 3);
          pts.push(...((ctrl.length >= deg + 1 ? evalBSpline(ctrl, knots, deg) : null) ?? ctrl));
        }
      }
    }
    const clean = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 1e-12);
    if (clean.length > 2 && Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].y - clean[clean.length - 1].y) < 1e-9) clean.pop();
    if (clean.length >= 3) loops.push(clean);
  }
  if (!loops.length) return null;
  const name = String(pick(e, ["patternName", "pattern", "name"]) ?? "").trim();
  const solid = e.isSolidFill === true || e.solidFill === true || toNum(pick(e, ["solidFill", "isSolid"])) === 1 || name.toUpperCase() === "SOLID";
  return { solid, pattern: name || undefined, angle: toNum(pick(e, ["patternAngle", "angle"])) * cx.toDeg, scale: toNum(pick(e, ["patternScale", "patternScaleOrSpacing", "scale"]), 1) || 1, loops };
}

/** LTYPE table -> dash arrays (positive dash, negative gap). */
function linetypesOf(db: Any): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const lt of entriesOf(db?.tables?.LTYPE)) {
    const name = String(lt?.name ?? "").trim().toUpperCase();
    const els: any[] = pick(lt, ["pattern", "dashes", "elements", "segments", "dashLengths"]) ?? [];
    const arr = els.map((x) => (typeof x === "number" ? x : toNum(pick(x, ["dashLength", "length", "value"])))).filter((n) => Number.isFinite(n));
    if (name && arr.length) out[name] = arr;
  }
  return out;
}

function viewportOf(e: Any): DxfViewport | null {
  const centre = pick(e, ["viewportCenter", "centerPoint", "center", "position"]);
  const width = toNum(pick(e, ["viewportWidth", "width"])), height = toNum(pick(e, ["viewportHeight", "height"]));
  const vh = toNum(pick(e, ["viewHeight", "modelViewHeight"]));
  if (!centre || width <= 0 || height <= 0 || vh <= 0) return null;
  if (toNum(pick(e, ["viewportId", "id"]), 2) === 1) return null; // overall paper viewport
  return { center: toPt(centre), width, height, viewCenter: toPt(pick(e, ["viewCenter", "viewCenterPoint", "viewTarget"])), viewHeight: vh, twist: toNum(pick(e, ["twistAngle", "viewTwistAngle"])) || undefined };
}

function convertList(list: Any[], cx: Ctx, depth: number, insertLayer: string | null): DxfEntity[] {
  const out: DxfEntity[] = [];

  for (const e of list) {
    const type = String(e?.type ?? e?.entityType ?? "").toUpperCase();
    if (!type) continue;
    if (e.inPaperSpace === true || e.paperSpace === true) continue;

    let layer = String(pick(e, ["layer", "layerName"]) ?? "0");
    if (insertLayer && layer === "0") layer = insertLayer;
    const ltRaw = pick(e, ["lineType", "lineTypeName", "linetype", "ltype"]);
    const ltName = typeof ltRaw === "string" ? ltRaw.trim() : "";
    const ltUp = ltName.toUpperCase();
    const c = { layer, ...colorOf(e), ...(ltName && ltUp !== "BYLAYER" && ltUp !== "BYBLOCK" && ltUp !== "CONTINUOUS" ? { lineType: ltName } : {}) };
    const outStart = out.length;
    const exRaw = pick(e, ["extrusionDirection", "extrusion", "normal"]);
    const ex = exRaw ? toPt(exRaw) : null;
    const ocsFlip = !!ex && OCS_TYPES.has(type) && isMirroredOcs(ex.x, ex.y, ex.z ?? 1);

    try {
      switch (type) {
        case "LINE":
          out.push({
            ...c, type: "LINE",
            start: toPt(pick(e, ["startPoint", "start", "p1"])),
            end: toPt(pick(e, ["endPoint", "end", "p2"])),
          });
          break;

        case "CIRCLE":
          out.push({ ...c, type: "CIRCLE", center: toPt(e.center), radius: toNum(e.radius) });
          break;

        case "ARC":
          out.push({
            ...c, type: "ARC", center: toPt(e.center), radius: toNum(e.radius),
            startAngle: toNum(pick(e, ["startAngle", "start_angle"])) * cx.toDeg,
            endAngle: toNum(pick(e, ["endAngle", "end_angle"]), cx.fullTurn) * cx.toDeg,
          });
          break;

        case "LWPOLYLINE":
        case "POLYLINE":
        case "POLYLINE2D":
        case "POLYLINE3D": {
          const raw: Any[] = pick(e, ["vertices", "points"]) ?? [];
          const flag = toNum(pick(e, ["flag", "flags"]));
          const closed = e.closed === true || e.isClosed === true || (flag & 1) === 1;
          const verts = raw
            .filter((v) => !(toNum(v?.flag ?? v?.flags) & 16)) // spline-frame points
            .map((v) => ({ ...toPt(v), bulge: toNum(v?.bulge) || undefined }));
          if (verts.length >= 2) out.push({ ...c, type: "LWPOLYLINE", points: expandBulges(verts, closed), closed });
          break;
        }

        case "TEXT":
        case "MTEXT":
        case "ATTRIB":
        case "ATTDEF": {
          const pos = toPt(pick(e, ["startPoint", "insertionPoint", "position", "insertPoint"]));
          const value = cleanText(String(pick(e, ["text", "textString", "value", "contents"]) ?? ""));
          if (!value) break;
          let rot = e.rotation !== undefined ? toNum(e.rotation) * cx.toDeg : undefined;
          const dir = pick(e, ["directionVector", "xAxisDirection"]);
          if (rot === undefined && dir) rot = Math.atan2(toNum(dir.y), toNum(dir.x)) / DEG;
          if (type === "ATTDEF") break; // placeholder; inserted ATTRIBs carry the value
          if (type === "ATTRIB" && (e.invisible === true || (toNum(pick(e, ["flag", "flags", "attributeFlags"])) & 1) === 1)) break;
          const al = textAlignOf(e, type);
          out.push({
            ...c, type: "TEXT", position: al.useAlignPoint ? al.point! : pos,
            height: toNum(pick(e, ["textHeight", "height", "fontSize"]), 2.5),
            value, rotation: rot, align: al.align, valign: al.valign,
            ...dwgTextStyle(e, cx),
          });
          break;
        }

        case "HATCH": {
          const h = hatchOf(e, cx);
          if (!h) { cx.skip("HATCH"); break; }
          out.push({ ...c, type: "LWPOLYLINE", points: h.loops[0], closed: true, hatch: h });
          break;
        }

        case "LEADER": {
          const pts: DxfPoint[] = (pick(e, ["vertices", "points"]) ?? []).map(toPt);
          if (pts.length >= 2) out.push({ ...c, type: "LWPOLYLINE", points: pts, closed: false });
          else cx.skip("LEADER");
          break;
        }

        case "MLEADER": case "MULTILEADER": {
          let any = false;
          const lines: Any[] = pick(e, ["leaderLines", "leaders", "leaderLineArray"]) ?? [];
          for (const ln of lines) {
            const pts: DxfPoint[] = (pick(ln, ["vertices", "points", "lineVertices"]) ?? []).map(toPt);
            if (pts.length >= 2) { out.push({ ...c, type: "LWPOLYLINE", points: pts, closed: false }); any = true; }
          }
          const txt = cleanText(String(pick(e, ["text", "contents", "textContent", "mtext"]) ?? ""));
          const tp = pick(e, ["textLocation", "textPosition", "contentBasePoint", "position"]);
          if (txt && tp) { out.push({ ...c, type: "TEXT", position: toPt(tp), height: toNum(pick(e, ["textHeight", "height"]), 2.5), value: txt }); any = true; }
          if (!any) cx.skip("MLEADER");
          break;
        }

        case "POINT":
          out.push({ ...c, type: "POINT", position: toPt(pick(e, ["position", "point", "location"])) });
          break;

        case "SPLINE": {
          const ctrl: DxfPoint[] = (pick(e, ["controlPoints"]) ?? []).map(toPt);
          const fit: DxfPoint[] = (pick(e, ["fitPoints"]) ?? []).map(toPt);
          const knots: number[] = (pick(e, ["knots", "knotValues"]) ?? []).map((k: any) => toNum(k));
          const degree = toNum(pick(e, ["degree", "degreeOfSplineCurve"]), 3);
          const closed = e.closed === true || (toNum(pick(e, ["flag", "flags"])) & 1) === 1;
          let pts: DxfPoint[] | null = ctrl.length >= degree + 1 ? evalBSpline(ctrl, knots, degree) : null;
          if (!pts) pts = fit.length >= 2 ? fit : ctrl;
          if (pts.length >= 2) out.push({ ...c, type: "LWPOLYLINE", points: pts, closed });
          break;
        }

        case "ELLIPSE": {
          const t0 = toNum(pick(e, ["startAngle", "startParameter"])) * cx.toRad;
          const t1 = toNum(pick(e, ["endAngle", "endParameter"]), TWO_PI / cx.toRad) * cx.toRad;
          const pts = ellipsePoints(
            toPt(e.center), toPt(pick(e, ["majorAxisEndPoint", "majorAxis"])),
            toNum(pick(e, ["axisRatio", "ratio", "minorToMajorRatio"]), 1), t0, t1,
          );
          out.push({ ...c, type: "LWPOLYLINE", points: pts, closed: Math.abs(t1 - t0 - TWO_PI) < 1e-6 });
          break;
        }

        case "SOLID":
        case "TRACE":
        case "3DFACE": {
          const pts: DxfPoint[] = (pick(e, ["points", "corners"]) ??
            [e.corner1 ?? e.firstCorner, e.corner2 ?? e.secondCorner, e.corner3 ?? e.thirdCorner, e.corner4 ?? e.fourthCorner]
          ).filter(Boolean).map(toPt);
          if (pts.length >= 3) {
            const ring = type === "3DFACE" || pts.length < 4 ? pts : [pts[0], pts[1], pts[3], pts[2]];
            out.push({ ...c, type: "LWPOLYLINE", points: ring, closed: true });
          }
          break;
        }

        case "INSERT": {
          const name = String(e.name ?? e.blockName ?? "");
          const blk = cx.blocks.get(name);
          if (!blk || depth >= MAX_DEPTH) { cx.skip(blk ? "INSERT (too deeply nested)" : "INSERT (missing block)"); break; }
          const inner = convertList(blk.entities ?? [], cx, depth + 1, layer);
          const cols = Math.max(1, Math.min(500, Math.round(toNum(pick(e, ["columnCount", "columns"]), 1))));
          const rows = Math.max(1, Math.min(500, Math.round(toNum(pick(e, ["rowCount", "rows"]), 1))));
          const dc = toNum(pick(e, ["columnSpacing"])), dr = toNum(pick(e, ["rowSpacing"]));
          const ins = toPt(pick(e, ["insertionPoint", "position", "insertPoint"]));
          const rotDeg = toNum(e.rotation) * cx.toDeg;
          const a = rotDeg * DEG;
          for (let rr = 0; rr < rows; rr++) {
            for (let cc = 0; cc < cols; cc++) {
              const ox = cc * dc, oy = rr * dr;
              const xf: InsertXform = {
                sx: toNum(pick(e, ["xScale", "scaleX"]), 1),
                sy: toNum(pick(e, ["yScale", "scaleY"]), 1),
                sz: toNum(pick(e, ["zScale", "scaleZ"]), 1),
                rot: rotDeg,
                base: toPt(pick(blk, ["basePoint", "origin", "position"])),
                ins: {
                  x: ins.x + ox * Math.cos(a) - oy * Math.sin(a),
                  y: ins.y + ox * Math.sin(a) + oy * Math.cos(a),
                  z: ins.z,
                },
              };
              for (const ent of inner) out.push(...transformEntity(ent, xf));
            }
          }
          break;
        }

        case "DIMENSION": {
          const blk = cx.blocks.get(String(e.name ?? e.blockName ?? ""));
          if (blk && depth < MAX_DEPTH) out.push(...convertList(blk.entities ?? [], cx, depth + 1, layer));
          else cx.skip("DIMENSION");
          break;
        }

        default:
          cx.skip(type);
      }
      if (ocsFlip) for (let k = outStart; k < out.length; k++) out[k] = flipEntityX(out[k]);
    } catch {
      cx.skip(`${type} (unreadable)`);
    }
  }
  return out;
}

export interface DwgConvertResult {
  doc: DxfDocument;
  /** Short human summary for logs / toasts. */
  summary: string;
}

/** Convert a libredwg-web database into a DxfDocument. */
/** Best-effort text style fields from a libredwg text entity (names vary by build; unknown -> omitted). */
function dwgTextStyle(e: Any, cx: { toDeg: number }): { style?: string; widthFactor?: number; oblique?: number } {
  const out: { style?: string; widthFactor?: number; oblique?: number } = {};
  const st = pick(e, ["styleName", "style"]);
  if (typeof st === "string" && st.trim()) out.style = st.trim();
  const wf = toNum(pick(e, ["widthFactor", "widthScale", "xScale"]));
  if (wf > 0 && Math.abs(wf - 1) > 1e-6) out.widthFactor = wf;
  const ob = toNum(pick(e, ["obliqueAngle", "oblique"])) * cx.toDeg;
  if (Number.isFinite(ob) && Math.abs(ob) > 1e-6) out.oblique = ob;
  return out;
}

export function dwgDatabaseToDxfDocument(db: Any): DwgConvertResult {
  const blocks = new Map<string, Any>();
  for (const b of entriesOf(db?.tables?.BLOCK_RECORD ?? db?.blocks)) {
    const n = String(b?.name ?? "");
    if (n) blocks.set(n, b);
  }

  let model: Any[] = Array.isArray(db?.entities) ? db.entities : [];
  if (!model.length) {
    for (const key of ["*Model_Space", "*MODEL_SPACE", "*model_space"]) {
      const m = blocks.get(key);
      if (m?.entities?.length) { model = m.entities; break; }
    }
  }

  // Paper-space entities (flagged on the entity, or held in *Paper_Space blocks) become layouts.
  const isPaper = (e: Any) => e?.inPaperSpace === true || e?.paperSpace === true;
  const paperLists: Any[][] = [];
  const paperFlagged = model.filter(isPaper);
  if (paperFlagged.length) paperLists.push(paperFlagged);
  for (const [n, b] of [...blocks.entries()].sort(([a], [c]) => a.localeCompare(c, undefined, { numeric: true }))) {
    if (!/^\*paper_space\d*$/i.test(n) || !b?.entities?.length) continue;
    if (n.toLowerCase() === "*paper_space" && paperFlagged.length) continue;
    paperLists.push(b.entities);
  }
  const skipped: Record<string, number> = {};
  const skip = (t: string) => { skipped[t] = (skipped[t] ?? 0) + 1; };
  const deg = anglesAreDegrees(model, blocks);
  // Radians -> degrees is * (180 / PI) = * (1 / DEG).
  const cx: Ctx = {
    blocks, skip,
    toDeg: deg ? 1 : 1 / DEG,
    toRad: deg ? DEG : 1,
    fullTurn: deg ? 360 : TWO_PI,
  };

  const entities = convertList(model, cx, 0, null);

  const layouts: DxfLayout[] = [];
  for (const list of paperLists) {
    const vps: DxfViewport[] = [];
    const rest = list.filter((e) => {
      if (String(e?.type ?? "").toUpperCase() !== "VIEWPORT") return true;
      const vp = viewportOf(e); if (vp) vps.push(vp);
      return false;
    }).map((e) => (isPaper(e) ? { ...e, inPaperSpace: false, paperSpace: false } : e));
    const ents = convertList(rest, cx, 0, null);
    if (ents.length || vps.length) layouts.push({ name: `Layout ${layouts.length + 1}`, entities: ents, viewports: vps });
  }

  const layers: DxfLayer[] = [];
  for (const l of entriesOf(db?.tables?.LAYER)) {
    const flag = toNum(pick(l, ["flag", "flags", "standardFlag"]));
    const ci = toNum(pick(l, ["colorIndex", "color"]), 7);
    layers.push({
      name: String(l?.name ?? "0"),
      color: Math.abs(ci) >= 1 && Math.abs(ci) <= 255 ? Math.abs(ci) : 7,
      lineType: typeof pick(l, ["lineType", "lineTypeName"]) === "string" ? String(pick(l, ["lineType", "lineTypeName"])) : undefined,
      frozen: l?.frozen === true || (flag & 1) === 1,
      locked: l?.locked === true || (flag & 4) === 4,
      off: l?.off === true || l?.visible === false || ci < 0,
    });
  }
  if (!layers.some((l) => l.name === "0")) layers.unshift({ name: "0", color: 7 });
  const known = new Set(layers.map((l) => l.name));
  for (const e of entities) {
    if (!known.has(e.layer)) { known.add(e.layer); layers.push({ name: e.layer, color: 7 }); }
  }

  const insUnits = db?.header?.INSUNITS ?? db?.header?.$INSUNITS ?? db?.header?.insUnits;
  const doc: DxfDocument = {
    layers,
    entities,
    extents: computeExtents(entities),
    units: insUnitsToUnits(toNum(insUnits)),
    sourceFormat: "dwg",
    layouts: layouts.length ? layouts : undefined,
    linetypes: Object.keys(linetypesOf(db)).length ? linetypesOf(db) : undefined,
    ltscale: toNum(db?.header?.LTSCALE ?? db?.header?.$LTSCALE, 0) > 0 ? toNum(db?.header?.LTSCALE ?? db?.header?.$LTSCALE) : undefined,
    skipped: Object.keys(skipped).length ? skipped : undefined,
  };

  const skippedText = Object.entries(skipped).map(([k, v]) => `${v}×${k}`).join(", ");
  const summary =
    `${entities.length} drawable entities on ${layers.length} layers` +
    (skippedText ? `; not drawn: ${skippedText}` : "") +
    (model.length === 0 ? "; model space was empty" : "");
  return { doc, summary };
}
