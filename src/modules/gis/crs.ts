/**
 * Coordinate reference systems for site context (pure, no I/O).
 *
 * Reads the `.prj` that travels with a shapefile (ESRI/OGC WKT1 and WKT2 "PROJCRS"), recognises the linear unit
 * (metre, foot, US survey foot, …) and implements the three projections that cover UTM, most US State Plane zones
 * and Web-Mercator-style CRSs: Transverse Mercator, Lambert Conformal Conic (1SP/2SP) and Mercator.
 *
 * Honest limits (surfaced to the user, never hidden):
 *  - No datum transformation. NAD83 / WGS84 / ETRS89 / GRS80-based systems are treated as the same (metre-level);
 *    NAD27 and other older datums are reported as "not shifted".
 *  - Projections other than the three above (Albers, Oblique Stereographic, …) are recognised by name and their
 *    linear unit is honoured, but coordinates are not reprojected.
 *  - Heights / vertical datums are out of scope.
 */

export interface CrsUnit { name: string; toMetre: number }
export interface CrsEllipsoid { a: number; f: number }
export type CrsProjection = "tm" | "lcc" | "merc" | "unsupported";

export interface Crs {
  name: string;
  kind: "geographic" | "projected";
  /** Normalised method for projected systems. */
  projection?: CrsProjection;
  /** Method name as written in the file (for messages). */
  methodName?: string;
  /** Linear unit of the projected coordinates (metre for geographic). */
  unit: CrsUnit;
  ellipsoid: CrsEllipsoid;
  datumName: string;
  /** Normalised parameters (angles in radians, offsets in metres). */
  p: { lat0: number; lon0: number; k0: number; fe: number; fn: number; sp1: number; sp2: number };
  /** True when forward/inverse are implemented for this CRS. */
  supported: boolean;
}

export interface CrsParseError { error: string }

/* ───────────────────────────── WKT tokenizer / tree ───────────────────────────── */

interface WktNode { key: string; args: Array<string | number | WktNode> }

function parseWkt(text: string): WktNode | null {
  let i = 0;
  const n = text.length;
  const ws = () => { while (i < n && /\s/.test(text[i])) i++; };
  function node(depth = 0): WktNode | null {
    if (depth > 64) return null;
    ws();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 64));
    if (!m) return null;
    const key = m[0].toUpperCase();
    i += m[0].length; ws();
    if (text[i] !== "[" && text[i] !== "(") return null;
    const close = text[i] === "[" ? "]" : ")";
    i++;
    const args: WktNode["args"] = [];
    let guard = 0;
    for (;;) {
      if (++guard > 20_000) return null;
      ws();
      if (i >= n) return null;
      if (text[i] === close) { i++; break; }
      if (text[i] === ",") { i++; continue; }
      if (text[i] === '"') {
        let j = i + 1, s = "";
        while (j < n && text[j] !== '"') s += text[j++];
        if (j >= n) return null;
        args.push(s); i = j + 1; continue;
      }
      const num = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(text.slice(i, i + 40));
      if (num) { args.push(parseFloat(num[0])); i += num[0].length; continue; }
      // A bare keyword (WKT2: east, north, Cartesian, …) is a plain token; KEYWORD[...] is a nested node.
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i, i + 64));
      if (word) {
        let j = i + word[0].length;
        while (j < n && /\s/.test(text[j])) j++;
        if (text[j] !== "[" && text[j] !== "(") { args.push(word[0]); i += word[0].length; continue; }
      }
      const child = node(depth + 1);
      if (!child) return null;
      args.push(child);
    }
    return { key, args };
  }
  const root = node();
  return root;
}

const kids = (nd: WktNode, key: string): WktNode[] => nd.args.filter((a): a is WktNode => typeof a === "object" && a.key === key);
const first = (nd: WktNode, ...keys: string[]): WktNode | undefined => { for (const k of keys) { const r = kids(nd, k)[0]; if (r) return r; } return undefined; };
const str = (nd: WktNode | undefined): string => (nd && typeof nd.args[0] === "string" ? (nd.args[0] as string) : "");
const num = (nd: WktNode | undefined, idx = 1): number | undefined => { const v = nd?.args[idx]; return typeof v === "number" ? v : undefined; };
const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function find(nd: WktNode, key: string): WktNode | undefined {
  if (nd.key === key) return nd;
  for (const a of nd.args) if (typeof a === "object") { const r = find(a, key); if (r) return r; }
  return undefined;
}

/* ───────────────────────────── CRS construction ───────────────────────────── */

const DEG = Math.PI / 180;
const WGS84: CrsEllipsoid = { a: 6378137, f: 1 / 298.257223563 };

