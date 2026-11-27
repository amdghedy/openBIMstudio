// Coordinate systems for site context: .prj parsing, UTM / State Plane (LCC) / Mercator maths, unit handling, bundle persistence.
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "crs-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
try { fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* linked */ }
const FILES = "src/modules/gis/gis-core.ts src/modules/gis/crs.ts src/modules/gis/gis-bundle.ts src/core/safeLoad.ts";
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
execSync(`npx tsc ${FILES} --outDir ${out} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck${flag}`, { stdio: "pipe", cwd: path.join(__dirname, "..") });
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
const C = require(find("crs.js")), G = require(find("gis-core.js")), B = require(find("gis-bundle.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };
const near = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, `${m || ""} ${a} vs ${b} (tol ${tol})`);

const UTM18 = 'PROJCS["WGS_1984_UTM_Zone_18N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-75.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
const UTM18_WKT2 = 'PROJCRS["WGS 84 / UTM zone 18N",BASEGEOGCRS["WGS 84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]],ANGLEUNIT["degree",0.0174532925199433]],CONVERSION["UTM zone 18N",METHOD["Transverse Mercator",ID["EPSG",9807]],PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Longitude of natural origin",-75,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1]],PARAMETER["False easting",500000,LENGTHUNIT["metre",1]],PARAMETER["False northing",0,LENGTHUNIT["metre",1]]],CS[Cartesian,2],AXIS["(E)",east,ORDER[1]],AXIS["(N)",north,ORDER[2]],LENGTHUNIT["metre",1]]';
const NYLI = 'PROJCS["NAD_1983_StatePlane_New_York_Long_Island_FIPS_3104_Feet",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Lambert_Conformal_Conic"],PARAMETER["False_Easting",984250.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-74.0],PARAMETER["Standard_Parallel_1",40.66666666666666],PARAMETER["Standard_Parallel_2",41.03333333333333],PARAMETER["Latitude_Of_Origin",40.16666666666666],UNIT["Foot_US",0.3048006096012192]]';
const WEBMERC = 'PROJCS["WGS_1984_Web_Mercator_Auxiliary_Sphere",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Mercator_Auxiliary_Sphere"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",0.0],PARAMETER["Standard_Parallel_1",0.0],PARAMETER["Auxiliary_Sphere_Type",0.0],UNIT["Meter",1.0]]';
const ALBERS = 'PROJCS["USA_Contiguous_Albers_Equal_Area_Conic",GEOGCS["GCS_North_American_1927",DATUM["D_North_American_1927",SPHEROID["Clarke_1866",6378206.4,294.9786982]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Albers"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-96.0],PARAMETER["Standard_Parallel_1",29.5],PARAMETER["Standard_Parallel_2",45.5],PARAMETER["Latitude_Of_Origin",37.5],UNIT["Meter",1.0]]';
const must = (w) => { const c = C.parseCrs(w); assert.ok(C.isCrs(c), JSON.stringify(c)); return c; };

t("UTM zone 18N: on the central meridian E=500000 and N matches the published meridian arc", () => {
  const c = must(UTM18);
  const p = C.project(c, -75, 45);
  near(p.x, 500000, 0.001, "E"); near(p.y, 4982950.4, 0.02, "N (arc 4984944.378 m × 0.9996)");
  const q = C.project(c, -75, 0); near(q.x, 500000, 1e-6); near(q.y, 0, 1e-6);
});
t("UTM equator one degree off the meridian ≈ k0·a·(Δλ + Δλ³/6)", () => { const dl = Math.PI / 180; near(C.project(must(UTM18), -74, 0).x, 500000 + 0.9996 * 6378137 * dl * (1 + dl * dl / 6), 0.5, "series cubic term included");  });
t("WKT2 PROJCRS gives the same answer as WKT1", () => {
  const a = C.project(must(UTM18), -73.9857, 40.7484), b = C.project(must(UTM18_WKT2), -73.9857, 40.7484);
  near(a.x, b.x, 1e-6); near(a.y, b.y, 1e-6);
  near(a.x, 585.6e3, 5e3, "Manhattan lies ~585 km east of the zone's false origin");
});
t("State Plane Long Island (US survey feet): origin lands on the false easting in FEET, CM exact", () => {
  const c = must(NYLI);
  assert.equal(c.unit.name, "Foot_US");
  near(c.unit.toMetre, 0.3048006096012192, 1e-15);
  const o = C.project(c, -74, 40.16666666666666);
  near(o.x, 984250, 1e-6, "FE in ftUS"); near(o.y, 0, 1e-6, "FN at the origin latitude");
  const m = C.project(c, -73.9857, 40.7484);
  assert.ok(m.x > 985000 && m.x < 995000 && m.y > 205000 && m.y < 225000, `Manhattan in ftUS ${m.x},${m.y}`);
});
t("round trips are sub-millimetre for TM, LCC (feet) and Mercator", () => {
  for (const [w, pts] of [[UTM18, [[-75.5, 10], [-72.2, 44.1], [-77.9, -5]]], [NYLI, [[-74.5, 40.3], [-72.0, 41.2], [-73.4, 40.9]]], [WEBMERC, [[10, 10], [-120.5, 60], [179.9, -80]]]]) {
    const c = must(w);
    for (const [lon, lat] of pts) {
      const p = C.project(c, lon, lat), q = C.unproject(c, p.x, p.y);
      near(q.lon, lon, 2e-9, `${c.name} lon`); near(q.lat, lat, 2e-9, `${c.name} lat`);
    }
  }
});
t("Web Mercator edge values", () => {
  const c = must(WEBMERC);
  near(C.project(c, 180, 0).x, 20037508.342789, 1e-3);
  near(C.project(c, 0, 85.0511287798).y, 20037508.342789, 1e-2);
});
t("unsupported projection keeps its unit and says so; old datum is flagged", () => {
  const c = must(ALBERS);
  assert.equal(c.supported, false);
  assert.throws(() => C.project(c, -96, 37.5));
  const cav = C.crsCaveats(c).join(" ");
  assert.ok(/not implemented/.test(cav) && /not shifted/.test(cav), cav);
  assert.deepEqual(C.crsCaveats(must(UTM18)), [], "WGS84 gets no caveats");
  assert.deepEqual(C.crsCaveats(must(NYLI)), [], "NAD83 gets no caveats");
});
t("hostile and malformed .prj text is rejected, not trusted", () => {
  for (const bad of ["", "   ", "garbage", 'PROJCS["x"', "A[".repeat(5000), 'VERTCS["v",VDATUM["d"]]', 'PROJCS["x",PROJECTION["Transverse_Mercator"],PARAMETER["Scale_Factor",0],UNIT["m",1]]', "x".repeat(300000)])
    assert.ok(!C.isCrs(C.parseCrs(bad)), bad.slice(0, 30));
  assert.ok(!C.isCrs(C.parseCrs(null)));
  assert.throws(() => C.project(must(UTM18), NaN, 10));
  assert.throws(() => C.project(must(UTM18), 10, 95));
});
t("toLocal: a feet-based shapefile is converted to metres (was assumed metres → 3.28× too large)", () => {
  const layer = { name: "s", warnings: [], features: [{ kind: "line", props: {}, parts: [[[984250, 0], [984250 + 1000, 0]]] }] };
  const noPrj = G.toLocal(layer);
  near(noPrj.widthM, 1000, 1e-9);
  assert.ok(/NOT verified/.test(noPrj.crsNote) && /too large/.test(noPrj.crsNote), noPrj.crsNote);
  const withPrj = G.toLocal(layer, undefined, NYLI);
  near(withPrj.widthM, 304.8006096, 1e-6);
  assert.ok(!withPrj.geographic && /Foot_US/.test(withPrj.crsNote) && !/NOT verified/.test(withPrj.crsNote), withPrj.crsNote);
  const f = withPrj.features[0].parts[0]; near(f[1][0] - f[0][0], 304.8006096, 1e-6);
});
t("toLocal: .prj decides; unreadable .prj falls back with the reason; geographic .prj keeps lon/lat handling", () => {
  const ll = { name: "g", warnings: [], features: [{ kind: "point", props: {}, parts: [[[-74, 40.7], [-73.99, 40.71]]] }] };
  const geo = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';
  const g = G.toLocal(ll, undefined, geo);
  assert.ok(g.geographic && /GCS_WGS_1984/.test(g.crsNote));
  const bad = G.toLocal(ll, undefined, "nonsense");
  assert.ok(bad.geographic && /could not be used/.test(bad.crsNote), bad.crsNote);
  const nad27 = G.toLocal(ll, undefined, geo.replace("D_WGS_1984", "D_North_American_1927"));
  assert.ok(nad27.warnings.some((w) => /not shifted/.test(w)), "datum caveat reaches the user");
});
t("shapefile bundle: round trip, legacy raw .shp, and damaged bundle", () => {
  const shp = new Uint8Array([0, 0, 0x27, 0x0a, 1, 2, 3, 4]).buffer, dbf = new Uint8Array([9, 8, 7]).buffer;
  const u = B.unpackGisBundle(B.packGisBundle(shp, dbf, NYLI).buffer);
  assert.equal(u.prj, NYLI); assert.deepEqual([...new Uint8Array(u.dbf)], [9, 8, 7]); assert.deepEqual([...new Uint8Array(u.shp)], [...new Uint8Array(shp)]);
  const only = B.unpackGisBundle(B.packGisBundle(shp, undefined, NYLI).buffer);
  assert.equal(only.dbf, undefined); assert.equal(only.prj, NYLI);
  const raw = B.unpackGisBundle(shp); assert.equal(raw.prj, undefined); assert.equal(raw.shp.byteLength, 8);
  const packed = B.packGisBundle(shp, dbf, NYLI);
  const dv = new DataView(packed.buffer); dv.setUint32(8, 0xffffff, true);
  assert.throws(() => B.unpackGisBundle(packed.buffer), /damaged/);
  const stub = packed.slice(0, 10).buffer.slice(0);
  assert.equal(B.isGisBundle(stub), false, "a truncated header is not a bundle");
  assert.equal(B.unpackGisBundle(stub).prj, undefined);
});
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
