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
import type { DxfDocument, DxfEntity, DxfLayer, DxfPoint } from "./dxf-types";
import {
  computeExtents, ellipsePoints, evalBSpline, expandBulges, insUnitsToUnits,
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
      for (const v of vals) if (typeof v === "number" && Math.abs(v) > TWO_PI + 0.01) return true;
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

const OCS_TYPES = new Set(["CIRCLE", "ARC", "LWPOLYLINE", "POLYLINE", "POLYLINE2D", "TEXT", "ATTRIB", "ATTDEF", "INSERT", "SOLID", "TRACE"]);

function convertList(list: Any[], cx: Ctx, depth: number, insertLayer: string | null): DxfEntity[] {
  const out: DxfEntity[] = [];

  for (const e of list) {
    const type = String(e?.type ?? e?.entityType ?? "").toUpperCase();
    if (!type) continue;
    if (e.inPaperSpace === true || e.paperSpace === true) continue;

    let layer = String(pick(e, ["layer", "layerName"]) ?? "0");
    if (insertLayer && layer === "0") layer = insertLayer;
    const c = { layer, ...colorOf(e) };
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
          out.push({
            ...c, type: "TEXT", position: pos,
            height: toNum(pick(e, ["textHeight", "height", "fontSize"]), 2.5),
            value, rotation: rot,
          });
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

  const layers: DxfLayer[] = [];
  for (const l of entriesOf(db?.tables?.LAYER)) {
    const flag = toNum(pick(l, ["flag", "flags", "standardFlag"]));
    const ci = toNum(pick(l, ["colorIndex", "color"]), 7);
    layers.push({
      name: String(l?.name ?? "0"),
      color: Math.abs(ci) >= 1 && Math.abs(ci) <= 255 ? Math.abs(ci) : 7,
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
    skipped: Object.keys(skipped).length ? skipped : undefined,
  };

  const skippedText = Object.entries(skipped).map(([k, v]) => `${v}×${k}`).join(", ");
  const summary =
    `${entities.length} drawable entities on ${layers.length} layers` +
    (skippedText ? `; not drawn: ${skippedText}` : "") +
    (model.length === 0 ? "; model space was empty" : "");
  return { doc, summary };
}
