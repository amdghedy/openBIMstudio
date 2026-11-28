/**
 * IFC4 georeferencing: IfcProjectedCRS + IfcMapConversion (pure, no I/O).
 *
 * Tells every downstream tool where the model's local origin sits in a map coordinate system (UTM, State Plane, a national
 * grid, …) — the data surveyors, GIS and civil software need to place a building on its site. IFC4 only: IFC2X3 has no
 * IfcMapConversion (it uses a property-set convention), so the IFC2X3 writer reports that it did not write one.
 *
 * Nothing here transforms coordinates: the model keeps its local coordinates and the conversion describes the offset,
 * rotation and scale to the map CRS. Eastings/Northings/height are in the CRS's own unit.
 */

export type GeorefUnit = "metre" | "foot" | "ussurveyfoot";

export interface Georef {
  /** CRS identifier, normally an EPSG code such as "EPSG:2263". */
  crsName: string;
  crsDescription?: string;
  geodeticDatum?: string;
  verticalDatum?: string;
  /** e.g. "Lambert Conformal Conic", "Transverse Mercator". */
  mapProjection?: string;
  /** e.g. "3104" or "18N". */
  mapZone?: string;
  /** Unit of eastings / northings / height. */
  unit: GeorefUnit;
  /** Map position of the model origin, in `unit`. */
  eastings: number;
  northings: number;
  orthogonalHeight: number;
  /** Rotation of the model's X axis from grid east, degrees counter-clockwise. */
  rotationDeg?: number;
  /** Model-to-map scale (1 when the model is already in true map length). */
  scale?: number;
}

export const UNIT_TO_METRE: Record<GeorefUnit, number> = { metre: 1, foot: 0.3048, ussurveyfoot: 1200 / 3937 };
const UNIT_LABEL: Record<GeorefUnit, string> = { metre: "metre", foot: "foot", ussurveyfoot: "US survey foot" };
const LIMIT = 1e9;

export interface GeorefProblem { field: string; message: string }

/** Every reason this georeference cannot be written. Empty means valid. */
export function validateGeoref(g: Georef | null | undefined): GeorefProblem[] {
  const out: GeorefProblem[] = [];
  if (!g || typeof g !== "object") return [{ field: "georef", message: "No coordinate system was provided." }];
  if (typeof g.crsName !== "string" || !g.crsName.trim()) out.push({ field: "crsName", message: "Give the coordinate system an identifier such as EPSG:2263." });
  else if (g.crsName.length > 120) out.push({ field: "crsName", message: "The coordinate system name is too long (120 characters max)." });
  if (!(g.unit in UNIT_TO_METRE)) out.push({ field: "unit", message: "Unit must be metre, foot or ussurveyfoot." });
  for (const k of ["eastings", "northings", "orthogonalHeight"] as const) {
    const v = g[k];
    if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > LIMIT) out.push({ field: k, message: `${k} must be a finite number (|value| ≤ 1e9).` });
  }
  if (g.rotationDeg !== undefined && (!Number.isFinite(g.rotationDeg) || Math.abs(g.rotationDeg) > 3600)) out.push({ field: "rotationDeg", message: "Rotation must be a finite angle in degrees." });
  if (g.scale !== undefined && (!Number.isFinite(g.scale) || g.scale <= 0 || g.scale > 10)) out.push({ field: "scale", message: "Scale must be greater than 0 and at most 10." });
  for (const k of ["crsDescription", "geodeticDatum", "verticalDatum", "mapProjection", "mapZone"] as const) {
    const v = g[k];
    if (v !== undefined && (typeof v !== "string" || v.length > 200)) out.push({ field: k, message: `${k} must be text of at most 200 characters.` });
  }
  return out;
}

/** Minimal builder surface so the same code serves any SPF writer. */
export interface SpfSink {
  add(name: string, args: string[]): number;
}

const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/'/g, "''").replace(/[^\x20-\x7e]/g, (c) => `\\X2\\${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}\\X0\\`);
const S = (s: string | undefined): string => (s === undefined || s === "" ? "$" : `'${esc(s)}'`);
/** Full double precision (unit factors: 1e-9 rounding would be ~0.4 mm over a State Plane coordinate). */
const exact = (n: number): string => { const s = String(n); return /[.eE]/.test(s) ? s : s + "."; };
const num = (n: number): string => { const s = String(Math.round(n * 1e9) / 1e9); return /[.eE]/.test(s) ? s : s + "."; };

/**
 * Add IfcProjectedCRS + IfcMapConversion. `contextId` is the model's IfcGeometricRepresentationContext (the SourceCRS).
 * `metreUnitId` is an existing IfcSIUnit (metre) to reuse. Returns the MapConversion id.
 */
