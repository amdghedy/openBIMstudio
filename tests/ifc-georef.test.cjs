// IFC4 georeferencing: IfcProjectedCRS + IfcMapConversion written by the authored-model exporter, read back, validated.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "geo-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
try { fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* linked */ }
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
const run = (strict) => execSync(`npx tsc src/modules/export/ifc-georef.ts src/modules/bim-gaps/authored-ifc.ts --outDir ${out} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck${strict ? " --strict" : ""}${flag}`, { stdio: "pipe", cwd: root });
try { run(true); } catch { run(false); }
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (f.name === "node_modules") continue; const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
const G = require(find("ifc-georef.js")), { exportAuthoredToIfc } = require(find("authored-ifc.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };

const NY = { crsName: "EPSG:2263", crsDescription: "NAD83 / New York Long Island (ftUS)", geodeticDatum: "NAD83", mapProjection: "Lambert Conformal Conic", mapZone: "3104", unit: "ussurveyfoot", eastings: 988100.25, northings: 211900.5, orthogonalHeight: 10.5, rotationDeg: 29, scale: 1 };
const UTM = { crsName: "EPSG:32618", unit: "metre", eastings: 585628.1, northings: 4511322.4, orthogonalHeight: 0 };
const wall = { id: "w1", type: "wall", name: "W", params: { start: [0, 0], end: [4, 0], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0" };
const levels = [{ id: "L0", name: "Ground", elevation: 0 }];
const exp = (opts) => exportAuthoredToIfc([wall], { schema: "IFC4", levels, timestamp: "2026-10-10T12:00:00Z", ...opts });
const lines = (text) => text.split("\n").filter((l) => /^#\d+=/.test(l));

t("validate accepts good input and names every bad field", () => {
  assert.deepEqual(G.validateGeoref(NY), []);
  assert.ok(G.validateGeoref(null).length);
  const bad = G.validateGeoref({ crsName: " ", unit: "cubit", eastings: NaN, northings: 1e12, orthogonalHeight: Infinity, scale: 0, rotationDeg: NaN });
  assert.deepEqual(bad.map((p) => p.field).sort(), ["crsName", "eastings", "northings", "orthogonalHeight", "rotationDeg", "scale", "unit"]);
});
t("IFC4 export carries IfcProjectedCRS + IfcMapConversion pointing at the model context (metre)", () => {
  const r = exp({ georef: UTM });
  assert.equal(r.stats.georeferenced, true);
  const L = lines(r.text);
  const ctx = L.find((l) => l.includes("IFCGEOMETRICREPRESENTATIONCONTEXT"));
  const ctxId = /^#(\d+)=/.exec(ctx)[1];
  const mc = L.find((l) => l.includes("IFCMAPCONVERSION("));
  assert.ok(mc.includes(`IFCMAPCONVERSION(#${ctxId},`), mc);
  assert.ok(L.some((l) => /IFCPROJECTEDCRS\('EPSG:32618',\$,\$,\$,\$,\$,#\d+\)/.test(l)));
  const back = G.readGeorefFromIfc(r.text);
  assert.deepEqual(back.problems, []);
  assert.equal(back.georef.crsName, "EPSG:32618"); assert.equal(back.georef.unit, "metre");
  assert.equal(back.georef.eastings, 585628.1); assert.equal(back.georef.northings, 4511322.4);
});
t("US survey foot: conversion-based unit with the exact factor, round-trips with rotation and datum fields", () => {
  const r = exp({ georef: NY });
  assert.ok(r.text.includes("IFCCONVERSIONBASEDUNIT(") && r.text.includes("'US survey foot'") && r.text.includes(`IFCLENGTHMEASURE(${1200 / 3937})`), "unit written");
  const b = G.readGeorefFromIfc(r.text).georef;
  assert.equal(b.unit, "ussurveyfoot");
  for (const k of ["crsName", "crsDescription", "geodeticDatum", "mapProjection", "mapZone", "eastings", "northings", "orthogonalHeight", "scale"]) assert.equal(b[k], NY[k], k);
  assert.ok(Math.abs(b.rotationDeg - 29) < 1e-6, "rotation " + b.rotationDeg);
});
t("international foot is distinguished from the US survey foot", () => {
  const b = G.readGeorefFromIfc(exp({ georef: { ...NY, unit: "foot" } }).text).georef;
  assert.equal(b.unit, "foot");
});
t("IFC2X3 does not pretend: no map conversion written and the reason is reported", () => {
  const r = exportAuthoredToIfc([wall], { schema: "IFC2X3", levels, georef: UTM });
  assert.equal(r.stats.georeferenced, false);
  assert.ok(/IFC2X3 has no IfcMapConversion/.test(r.stats.georefNote));
  assert.ok(!r.text.includes("IFCMAPCONVERSION"));
});
t("invalid georef is not written; the export still succeeds and says why", () => {
  const r = exp({ georef: { ...UTM, eastings: NaN } });
  assert.equal(r.stats.georeferenced, false);
  assert.ok(/not written/.test(r.stats.georefNote) && !r.text.includes("IFCMAPCONVERSION"));
  assert.ok(r.text.includes("IFCWALL"));
});
t("no georef → output has no map conversion (unchanged default)", () => {
  const r = exp({});
  assert.equal(r.stats.georeferenced, false); assert.equal(r.stats.georefNote, undefined);
  assert.ok(!r.text.includes("IFCMAPCONVERSION") && !r.text.includes("IFCPROJECTEDCRS"));
});
t("quotes and non-ASCII in the CRS text are escaped and survive the round trip", () => {
  const g = { ...UTM, crsDescription: "Réseau 'Lambert' — zone;1" };
  const text = exp({ georef: g }).text;
  assert.ok(!/[^\x00-\x7f]/.test(text), "file stays ASCII");
  assert.ok(G.readGeorefFromIfc(text).georef.crsDescription.includes("'Lambert'") && G.readGeorefFromIfc(text).georef.crsDescription.includes("zone;1"));
});
t("reader refuses non-georeferenced, broken and hostile text without throwing", () => {
  assert.equal(G.readGeorefFromIfc(exp({}).text).georef, null);
  assert.equal(G.readGeorefFromIfc("").georef, null);
  assert.equal(G.readGeorefFromIfc("#1=IFCMAPCONVERSION(#9,#9,1.,2.,3.,1.,0.,1.);").georef, null);
  const t0 = Date.now();
  G.readGeorefFromIfc("#1=A(".repeat(200000));
  G.readGeorefFromIfc("'".repeat(200000));
  assert.ok(Date.now() - t0 < 3000, "linear time on hostile input");
});
t("project holder: set/get/clear, invalid rejected, restore ignores junk", () => {
  G.setGeoref(NY); assert.equal(G.getGeoref().crsName, "EPSG:2263");
  assert.throws(() => G.setGeoref({ ...NY, scale: -1 }));
  assert.equal(G.getGeoref().scale, 1, "failed set leaves the previous value");
  assert.deepEqual(G.restoreGeoref({ crsName: "x" }).restored, false); assert.equal(G.getGeoref(), null);
  assert.equal(G.restoreGeoref(NY).restored, true); assert.equal(G.getGeoref().unit, "ussurveyfoot");
  assert.equal(G.restoreGeoref(undefined).restored, false); assert.equal(G.getGeoref(), null, "a project without one clears the previous project's");
  assert.ok(/not georeferenced/i.test(G.describeGeoref(null)) && /EPSG:2263/.test(G.describeGeoref(NY)));
});
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