/** Datums whose shift against WGS84 is at metre level (or zero); no shift is applied for them. */
const SAME_AS_WGS84 = /wgs84|wgs1984|worldgeodeticsystem1984|nad83|northamerican(datum)?1983|etrs89|europeanterrestrialreferencesystem1989|grs80|grs1980|gda94|gda2020|geocentricdatumofaustralia|sirgas|cgcs2000|itrf|nzgd2000/;
const sameAsWgs84 = (datumName: string): boolean => SAME_AS_WGS84.test(norm(datumName));

function ellipsoidOf(geo: WktNode | undefined): CrsEllipsoid {
  const sph = geo ? find(geo, "SPHEROID") ?? find(geo, "ELLIPSOID") : undefined;
  const a = num(sph, 1), inv = num(sph, 2);
  if (a && a > 6e6 && a < 7e6) return { a, f: inv && inv > 0 ? 1 / inv : 0 };
  return WGS84;
}

function unitOf(nd: WktNode): CrsUnit {
  // WKT1: UNIT["Foot_US",0.3048006096012192] directly under PROJCS; WKT2: LENGTHUNIT / UNIT inside PROJCRS (last wins).
  const u = [...kids(nd, "LENGTHUNIT"), ...kids(nd, "UNIT")].filter((x) => typeof x.args[1] === "number");
  const pick = u[u.length - 1];
  const f = num(pick);
  if (f && f > 0.01 && f < 1000) return { name: str(pick) || "unit", toMetre: f };
  return { name: "metre", toMetre: 1 };
}

function angularFactor(geo: WktNode | undefined): number {
  const u = geo ? [...kids(geo, "UNIT"), ...kids(geo, "ANGLEUNIT")].find((x) => typeof x.args[1] === "number") : undefined;
  const f = num(u);
  return f && f > 0 && f < 1 ? f : DEG;
}

function methodKind(name: string): CrsProjection {
  const s = norm(name);
  if (/transversemercator|gausskruger|tmsouthorientated/.test(s) && !/south/.test(s)) return "tm";
  if (/lambertconformalconic|lambertconicconformal/.test(s)) return "lcc";
  if (/^mercator|mercatorauxiliarysphere|popularvisualisation|mercatorvarianta|mercator1sp|mercator2sp/.test(s)) return "merc";
  return "unsupported";
}

/** Parse a .prj / WKT string. Returns an error instead of guessing. */
export function parseCrs(wkt: string): Crs | CrsParseError {
  if (typeof wkt !== "string" || !wkt.trim()) return { error: "The .prj file is empty." };
  if (wkt.length > 200_000) return { error: "The .prj file is too large to be a coordinate system definition." };
  const root = parseWkt(wkt.replace(/^﻿/, "").trim());
  if (!root) return { error: "The .prj file is not valid WKT." };

  if (root.key === "GEOGCS" || root.key === "GEOGCRS" || root.key === "GEODCRS") {
    const datum = find(root, "DATUM");
    return {
      name: str(root) || "geographic", kind: "geographic", unit: { name: "metre", toMetre: 1 }, ellipsoid: ellipsoidOf(root),
      datumName: str(datum), supported: true,
      p: { lat0: 0, lon0: 0, k0: 1, fe: 0, fn: 0, sp1: 0, sp2: 0 },
    };
  }
  if (root.key !== "PROJCS" && root.key !== "PROJCRS") return { error: `Unsupported coordinate system type "${root.key}".` };

  const geo = first(root, "GEOGCS", "BASEGEOGCRS", "GEOGCRS");
  const af = angularFactor(geo);
  const conv = first(root, "CONVERSION");
  const methodNode = root.key === "PROJCS" ? first(root, "PROJECTION") : first(conv ?? root, "METHOD");
  const methodName = str(methodNode);
  const projection = methodKind(methodName);
  const unit = unitOf(root);
  const params = new Map<string, number>();
  for (const pn of kids(conv ?? root, "PARAMETER")) {
    const v = num(pn);
    if (v !== undefined) params.set(norm(str(pn)), v);
  }
  const pick = (...names: string[]): number | undefined => { for (const n of names) { const v = params.get(norm(n)); if (v !== undefined) return v; } return undefined; };
  const lat0 = pick("latitude_of_origin", "latitude_of_center", "latitude of false origin", "latitude of natural origin", "latitude_of_natural_origin") ?? 0;
  const lon0 = pick("central_meridian", "longitude_of_center", "longitude of false origin", "longitude of natural origin", "longitude_of_natural_origin", "longitude_of_origin") ?? 0;
  const k0 = pick("scale_factor", "scale factor at natural origin", "scale_factor_at_natural_origin") ?? 1;
  const feRaw = pick("false_easting", "false easting", "easting at false origin") ?? 0;
  const fnRaw = pick("false_northing", "false northing", "northing at false origin") ?? 0;
  const sp1 = pick("standard_parallel_1", "latitude of 1st standard parallel") ?? lat0;
  const sp2 = pick("standard_parallel_2", "latitude of 2nd standard parallel") ?? sp1;
  const datum = geo ? find(geo, "DATUM") : undefined;
  const ell = projection === "merc" && /auxiliarysphere|popularvisualisation/.test(norm(methodName) + norm(str(root))) ? { a: 6378137, f: 0 } : ellipsoidOf(geo);
  if (![lat0, lon0, k0, feRaw, fnRaw, sp1, sp2].every(Number.isFinite) || k0 <= 0) return { error: "The projection parameters in the .prj file are not usable." };
  return {
    name: str(root) || "projected", kind: "projected", projection, methodName, unit, ellipsoid: ell, datumName: str(datum),
    p: { lat0: lat0 * af, lon0: lon0 * af, k0, fe: feRaw * unit.toMetre, fn: fnRaw * unit.toMetre, sp1: sp1 * af, sp2: sp2 * af },
    supported: projection !== "unsupported",
  };
}