export function writeGeorefEntities(sink: SpfSink, contextId: number, metreUnitId: number, g: Georef): number {
  const problems = validateGeoref(g);
  if (problems.length) throw new Error("Georeference not written: " + problems.map((p) => p.message).join(" "));
  let mapUnit = metreUnitId;
  if (g.unit !== "metre") {
    const dims = sink.add("IFCDIMENSIONALEXPONENTS", ["1", "0", "0", "0", "0", "0", "0"]);
    const mwu = sink.add("IFCMEASUREWITHUNIT", [`IFCLENGTHMEASURE(${exact(UNIT_TO_METRE[g.unit])})`, `#${metreUnitId}`]);
    mapUnit = sink.add("IFCCONVERSIONBASEDUNIT", [`#${dims}`, ".LENGTHUNIT.", S(UNIT_LABEL[g.unit]), `#${mwu}`]);
  }
  const crs = sink.add("IFCPROJECTEDCRS", [S(g.crsName), S(g.crsDescription), S(g.geodeticDatum), S(g.verticalDatum), S(g.mapProjection), S(g.mapZone), `#${mapUnit}`]);
  const rot = ((g.rotationDeg ?? 0) * Math.PI) / 180;
  return sink.add("IFCMAPCONVERSION", [`#${contextId}`, `#${crs}`, num(g.eastings), num(g.northings), num(g.orthogonalHeight), num(Math.cos(rot)), num(Math.sin(rot)), num(g.scale ?? 1)]);
}

/* ───────────────────────────── reading ───────────────────────────── */

type Arg = string | number | Arg[] | { ref: number } | { typed: string; value: Arg } | null;

