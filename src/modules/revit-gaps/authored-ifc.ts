/**
 * IFC export of the AUTHORED model (walls, slabs, columns, beams, doors,
 * windows, MEP runs, native twins) and rooms -> IfcSpace.
 *
 * Pure TypeScript: no three.js, no DOM, no project imports - it takes plain
 * data and returns the STEP text, so it can be unit-tested in Node.
 *
 * Coordinates
 *   Authored plan coordinates are (x, z) with Y up (three.js). IFC is Z up,
 *   so IFC (X, Y, Z) = (x, -z, y). That is a proper rotation (det = +1), so
 *   triangle winding and handedness are preserved.
 *
 * Schemas
 *   IFC4 (default) and IFC2X3. Revit 2020 reads IFC2X3 everywhere; use that
 *   when an IFC4 file is rejected.
 *
 * What is exported analytically (extruded solids, so Revit/BIM tools can edit
 * them): wall, slab/roof/ceiling polygons, column, footing, beam, brace,
 * duct / pipe / cable-tray / conduit, door + window (with real openings in the
 * host wall), equipment (box proxy), rooms (IfcSpace). Native twins are
 * written as tessellated geometry. Anything else is reported in
 * `stats.skipped` instead of being silently dropped.
 */
import { stableIfcGuid, isValidIfcGuid } from "./ifc-guid";
import { buildElementGeo, m2Quantities } from "./m2-geometry";

export type Vec2 = [number, number];
export type IfcSchema = "IFC4" | "IFC2X3";

export interface IfcElementInput {
  id: string;
  type: string;
  name?: string;
  color?: string;
  hostId?: string;
  levelId?: string;
  familyId?: string;
  familyTypeId?: string;
  params: {
    start?: Vec2; end?: Vec2; polygon?: Vec2[]; point?: Vec2;
    width?: number; depth?: number; height: number; thickness: number; elevation: number;
    offsetAlongHost?: number; sillHeight?: number;
    [k: string]: unknown;
  };
  properties?: Record<string, unknown>;
  nativeGeometry?: { positions: number[] };
  ifc?: { entity?: string; globalId?: string; sourceGlobalId?: string; tag?: string; description?: string; [k: string]: unknown };
  transform?: { position: [number, number, number]; quaternion: [number, number, number, number]; scale: [number, number, number] };
}

export interface IfcLevelInput { id: string; name: string; elevation: number }

export interface IfcSpaceInput {
  id: string;
  name: string;
  number: string;
  levelId: string | null;
  boundary: Array<{ x: number; z: number }>;
  holes?: Array<Array<{ x: number; z: number }>>;
  height: number;
  area?: number;
  department?: string;
}

export interface IfcExportOptions {
  schema?: IfcSchema;
  projectName?: string;
  projectId?: string;
  author?: string;
  organization?: string;
  fileName?: string;
  /** ISO timestamp (YYYY-MM-DDTHH:MM:SS); defaults to now. Pass a fixed value for reproducible output. */
  timestamp?: string;
  levels?: IfcLevelInput[];
  spaces?: IfcSpaceInput[];
}

export interface IfcExportStats {
  schema: IfcSchema;
  storeys: number;
  elements: number;
  openings: number;
  spaces: number;
  byClass: Record<string, number>;
  skipped: Array<{ id: string; type: string; reason: string }>;
}

export interface IfcExportResult { text: string; stats: IfcExportStats }

/* ----------------------------------------------------------- STEP helpers */

function esc(s: string): string {
  let out = "";
  let run = "";
  const flush = () => { if (run) { out += "\\X2\\" + run + "\\X0\\"; run = ""; } };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 39) { flush(); out += "''"; }
    else if (c === 92) { flush(); out += "\\\\"; }
    else if (c >= 32 && c <= 126) { flush(); out += s[i]; }
    else run += c.toString(16).toUpperCase().padStart(4, "0");
  }
  flush();
  return out;
}
const S = (s: string | undefined | null): string => (s == null || s === "" ? "$" : `'${esc(String(s))}'`);
function R(n: number): string {
  if (!Number.isFinite(n)) return "0.";
  let s = (Math.round(n * 1e6) / 1e6).toString();
  if (s.includes("e") || s.includes("E")) s = n.toFixed(9).replace(/0+$/, "");
  if (s === "-0") s = "0";
  if (!s.includes(".")) s += ".";
  return s;
}
const L = (items: string[]): string => `(${items.join(",")})`;

class Spf {
  private lines: string[] = [];
  private pointCache = new Map<string, number>();
  private dirCache = new Map<string, number>();
  add(name: string, args: string[]): number {
    const id = this.lines.length + 1;
    this.lines.push(`#${id}=${name}(${args.join(",")});`);
    return id;
  }
  point3(x: number, y: number, z: number): number {
    const k = `${R(x)}|${R(y)}|${R(z)}`;
    let id = this.pointCache.get(k);
    if (!id) { id = this.add("IFCCARTESIANPOINT", [L([R(x), R(y), R(z)])]); this.pointCache.set(k, id); }
    return id;
  }
  point2(x: number, y: number): number {
    const k = `2|${R(x)}|${R(y)}`;
    let id = this.pointCache.get(k);
    if (!id) { id = this.add("IFCCARTESIANPOINT", [L([R(x), R(y)])]); this.pointCache.set(k, id); }
    return id;
  }
  dir3(x: number, y: number, z: number): number {
    const l = Math.hypot(x, y, z) || 1;
    const k = `${R(x / l)}|${R(y / l)}|${R(z / l)}`;
    let id = this.dirCache.get(k);
    if (!id) { id = this.add("IFCDIRECTION", [L([R(x / l), R(y / l), R(z / l)])]); this.dirCache.set(k, id); }
    return id;
  }
  dir2(x: number, y: number): number {
    const l = Math.hypot(x, y) || 1;
    return this.add("IFCDIRECTION", [L([R(x / l), R(y / l)])]);
  }
  get size(): number { return this.lines.length; }
  body(): string { return this.lines.join("\n"); }
}
const ref = (n: number): string => `#${n}`;