export const isCrs = (x: Crs | CrsParseError): x is Crs => !("error" in x);

/** Plain-language caveats for a parsed CRS (empty when none). */
export function crsCaveats(crs: Crs): string[] {
  const out: string[] = [];
  if (crs.datumName && !sameAsWgs84(crs.datumName)) {
    out.push(`Datum "${crs.datumName}" is not shifted to WGS84 — positions may be off by tens to hundreds of metres against other layers.`);
  }
  if (crs.kind === "projected" && !crs.supported) out.push(`Projection "${crs.methodName}" is not implemented: its unit (${crs.unit.name}) is applied but coordinates are not reprojected.`);
  return out;
}

/* ───────────────────────────── projection maths (metres internally) ───────────────────────────── */

const e2Of = (f: number): number => f * (2 - f);

function tmConstants(crs: Crs) {
  const { a, f } = crs.ellipsoid;
  const n = f / (2 - f), n2 = n * n, n3 = n2 * n, n4 = n2 * n2;
  const A = (a / (1 + n)) * (1 + n2 / 4 + n4 / 64);
  const alpha = [n / 2 - (2 * n2) / 3 + (5 * n3) / 16 + (41 * n4) / 180, (13 * n2) / 48 - (3 * n3) / 5 + (557 * n4) / 1440, (61 * n3) / 240 - (103 * n4) / 140, (49561 * n4) / 161280];
  const beta = [n / 2 - (2 * n2) / 3 + (37 * n3) / 96 - n4 / 360, n2 / 48 + n3 / 15 - (437 * n4) / 1440, (17 * n3) / 480 - (37 * n4) / 840, (4397 * n4) / 161280];
  const delta = [2 * n - (2 * n2) / 3 - 2 * n3 + (116 * n4) / 45, (7 * n2) / 3 - (8 * n3) / 5 - (227 * n4) / 45, (56 * n3) / 15 - (136 * n4) / 35, (4279 * n4) / 630];
  return { n, A, alpha, beta, delta };
}

function tmConformalLat(phi: number, n: number): number {
  const s = Math.sin(phi), q = (2 * Math.sqrt(n)) / (1 + n);
  return Math.sinh(Math.atanh(s) - q * Math.atanh(q * s));
}

function tmM0(crs: Crs, c: ReturnType<typeof tmConstants>): number {
  const t0 = tmConformalLat(crs.p.lat0, c.n);
  const xi0 = Math.atan(t0 / 1);
  let s = xi0;
  for (let j = 1; j <= 4; j++) s += c.alpha[j - 1] * Math.sin(2 * j * xi0);
  return c.A * s;
}

function lccConstants(crs: Crs) {
  const e = Math.sqrt(e2Of(crs.ellipsoid.f)), a = crs.ellipsoid.a;
  const m = (p: number) => Math.cos(p) / Math.sqrt(1 - e * e * Math.sin(p) ** 2);
  const t = (p: number) => Math.tan(Math.PI / 4 - p / 2) / Math.pow((1 - e * Math.sin(p)) / (1 + e * Math.sin(p)), e / 2);
  const { sp1, sp2, lat0 } = crs.p;
  const twoSp = Math.abs(sp1 - sp2) > 1e-12;
  const n = twoSp ? (Math.log(m(sp1)) - Math.log(m(sp2))) / (Math.log(t(sp1)) - Math.log(t(sp2))) : Math.sin(sp1);
  const F = m(sp1) / (n * Math.pow(t(sp1), n));
  const k0 = twoSp ? 1 : crs.p.k0;
  const rho0 = a * k0 * F * Math.pow(t(lat0), n);
  return { e, a, n, F, k0, rho0, t };
}