function splitArgs(s: string): Arg[] {
  let i = 0;
  const n = s.length;
  function value(): Arg {
    while (i < n && s[i] === " ") i++;
    const c = s[i];
    if (c === "'") {
      let out = "";
      i++;
      while (i < n) {
        if (s[i] === "'" && s[i + 1] === "'") { out += "'"; i += 2; continue; }
        if (s[i] === "'") { i++; break; }
        out += s[i++];
      }
      return out;
    }
    if (c === "(") {
      i++;
      const arr: Arg[] = [];
      for (let guard = 0; i < n && guard < 100000; guard++) {
        while (i < n && s[i] === " ") i++;
        if (s[i] === ")") { i++; break; }
        if (s[i] === ",") { i++; continue; }
        arr.push(value());
      }
      return arr;
    }
    if (c === "#") { const m = /^#(\d+)/.exec(s.slice(i, i + 12)); if (m) { i += m[0].length; return { ref: Number(m[1]) }; } }
    if (c === "$" || c === "*") { i++; return null; }
    const m = /^[A-Za-z_][A-Za-z0-9_]*\(/.exec(s.slice(i, i + 64));
    if (m) { const key = m[0].slice(0, -1); i += m[0].length - 1; const inner = value(); return { typed: key, value: Array.isArray(inner) && inner.length === 1 ? inner[0] : inner }; }
    const t = /^[-+.\w]+/.exec(s.slice(i, i + 64));
    if (t) { i += t[0].length; const f = Number(t[0]); return Number.isFinite(f) ? f : t[0]; }
    i++;
    return null;
  }
  const arr: Arg[] = [];
  for (let guard = 0; i < n && guard < 100000; guard++) {
    while (i < n && (s[i] === " " || s[i] === ",")) i++;
    if (i >= n) break;
    arr.push(value());
  }
  return arr;
}

const asNum = (a: Arg | undefined): number | undefined => (typeof a === "number" ? a : undefined);
const asStr = (a: Arg | undefined): string | undefined => (typeof a === "string" ? a : undefined);
const asRef = (a: Arg | undefined): number | undefined => (a && typeof a === "object" && !Array.isArray(a) && "ref" in a ? a.ref : undefined);

export interface GeorefRead { georef: Georef | null; problems: string[] }

/** Read IfcProjectedCRS + IfcMapConversion out of IFC4 text. Never throws; returns the reason when nothing usable is found. */
export function readGeorefFromIfc(text: string): GeorefRead {
  const problems: string[] = [];
  if (typeof text !== "string") return { georef: null, problems: ["Not IFC text."] };
  const ents = new Map<number, { name: string; args: Arg[] }>();
  // Linear, quote-aware scan for statements ("#12=NAME(...);"): a ';' inside a string does not end one.
  const WANT = new Set(["IFCMAPCONVERSION", "IFCPROJECTEDCRS", "IFCCONVERSIONBASEDUNIT", "IFCMEASUREWITHUNIT", "IFCSIUNIT"]);
  let start = 0, inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") inStr = !inStr;
    else if (c === ";" && !inStr) {
      const stmt = text.slice(start, i).trim();
      start = i + 1;
      if (stmt.charCodeAt(0) !== 35) continue;
      const m = /^#(\d+)\s*=\s*([A-Z0-9_]+)\s*\(([\s\S]*)\)$/.exec(stmt);
      if (m && WANT.has(m[2])) ents.set(Number(m[1]), { name: m[2], args: splitArgs(m[3]) });
    }
  }
  const mc = [...ents.values()].find((e) => e.name === "IFCMAPCONVERSION");
  if (!mc) return { georef: null, problems: ["The file has no IfcMapConversion (not georeferenced, or IFC2X3)."] };
  const crsEnt = ents.get(asRef(mc.args[1]) ?? -1);
  if (!crsEnt || crsEnt.name !== "IFCPROJECTEDCRS") return { georef: null, problems: ["IfcMapConversion does not point to an IfcProjectedCRS."] };
  const a = crsEnt.args;
  let unit: GeorefUnit = "metre";
  const unitEnt = ents.get(asRef(a[6]) ?? -1);
  if (unitEnt?.name === "IFCCONVERSIONBASEDUNIT") {
    const mw = ents.get(asRef(unitEnt.args[3]) ?? -1);
    const v = mw?.args[0];
    const factor = v && typeof v === "object" && !Array.isArray(v) && "typed" in v ? asNum(v.value as Arg) : undefined;
    if (factor !== undefined && Math.abs(factor - UNIT_TO_METRE.foot) < 1e-9) unit = "foot";
    else if (factor !== undefined && Math.abs(factor - UNIT_TO_METRE.ussurveyfoot) < 1e-9) unit = "ussurveyfoot";
    else problems.push(`Map unit "${asStr(unitEnt.args[2]) ?? "?"}" (×${factor ?? "?"} m) is not one of metre / foot / US survey foot; treated as metre.`);
  } else if (!unitEnt && a[6] !== null) problems.push("Map unit could not be resolved; treated as metre.");
  const ab = asNum(mc.args[5]) ?? 1, or = asNum(mc.args[6]) ?? 0;
  const g: Georef = {
    crsName: asStr(a[0]) ?? "", ...(asStr(a[1]) ? { crsDescription: asStr(a[1]) } : {}), ...(asStr(a[2]) ? { geodeticDatum: asStr(a[2]) } : {}),
    ...(asStr(a[3]) ? { verticalDatum: asStr(a[3]) } : {}), ...(asStr(a[4]) ? { mapProjection: asStr(a[4]) } : {}), ...(asStr(a[5]) ? { mapZone: asStr(a[5]) } : {}),
    unit, eastings: asNum(mc.args[2]) ?? NaN, northings: asNum(mc.args[3]) ?? NaN, orthogonalHeight: asNum(mc.args[4]) ?? 0,
    rotationDeg: (Math.atan2(or, ab) * 180) / Math.PI, scale: asNum(mc.args[7]) ?? 1,
  };
  const bad = validateGeoref(g);
  if (bad.length) return { georef: null, problems: [...problems, ...bad.map((p) => p.message)] };
  return { georef: g, problems };
}

/* ───────────────────────────── project-level holder ───────────────────────────── */

let current: Georef | null = null;
/** The project's coordinate system (null = not georeferenced). */
export const getGeoref = (): Georef | null => (current ? { ...current } : null);
/** Set (or clear with null) the project's coordinate system. Throws with the reasons when invalid. */
export function setGeoref(g: Georef | null): void {
  if (g === null) { current = null; return; }
  const p = validateGeoref(g);
  if (p.length) throw new Error(p.map((x) => x.message).join(" "));
  current = { ...g };
}
/** Restore from a saved project document; invalid data is ignored and reported rather than trusted. */
export function restoreGeoref(raw: unknown): { restored: boolean; reason?: string } {
  if (raw == null) { current = null; return { restored: false }; }
  const p = validateGeoref(raw as Georef);
  if (p.length) { current = null; return { restored: false, reason: p.map((x) => x.message).join(" ") }; }
  current = { ...(raw as Georef) };
  return { restored: true };
}

/** Short human description for command output / the status line. */
export function describeGeoref(g: Georef | null): string {
  if (!g) return "Not georeferenced.";
  const u = UNIT_LABEL[g.unit];
  return `${g.crsName}${g.crsDescription ? ` (${g.crsDescription})` : ""} — model origin at E ${g.eastings} / N ${g.northings} / H ${g.orthogonalHeight} ${u}${g.rotationDeg ? `, rotated ${+g.rotationDeg.toFixed(6)}°` : ""}${g.scale && g.scale !== 1 ? `, scale ${g.scale}` : ""}.`;
}