type V3 = [number, number, number];
const norm3 = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** three.js (x, y, z) -> IFC (X, Y, Z). */
const toIfc = (x: number, y: number, z: number): V3 => [x, -z, y];

/* -------------------------------------------------------------- entities */

type Kind =
  | "wall" | "slab" | "covering" | "column" | "beam" | "member" | "footing"
  | "door" | "window" | "duct" | "pipe" | "tray" | "conduit" | "proxy"
  | "stair" | "railing" | "ramp" | "curtain";

interface ClassDef { name: string; tail: string[] }
function classFor(kind: Kind, schema: IfcSchema, hint = ""): ClassDef {
  const v4 = schema === "IFC4";
  switch (kind) {
    case "wall": return v4 ? { name: "IFCWALL", tail: [".STANDARD."] } : { name: "IFCWALLSTANDARDCASE", tail: [] };
    case "slab": return { name: "IFCSLAB", tail: [hint || ".FLOOR."] };
    case "covering": return { name: "IFCCOVERING", tail: [".CEILING."] };
    case "column": return { name: "IFCCOLUMN", tail: v4 ? [".COLUMN."] : [] };
    case "beam": return { name: "IFCBEAM", tail: v4 ? [".BEAM."] : [] };
    case "member": return { name: "IFCMEMBER", tail: v4 ? [".BRACE."] : [] };
    case "footing": return { name: "IFCFOOTING", tail: [hint || ".PAD_FOOTING."] };
    case "duct": return v4 ? { name: "IFCDUCTSEGMENT", tail: [".RIGIDSEGMENT."] } : { name: "IFCFLOWSEGMENT", tail: [] };
    case "pipe": return v4 ? { name: "IFCPIPESEGMENT", tail: [".RIGIDSEGMENT."] } : { name: "IFCFLOWSEGMENT", tail: [] };
    case "tray": return v4 ? { name: "IFCCABLECARRIERSEGMENT", tail: [".CABLETRAYSEGMENT."] } : { name: "IFCFLOWSEGMENT", tail: [] };
    case "conduit": return v4 ? { name: "IFCCABLECARRIERSEGMENT", tail: [".CONDUITSEGMENT."] } : { name: "IFCFLOWSEGMENT", tail: [] };
    case "door": case "window": return { name: kind === "door" ? "IFCDOOR" : "IFCWINDOW", tail: [] }; // tail built by caller
    case "proxy": return { name: "IFCBUILDINGELEMENTPROXY", tail: [v4 ? ".NOTDEFINED." : ".ELEMENT."] };
    case "stair": return { name: "IFCSTAIR", tail: [hint || ".STRAIGHT_RUN_STAIR."] };
    case "railing": return { name: "IFCRAILING", tail: [".GUARDRAIL."] };
    case "ramp": return { name: "IFCRAMP", tail: [".STRAIGHT_RUN_RAMP."] };
    case "curtain": return { name: "IFCCURTAINWALL", tail: v4 ? [".NOTDEFINED."] : [] };
  }
}

const DEFAULT_COLOR: Record<string, string> = {
  wall: "#d9d4c7", slab: "#9aa0a6", column: "#b0b4ba", beam: "#a9998a", door: "#8b6b4a", window: "#7fb3d5",
  duct: "#6fa8dc", pipe: "#38a169", "cable-tray": "#d69e2e", conduit: "#b7791f", equipment: "#a0aec0",
};