const phiFromT = (tt: number, e: number): number => {
  let phi = Math.PI / 2 - 2 * Math.atan(tt);
  for (let i = 0; i < 30; i++) {
    const next = Math.PI / 2 - 2 * Math.atan(tt * Math.pow((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi)), e / 2));
    if (Math.abs(next - phi) < 1e-14) { phi = next; break; }
    phi = next;
  }
  return phi;
};

/** lon/lat (degrees) → projected coordinates in the CRS's own unit. Throws for geographic/unsupported CRSs. */
export function project(crs: Crs, lonDeg: number, latDeg: number): { x: number; y: number } {
  if (crs.kind !== "projected" || !crs.supported) throw new Error("This coordinate system cannot be projected.");
  if (!Number.isFinite(lonDeg) || !Number.isFinite(latDeg) || Math.abs(latDeg) > 90) throw new Error("Longitude/latitude out of range.");
  const phi = latDeg * DEG;
  let dl = lonDeg * DEG - crs.p.lon0;
  dl = Math.atan2(Math.sin(dl), Math.cos(dl));
  const { fe, fn, k0 } = crs.p;
  let x: number, y: number;
  if (crs.projection === "tm") {
    const c = tmConstants(crs);
    const t = tmConformalLat(phi, c.n);
    const xiP = Math.atan2(t, Math.cos(dl)), etaP = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
    let xi = xiP, eta = etaP;
    for (let j = 1; j <= 4; j++) {
      xi += c.alpha[j - 1] * Math.sin(2 * j * xiP) * Math.cosh(2 * j * etaP);
      eta += c.alpha[j - 1] * Math.cos(2 * j * xiP) * Math.sinh(2 * j * etaP);
    }
    x = fe + k0 * c.A * eta;
    y = fn + k0 * (c.A * xi - tmM0(crs, c));
  } else if (crs.projection === "lcc") {
    const c = lccConstants(crs);
    const rho = c.a * c.k0 * c.F * Math.pow(c.t(phi), c.n);
    const th = c.n * dl;
    x = fe + rho * Math.sin(th);
    y = fn + c.rho0 - rho * Math.cos(th);
  } else {
    const { a, f } = crs.ellipsoid, e = Math.sqrt(e2Of(f));
    x = fe + a * k0 * dl;
    y = fn - a * k0 * Math.log(Math.tan(Math.PI / 4 - phi / 2) / Math.pow((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi)), e / 2));
  }
  return { x: x / crs.unit.toMetre, y: y / crs.unit.toMetre };
}

/** Projected coordinates in the CRS's own unit → lon/lat in degrees. */
export function unproject(crs: Crs, xUnit: number, yUnit: number): { lon: number; lat: number } {
  if (crs.kind !== "projected" || !crs.supported) throw new Error("This coordinate system cannot be unprojected.");
  if (!Number.isFinite(xUnit) || !Number.isFinite(yUnit)) throw new Error("Coordinates are not finite.");
  const X = xUnit * crs.unit.toMetre, Y = yUnit * crs.unit.toMetre;
  const { fe, fn, k0, lon0 } = crs.p;
  let phi: number, lam: number;
  if (crs.projection === "tm") {
    const c = tmConstants(crs);
    const xi = (Y - fn + k0 * tmM0(crs, c)) / (k0 * c.A), eta = (X - fe) / (k0 * c.A);
    let xiP = xi, etaP = eta;
    for (let j = 1; j <= 4; j++) {
      xiP -= c.beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
      etaP -= c.beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    }
    const chi = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
    phi = chi;
    for (let j = 1; j <= 4; j++) phi += c.delta[j - 1] * Math.sin(2 * j * chi);
    lam = lon0 + Math.atan2(Math.sinh(etaP), Math.cos(xiP));
  } else if (crs.projection === "lcc") {
    const c = lccConstants(crs);
    const dx = X - fe, dy = c.rho0 - (Y - fn), sg = Math.sign(c.n) || 1;
    const rho = sg * Math.hypot(dx, dy);
    const tt = Math.pow(rho / (c.a * c.k0 * c.F), 1 / c.n);
    const theta = Math.atan2(sg * dx, sg * dy);
    phi = phiFromT(tt, c.e);
    lam = lon0 + theta / c.n;
  } else {
    const { a, f } = crs.ellipsoid, e = Math.sqrt(e2Of(f));
    phi = phiFromT(Math.exp(-(Y - fn) / (a * k0)), e);
    lam = lon0 + (X - fe) / (a * k0);
  }
  const lon = ((lam / DEG + 540) % 360) - 180;
  return { lon, lat: phi / DEG };
}