function parseColor(c: string | undefined, fallback: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec((c || fallback || "").trim());
  const h = m ? m[1] : "cccccc";
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

/* ------------------------------------------------------------- the writer */

export function exportAuthoredToIfc(elementsIn: IfcElementInput[], opts: IfcExportOptions = {}): IfcExportResult {
  const schema: IfcSchema = opts.schema ?? "IFC4";
  const v4 = schema === "IFC4";
  const f = new Spf();
  const projectName = opts.projectName || "OpenBIMStudio project";
  const keyBase = opts.projectId || projectName;
  const stats: IfcExportStats = { schema, storeys: 0, elements: 0, openings: 0, spaces: 0, byClass: {}, skipped: [] };
  const bump = (cls: string) => { stats.byClass[cls] = (stats.byClass[cls] ?? 0) + 1; };

  /* owner history, units, context */
  const person = f.add("IFCPERSON", ["$", S(opts.author || "OpenBIMStudio"), "$", "$", "$", "$", "$", "$"]);
  const org = f.add("IFCORGANIZATION", ["$", S(opts.organization || "OpenBIMStudio"), "$", "$", "$"]);
  const po = f.add("IFCPERSONANDORGANIZATION", [ref(person), ref(org), "$"]);
  const app = f.add("IFCAPPLICATION", [ref(org), S("1.0"), S("OpenBIMStudio IFC writer"), S("OpenBIMStudio")]);
  const nowSec = Math.floor((opts.timestamp ? Date.parse(opts.timestamp + (opts.timestamp.endsWith("Z") ? "" : "Z")) : Date.now()) / 1000);
  const oh = f.add("IFCOWNERHISTORY", [ref(po), ref(app), "$", ".ADDED.", "$", ref(po), ref(app), String(nowSec)]);

  const uLen = f.add("IFCSIUNIT", ["*", ".LENGTHUNIT.", "$", ".METRE."]);
  const uArea = f.add("IFCSIUNIT", ["*", ".AREAUNIT.", "$", ".SQUARE_METRE."]);
  const uVol = f.add("IFCSIUNIT", ["*", ".VOLUMEUNIT.", "$", ".CUBIC_METRE."]);
  const uAng = f.add("IFCSIUNIT", ["*", ".PLANEANGLEUNIT.", "$", ".RADIAN."]);
  const units = f.add("IFCUNITASSIGNMENT", [L([ref(uLen), ref(uArea), ref(uVol), ref(uAng)])]);

  const origin = f.point3(0, 0, 0);
  const wcs = f.add("IFCAXIS2PLACEMENT3D", [ref(origin), "$", "$"]);
  const ctx = f.add("IFCGEOMETRICREPRESENTATIONCONTEXT", ["$", S("Model"), "3", "1.E-05", ref(wcs), "$"]);
  const bodyCtx = v4
    ? f.add("IFCGEOMETRICREPRESENTATIONSUBCONTEXT", [S("Body"), S("Model"), "*", "*", "*", "*", ref(ctx), "$", ".MODEL_VIEW.", "$"])
    : ctx;

  const guid = (key: string) => stableIfcGuid(keyBase + "|" + key);

  /* project / site / building / storeys */
  const project = f.add("IFCPROJECT", [S(guid("project")), ref(oh), S(projectName), "$", "$", "$", "$", L([ref(ctx)]), ref(units)]);
  const axisAt = (x: number, y: number, z: number) => f.add("IFCAXIS2PLACEMENT3D", [ref(f.point3(x, y, z)), "$", "$"]);
  const place = (relTo: number | null, axis: number) => f.add("IFCLOCALPLACEMENT", [relTo ? ref(relTo) : "$", ref(axis)]);
  const sitePl = place(null, axisAt(0, 0, 0));
  const site = f.add("IFCSITE", [S(guid("site")), ref(oh), S("Site"), "$", "$", ref(sitePl), "$", "$", ".ELEMENT.", "$", "$", "$", "$", "$"]);
  const bldPl = place(sitePl, axisAt(0, 0, 0));
  const building = f.add("IFCBUILDING", [S(guid("building")), ref(oh), S("Building"), "$", "$", ref(bldPl), "$", "$", ".ELEMENT.", "$", "$", "$"]);
  f.add("IFCRELAGGREGATES", [S(guid("rel:proj-site")), ref(oh), "$", "$", ref(project), L([ref(site)])]);
  f.add("IFCRELAGGREGATES", [S(guid("rel:site-bld")), ref(oh), "$", "$", ref(site), L([ref(building)])]);

  let levels = (opts.levels ?? []).slice().sort((a, b) => a.elevation - b.elevation);
  if (!levels.length) levels = [{ id: "__level0", name: "Level 0", elevation: 0 }];
  const storeys = levels.map((lv) => {
    const pl = place(bldPl, axisAt(0, 0, lv.elevation));
    const id = f.add("IFCBUILDINGSTOREY", [S(guid("storey:" + lv.id)), ref(oh), S(lv.name), "$", "$", ref(pl), "$", S(lv.name), ".ELEMENT.", R(lv.elevation)]);
    return { lv, id, pl, contained: [] as number[], spaces: [] as number[] };
  });
  stats.storeys = storeys.length;
  f.add("IFCRELAGGREGATES", [S(guid("rel:bld-storeys")), ref(oh), "$", "$", ref(building), L(storeys.map((s) => ref(s.id)))]);

  const storeyFor = (levelId: string | null | undefined, elev: number) => {
    if (levelId) { const hit = storeys.find((s) => s.lv.id === levelId); if (hit) return hit; }
    let best = storeys[0];
    for (const s of storeys) if (s.lv.elevation <= elev + 0.01) best = s;
    return best;
  };

  /* styles (cached per colour) */
  const styleCache = new Map<string, number>();
  const styleFor = (rgb: [number, number, number]) => {
    const key = rgb.map((c) => c.toFixed(3)).join(",");
    let id = styleCache.get(key);
    if (!id) {
      const col = f.add("IFCCOLOURRGB", ["$", R(rgb[0]), R(rgb[1]), R(rgb[2])]);
      const rend = f.add("IFCSURFACESTYLERENDERING", [ref(col), "0.", "$", "$", "$", "$", "$", "$", ".NOTDEFINED."]);
      const ss = f.add("IFCSURFACESTYLE", [S("Style " + (styleCache.size + 1)), ".BOTH.", L([ref(rend)])]);
      id = v4 ? ss : f.add("IFCPRESENTATIONSTYLEASSIGNMENT", [L([ref(ss)])]);
      styleCache.set(key, id);
    }
    return id;
  };
  const styled = (item: number, rgb: [number, number, number]) => { f.add("IFCSTYLEDITEM", [ref(item), L([ref(styleFor(rgb))]), "$"]); };

  /* shape builders */
  const rep = (items: number[], type: string) => {
    const sr = f.add("IFCSHAPEREPRESENTATION", [ref(bodyCtx), S("Body"), S(type), L(items.map(ref))]);
    return f.add("IFCPRODUCTDEFINITIONSHAPE", ["$", "$", L([ref(sr)])]);
  };
  type Profile =
    | { k: "rect"; cx: number; cy: number; xd: number; yd: number }
    | { k: "circle"; r: number }
    | { k: "poly"; pts: Vec2[]; holes?: Vec2[][] };
  const profileId = (p: Profile): number => {
    const pos2 = (cx: number, cy: number) => f.add("IFCAXIS2PLACEMENT2D", [ref(f.point2(cx, cy)), "$"]);
    if (p.k === "rect") return f.add("IFCRECTANGLEPROFILEDEF", [".AREA.", "$", ref(pos2(p.cx, p.cy)), R(p.xd), R(p.yd)]);
    if (p.k === "circle") return f.add("IFCCIRCLEPROFILEDEF", [".AREA.", "$", ref(pos2(0, 0)), R(p.r)]);
    const curve = (pts: Vec2[]) => f.add("IFCPOLYLINE", [L([...pts, pts[0]].map(([x, y]) => ref(f.point2(x, y))))]);
    if (p.holes && p.holes.length) {
      return f.add("IFCARBITRARYPROFILEDEFWITHVOIDS", [".AREA.", "$", ref(curve(p.pts)), L(p.holes.map((h) => ref(curve(h))))]);
    }
    return f.add("IFCARBITRARYCLOSEDPROFILEDEF", [".AREA.", "$", ref(curve(p.pts))]);
  };
  const extrude = (p: Profile, depth: number) => {
    const solidPos = f.add("IFCAXIS2PLACEMENT3D", [ref(origin), "$", "$"]);
    return f.add("IFCEXTRUDEDAREASOLID", [ref(profileId(p)), ref(solidPos), ref(f.dir3(0, 0, 1)), R(depth)]);
  };

  /* property sets / quantities / materials */
  const relDefines = (obj: number, setId: number, key: string) =>
    f.add("IFCRELDEFINESBYPROPERTIES", [S(guid("relp:" + key)), ref(oh), "$", "$", L([ref(obj)]), ref(setId)]);
  const propertySet = (obj: number, name: string, props: Array<[string, string]>, key: string) => {
    if (!props.length) return;
    const ids = props.map(([n, v]) => f.add("IFCPROPERTYSINGLEVALUE", [S(n), "$", v, "$"]));
    const ps = f.add("IFCPROPERTYSET", [S(guid("pset:" + key + ":" + name)), ref(oh), S(name), "$", L(ids.map(ref))]);
    relDefines(obj, ps, key + ":" + name);
  };
  const quantities = (obj: number, qs: Array<["L" | "A" | "V", string, number]>, key: string) => {
    if (!qs.length) return;
    const ids = qs.map(([k, n, val]) => {
      const nm = S(n);
      if (k === "L") return f.add("IFCQUANTITYLENGTH", v4 ? [nm, "$", "$", R(val), "$"] : [nm, "$", "$", R(val)]);
      if (k === "A") return f.add("IFCQUANTITYAREA", v4 ? [nm, "$", "$", R(val), "$"] : [nm, "$", "$", R(val)]);
      return f.add("IFCQUANTITYVOLUME", v4 ? [nm, "$", "$", R(val), "$"] : [nm, "$", "$", R(val)]);
    });
    const q = f.add("IFCELEMENTQUANTITY", [S(guid("qto:" + key)), ref(oh), S("BaseQuantities"), "$", "$", L(ids.map(ref))]);
    relDefines(obj, q, key + ":qto");
  };
  const customProps = (el: IfcElementInput): Array<[string, string]> => {
    const out: Array<[string, string]> = [
      ["ElementId", `IFCIDENTIFIER('${esc(el.id)}')`],
      ["AuthoredType", `IFCLABEL('${esc(el.type)}')`],
    ];
    if (el.familyId) out.push(["FamilyId", `IFCLABEL('${esc(el.familyId)}')`]);
    if (el.familyTypeId) out.push(["FamilyTypeId", `IFCLABEL('${esc(el.familyTypeId)}')`]);
    if (el.ifc?.entity) out.push(["SourceIfcEntity", `IFCLABEL('${esc(String(el.ifc.entity))}')`]);
    for (const [k, v] of Object.entries(el.properties ?? {})) {
      if (out.length > 60) break;
      const name = k.replace(/[^\w .\-]/g, "_").slice(0, 60);
      if (!name) continue;
      if (typeof v === "string" && v.length <= 200) out.push([name, `IFCTEXT('${esc(v)}')`]);
      else if (typeof v === "number" && Number.isFinite(v)) out.push([name, `IFCREAL(${R(v)})`]);
      else if (typeof v === "boolean") out.push([name, `IFCBOOLEAN(${v ? ".T." : ".F."})`]);
    }
    return out;
  };
  const materialCache = new Map<string, number>();
  const materialPending = new Map<number, number[]>();
  const associateMaterial = (obj: number, name: string) => {
    let m = materialCache.get(name);
    if (!m) { m = f.add("IFCMATERIAL", v4 ? [S(name), "$", "$"] : [S(name)]); materialCache.set(name, m); materialPending.set(m, []); }
    materialPending.get(m)!.push(obj);
  };

  /** Triangle soup (three.js axes) -> tessellated representation item in IFC axes, storey-relative Z. */
  const bakeTriangles = (pos: number[], tr: IfcElementInput["transform"] | undefined, storey: { lv: IfcLevelInput }): { item: number; repType: string } | null => {
    const verts: V3[] = [];
    const tris: Array<[number, number, number]> = [];
    const vmap = new Map<string, number>();
    const vid = (x: number, y: number, z: number) => {
      let wx = x, wy = y, wz = z;
      if (tr) {
        const sx = x * tr.scale[0], sy = y * tr.scale[1], sz = z * tr.scale[2];
        const [qx, qy, qz, qw] = tr.quaternion;
        const tx = 2 * (qy * sz - qz * sy), ty = 2 * (qz * sx - qx * sz), tz = 2 * (qx * sy - qy * sx);
        wx = sx + qw * tx + (qy * tz - qz * ty) + tr.position[0];
        wy = sy + qw * ty + (qz * tx - qx * tz) + tr.position[1];
        wz = sz + qw * tz + (qx * ty - qy * tx) + tr.position[2];
      }
      const [ix, iy, iz] = toIfc(wx, wy, wz);
      const v: V3 = [ix, iy, iz - storey.lv.elevation];
      const k = `${R(v[0])}|${R(v[1])}|${R(v[2])}`;
      let i = vmap.get(k);
      if (i === undefined) { i = verts.length; verts.push(v); vmap.set(k, i); }
      return i;
    };
    for (let i = 0; i + 8 < pos.length; i += 9) {
      const a = vid(pos[i], pos[i + 1], pos[i + 2]);
      const b = vid(pos[i + 3], pos[i + 4], pos[i + 5]);
      const c = vid(pos[i + 6], pos[i + 7], pos[i + 8]);
      if (a !== b && b !== c && a !== c) tris.push([a, b, c]);
    }
    if (!tris.length) return null;
    if (v4) {
      const pl = f.add("IFCCARTESIANPOINTLIST3D", [L(verts.map((v) => L(v.map(R))))]);
      return { item: f.add("IFCTRIANGULATEDFACESET", [ref(pl), "$", "$", L(tris.map((t) => L(t.map((n) => String(n + 1))))), "$"]), repType: "Tessellation" };
    }
    const pts = verts.map((v) => f.point3(v[0], v[1], v[2]));
    const faces = tris.map((t) => {
      const loop = f.add("IFCPOLYLOOP", [L(t.map((n) => ref(pts[n])))]);
      const bound = f.add("IFCFACEOUTERBOUND", [ref(loop), ".T."]);
      return f.add("IFCFACE", [L([ref(bound)])]);
    });
    const shell = f.add("IFCCLOSEDSHELL", [L(faces.map(ref))]);
    return { item: f.add("IFCFACETEDBREP", [ref(shell)]), repType: "Brep" };
  };

  /* element emission */
  const emitted = new Map<string, { id: number; storey: (typeof storeys)[number]; wall?: { start: Vec2; end: Vec2; elev: number; t: number; h: number } }>();
  const skip = (el: IfcElementInput, reason: string) => stats.skipped.push({ id: el.id, type: el.type, reason });

  const baseAttrs = (el: IfcElementInput, key: string, placement: number, shape: number | null, tail: string[], objectType?: string) => [
    S(isValidIfcGuid(el.ifc?.globalId) ? el.ifc!.globalId! : guid("el:" + key)),
    ref(oh),
    S(el.name || el.type),
    S(el.ifc?.description as string | undefined),
    S(objectType ?? el.familyTypeId ?? el.type),
    ref(placement),
    shape ? ref(shape) : "$",
    S(el.ifc?.tag as string | undefined ?? el.id),
    ...tail,
  ];

  const finishProduct = (el: IfcElementInput, id: number, storey: (typeof storeys)[number], cls: string, rgb: [number, number, number] | null, solids: number[]) => {
    storey.contained.push(id);
    bump(cls);
    stats.elements++;
    if (rgb) for (const s of solids) styled(s, rgb);
    propertySet(id, "OpenBIMStudio", customProps(el), el.id);
    const mat = el.properties?.material;
    if (typeof mat === "string" && mat.trim()) associateMaterial(id, mat.trim().slice(0, 80));
  };

  /** Member frame: Z along the member, X = the vertical (or world X for vertical members). */
  const linearFrame = (a: V3, b: V3) => {
    const dir = norm3([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    const up: V3 = Math.abs(dir[2]) > 0.98 ? [1, 0, 0] : [0, 0, 1];
    const dot = up[0] * dir[0] + up[1] * dir[1] + up[2] * dir[2];
    const xr = norm3([up[0] - dir[0] * dot, up[1] - dir[1] * dot, up[2] - dir[2] * dot]);
    return { dir, xr };
  };

  const walls = elementsIn.filter((e) => e.type === "wall" && e.params.start && e.params.end);
  const order = [...walls, ...elementsIn.filter((e) => !(e.type === "wall" && e.params.start && e.params.end))];

  for (const el of order) {
    const p = el.params;
    const elev = Number(p.elevation) || 0;
    const H = Number(p.height) || 0;
    const T = Number(p.thickness) || 0;
    const rgb = parseColor(el.color, DEFAULT_COLOR[el.type] ?? "#cccccc");
    try {
      /* ---- native twin: baked triangles ---- */
      if (el.nativeGeometry?.positions && el.nativeGeometry.positions.length >= 9) {
        const storey = storeyFor(el.levelId, elev);
        const baked = bakeTriangles(el.nativeGeometry.positions, el.transform, storey);
        if (!baked) { skip(el, "native geometry has no valid triangles"); continue; }
        const pl = place(storey.pl, axisAt(0, 0, 0));
        const cd = classFor("proxy", schema);
        const id = f.add(cd.name, baseAttrs(el, el.id, pl, rep([baked.item], baked.repType), cd.tail));
        emitted.set(el.id, { id, storey });
        finishProduct(el, id, storey, cd.name, rgb, [baked.item]);
        continue;
      }

      /* ---- M2 types: stairs, railings, ramps, curtain walls, sloped roofs (tessellated from the same generators as the viewport) ---- */
      if (el.type === "stairs" || el.type === "railing" || el.type === "ramp" || el.type === "curtain-wall" || el.type === "roof") {
        const geo = buildElementGeo(el as never);
        if (!geo) { skip(el, "incomplete parameters"); continue; }
        const storey = storeyFor(el.levelId, elev);
        const items: Array<{ item: number; color: [number, number, number] }> = [];
        let repType = "";
        for (const part of geo.parts) {
          const baked = bakeTriangles(part.positions, undefined, storey);
          if (!baked) continue;
          repType = baked.repType;
          items.push({ item: baked.item, color: part.role === "glass" ? [0.49, 0.83, 0.99] : parseColor(el.color, part.color) });
        }
        if (!items.length) { skip(el, "generated geometry is empty"); continue; }
        const shape = String(el.properties?.stairShape ?? "straight");
        const cd = el.type === "stairs" ? classFor("stair", schema, shape === "L" ? ".QUARTER_TURN_STAIR." : shape === "U" ? ".HALF_TURN_STAIR." : ".STRAIGHT_RUN_STAIR.")
          : el.type === "railing" ? classFor("railing", schema)
          : el.type === "ramp" ? classFor("ramp", schema)
          : el.type === "curtain-wall" ? classFor("curtain", schema)
          : classFor("slab", schema, ".ROOF.");
        const pl = place(storey.pl, axisAt(0, 0, 0));
        const id = f.add(cd.name, baseAttrs(el, el.id, pl, rep(items.map((i) => i.item), repType), cd.tail));
        emitted.set(el.id, { id, storey });
        finishProduct(el, id, storey, cd.name, null, []);
        for (const i of items) styled(i.item, i.color);
        const q = m2Quantities(el as never);
        if (q) {
          const qs: Array<["L" | "A" | "V", string, number]> = [];
          if (q.length > 0) qs.push(["L", "Length", q.length]);
          if (q.area > 0) qs.push(["A", "GrossArea", q.area]);
          if (q.volume > 0) qs.push(["V", "GrossVolume", q.volume]);
          quantities(id, qs, el.id);
        }
        continue;
      }

      /* ---- walls ---- */
      if (el.type === "wall" && p.start && p.end) {
        const [ax, az] = p.start, [bx, bz] = p.end;
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.05) { skip(el, "wall shorter than 5 cm"); continue; }
        const storey = storeyFor(el.levelId, elev);
        const o = toIfc(ax, elev, az);
        const d = toIfc(bx - ax, 0, bz - az);
        const axis = f.add("IFCAXIS2PLACEMENT3D", [ref(f.point3(o[0], o[1], o[2] - storey.lv.elevation)), ref(f.dir3(0, 0, 1)), ref(f.dir3(d[0], d[1], 0))]);
        const solid = extrude({ k: "rect", cx: len / 2, cy: 0, xd: len, yd: T }, H);
        const cd = classFor("wall", schema);
        const id = f.add(cd.name, baseAttrs(el, el.id, place(storey.pl, axis), rep([solid], "SweptSolid"), cd.tail));
        emitted.set(el.id, { id, storey, wall: { start: p.start, end: p.end, elev, t: T, h: H } });
        finishProduct(el, id, storey, cd.name, rgb, [solid]);
        quantities(id, [["L", "Length", len], ["L", "Width", T], ["L", "Height", H], ["V", "GrossVolume", len * T * H]], el.id);
        continue;
      }

      /* ---- doors / windows (need an emitted host wall) ---- */
      if (el.type === "door" || el.type === "window") {
        const host = el.hostId ? emitted.get(el.hostId) : undefined;
        if (!host?.wall) { skip(el, "no exported host wall"); continue; }
        const w = Number(p.width) || (el.type === "door" ? 0.9 : 1.2);
        const h = H || (el.type === "door" ? 2.1 : 1.4);
        const sill = Number(p.sillHeight ?? 0) || 0;
        const hw = host.wall;
        const hl = Math.hypot(hw.end[0] - hw.start[0], hw.end[1] - hw.start[1]);
        if (hl < 0.05) { skip(el, "host wall too short"); continue; }
        const half = w / 2;
        const off = Math.max(half, Math.min(hl - half, Number(p.offsetAlongHost ?? hl / 2)));
        const cx = hw.start[0] + ((hw.end[0] - hw.start[0]) / hl) * off;
        const cz = hw.start[1] + ((hw.end[1] - hw.start[1]) / hl) * off;
        const o = toIfc(cx, hw.elev + sill, cz);
        const dd = toIfc(hw.end[0] - hw.start[0], 0, hw.end[1] - hw.start[1]);
        const origZ = o[2] - host.storey.lv.elevation;
        const mkAxis = () => f.add("IFCAXIS2PLACEMENT3D", [ref(f.point3(o[0], o[1], origZ)), ref(f.dir3(0, 0, 1)), ref(f.dir3(dd[0], dd[1], 0))]);
        // opening (box through the wall) + void/fill relationships
        const openSolid = extrude({ k: "rect", cx: 0, cy: 0, xd: w, yd: hw.t + 0.02 }, h);
        const ocd = { name: "IFCOPENINGELEMENT", tail: v4 ? [".OPENING."] : [] };
        const openId = f.add(ocd.name, [
          S(guid("opening:" + el.id)), ref(oh), S((el.name || el.type) + " opening"), "$", S("Opening"),
          ref(place(host.storey.pl, mkAxis())), ref(rep([openSolid], "SweptSolid")), "$", ...ocd.tail,
        ]);
        stats.openings++;
        f.add("IFCRELVOIDSELEMENT", [S(guid("void:" + el.id)), ref(oh), "$", "$", ref(host.id), ref(openId)]);
        // the door / window itself
        const solid = extrude({ k: "rect", cx: 0, cy: 0, xd: w, yd: Math.max(0.04, hw.t * 0.9) }, h);
        const tail = el.type === "door"
          ? (v4 ? [R(h), R(w), ".DOOR.", ".NOTDEFINED.", "$"] : [R(h), R(w)])
          : (v4 ? [R(h), R(w), ".WINDOW.", ".NOTDEFINED.", "$"] : [R(h), R(w)]);
        const cd = classFor(el.type, schema);
        const id = f.add(cd.name, baseAttrs(el, el.id, place(host.storey.pl, mkAxis()), rep([solid], "SweptSolid"), tail));
        f.add("IFCRELFILLSELEMENT", [S(guid("fill:" + el.id)), ref(oh), "$", "$", ref(openId), ref(id)]);
        emitted.set(el.id, { id, storey: host.storey });
        finishProduct(el, id, host.storey, cd.name, rgb, [solid]);
        continue;
      }

      /* ---- slab / roof / ceiling polygons ---- */
      if (el.type === "slab" || el.type === "roof" || el.type === "ceiling") {
        if (!p.polygon || p.polygon.length < 3) { skip(el, "polygon missing"); continue; }
        const pts = p.polygon.map(([x, z]) => [x, -z] as Vec2);
        let area2 = 0;
        for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area2 += a[0] * b[1] - b[0] * a[1]; }
        if (area2 < 0) pts.reverse();
        const storey = storeyFor(el.levelId, elev);
        const axis = axisAt(0, 0, elev - storey.lv.elevation);
        const solid = extrude({ k: "poly", pts }, H || T || 0.2);
        const name = `${el.name || ""} ${el.familyTypeId || ""} ${el.type}`.toLowerCase();
        const asCeiling = el.type === "ceiling" || /ceiling/.test(name);
        const cd = asCeiling ? classFor("covering", schema) : classFor("slab", schema, /roof/.test(name) ? ".ROOF." : ".FLOOR.");
        const id = f.add(cd.name, baseAttrs(el, el.id, place(storey.pl, axis), rep([solid], "SweptSolid"), cd.tail));
        emitted.set(el.id, { id, storey });
        finishProduct(el, id, storey, cd.name, rgb, [solid]);
        quantities(id, [["L", "Width", H || T], ["A", "GrossArea", Math.abs(area2) / 2], ["V", "GrossVolume", (Math.abs(area2) / 2) * (H || T)]], el.id);
        continue;
      }

      /* ---- point elements: column / footing / equipment ---- */
      if ((el.type === "column" || el.type === "footing" || el.type === "equipment") && p.point) {
        const storey = storeyFor(el.levelId, elev);
        const base = el.type === "footing" ? elev - H : elev;
        const o = toIfc(p.point[0], base, p.point[1]);
        const axis = axisAt(o[0], o[1], o[2] - storey.lv.elevation);
        const sx = T, sy = Number(p.depth) || T;
        const solid = extrude({ k: "rect", cx: 0, cy: 0, xd: sx, yd: sy }, H);
        const cd = el.type === "column" ? classFor("column", schema) : el.type === "footing" ? classFor("footing", schema) : classFor("proxy", schema);
        const id = f.add(cd.name, baseAttrs(el, el.id, place(storey.pl, axis), rep([solid], "SweptSolid"), cd.tail));
        emitted.set(el.id, { id, storey });
        finishProduct(el, id, storey, cd.name, rgb, [solid]);
        quantities(id, [["L", "Height", H], ["V", "GrossVolume", sx * sy * H]], el.id);
        continue;
      }

      /* ---- linear members: beam / strip footing / duct / pipe / tray / conduit ---- */
      if (["beam", "strip", "duct", "pipe", "cable-tray", "conduit"].includes(el.type) && p.start && p.end) {
        const [ax, az] = p.start, [bx, bz] = p.end;
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.05) { skip(el, "run shorter than 5 cm"); continue; }
        const storey = storeyFor(el.levelId, elev);
        const a = toIfc(ax, elev + H / 2, az), b = toIfc(bx, elev + H / 2, bz);
        const { dir, xr } = linearFrame(a, b);
        const axis = f.add("IFCAXIS2PLACEMENT3D", [ref(f.point3(a[0], a[1], a[2] - storey.lv.elevation)), ref(f.dir3(dir[0], dir[1], dir[2])), ref(f.dir3(xr[0], xr[1], xr[2]))]);
        const round = el.type === "pipe" || el.type === "conduit";
        const solid = extrude(round ? { k: "circle", r: Math.max(T, 0.001) / 2 } : { k: "rect", cx: 0, cy: 0, xd: H, yd: T }, len);
        const kind: Kind = el.type === "beam" ? "beam" : el.type === "strip" ? "footing" : el.type === "duct" ? "duct" : el.type === "pipe" ? "pipe" : el.type === "cable-tray" ? "tray" : "conduit";
        const cd = classFor(kind, schema, ".STRIP_FOOTING.");
        const id = f.add(cd.name, baseAttrs(el, el.id, place(storey.pl, axis), rep([solid], "SweptSolid"), cd.tail));
        emitted.set(el.id, { id, storey });
        finishProduct(el, id, storey, cd.name, rgb, [solid]);
        quantities(id, [["L", "Length", len]], el.id);
        continue;
      }

      /* ---- brace (diagonal) ---- */
      if (el.type === "brace" && p.start && p.end) {
        const storey = storeyFor(el.levelId, elev);
        const a = toIfc(p.start[0], elev, p.start[1]), b = toIfc(p.end[0], elev + H, p.end[1]);
        const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
        if (len < 0.05) { skip(el, "brace shorter than 5 cm"); continue; }
        const { dir, xr } = linearFrame(a, b);
        const axis = f.add("IFCAXIS2PLACEMENT3D", [ref(f.point3(a[0], a[1], a[2] - storey.lv.elevation)), ref(f.dir3(dir[0], dir[1], dir[2])), ref(f.dir3(xr[0], xr[1], xr[2]))]);
        const solid = extrude({ k: "rect", cx: 0, cy: 0, xd: T, yd: T }, len);
        const cd = classFor("member", schema);
        const id = f.add(cd.name, baseAttrs(el, el.id, place(storey.pl, axis), rep([solid], "SweptSolid"), cd.tail));
        emitted.set(el.id, { id, storey });
        finishProduct(el, id, storey, cd.name, rgb, [solid]);
        continue;
      }

      skip(el, `no analytic IFC exporter for type "${el.type}" yet`);
    } catch (e) {
      skip(el, "exception: " + (e instanceof Error ? e.message : String(e)));
    }
  }

  /* rooms -> IfcSpace */
  for (const sp of opts.spaces ?? []) {
    try {
      if (!sp.boundary || sp.boundary.length < 3) continue;
      const pts = sp.boundary.map((q) => [q.x, -q.z] as Vec2);
      let area2 = 0;
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; area2 += a[0] * b[1] - b[0] * a[1]; }
      if (area2 < 0) pts.reverse();
      const holes = (sp.holes ?? []).filter((h) => h.length >= 3).map((h) => h.map((q) => [q.x, -q.z] as Vec2));
      const storey = storeyFor(sp.levelId, 0);
      const solid = extrude({ k: "poly", pts, holes }, sp.height || 2.7);
      const pl = place(storey.pl, axisAt(0, 0, 0));
      const tail = v4 ? [".ELEMENT.", ".INTERNAL.", "$"] : [".ELEMENT.", ".INTERNAL.", "$"];
      const id = f.add("IFCSPACE", [
        S(guid("space:" + sp.id)), ref(oh), S(sp.number), "$", S("Room"), ref(pl), ref(rep([solid], "SweptSolid")), S(sp.name), ...tail,
      ]);
      styled(solid, [0.55, 0.75, 0.95]);
      storey.spaces.push(id);
      stats.spaces++;
      bump("IFCSPACE");
      const netArea = sp.area ?? Math.abs(area2) / 2;
      propertySet(id, "Pset_SpaceCommon", [["Reference", `IFCIDENTIFIER('${esc(sp.number)}')`]], "space:" + sp.id);
      propertySet(id, "OpenBIMStudio", [["RoomName", `IFCLABEL('${esc(sp.name)}')`], ["RoomNumber", `IFCIDENTIFIER('${esc(sp.number)}')`], ...(sp.department ? ([["Department", `IFCLABEL('${esc(sp.department)}')`]] as Array<[string, string]>) : [])], "space2:" + sp.id);
      quantities(id, [["A", "NetFloorArea", netArea], ["L", "Height", sp.height || 2.7]], "space:" + sp.id);
    } catch (e) {
      stats.skipped.push({ id: sp.id, type: "room", reason: "exception: " + (e instanceof Error ? e.message : String(e)) });
    }
  }

  /* spatial containment, materials */
  for (const s of storeys) {
    if (s.contained.length) f.add("IFCRELCONTAINEDINSPATIALSTRUCTURE", [S(guid("contain:" + s.lv.id)), ref(oh), "$", "$", L(s.contained.map(ref)), ref(s.id)]);
    if (s.spaces.length) f.add("IFCRELAGGREGATES", [S(guid("spaces:" + s.lv.id)), ref(oh), "$", "$", ref(s.id), L(s.spaces.map(ref))]);
  }
  for (const [mat, objs] of materialPending) {
    if (objs.length) f.add("IFCRELASSOCIATESMATERIAL", [S(guid("mat:" + mat)), ref(oh), "$", "$", L(objs.map(ref)), ref(mat)]);
  }

  const ts = (opts.timestamp || new Date().toISOString().slice(0, 19)).replace(/Z$/, "");
  const fileName = opts.fileName || "model.ifc";
  const view = v4 ? "ViewDefinition [ReferenceView_V1.2]" : "ViewDefinition [CoordinationView_V2.0]";
  const text = [
    "ISO-10303-21;",
    "HEADER;",
    `FILE_DESCRIPTION(('${view}'),'2;1');`,
    `FILE_NAME('${esc(fileName)}','${ts}',('${esc(opts.author || "OpenBIMStudio")}'),('${esc(opts.organization || "OpenBIMStudio")}'),'OpenBIMStudio IFC writer','OpenBIMStudio','');`,
    `FILE_SCHEMA(('${schema}'));`,
    "ENDSEC;",
    "DATA;",
    f.body(),
    "ENDSEC;",
    "END-ISO-10303-21;",
    "",
  ].join("\n");
  return { text, stats };
}
