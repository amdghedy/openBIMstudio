// US NCS layer-name check: structural validation of CAD layer names + audit; also audits our own 3D-DXF export layers.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ncs-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
try { fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* linked */ }
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
const run = (strict) => execSync(`npx tsc src/modules/cad-viewer/ncs-layers.ts src/modules/export/model-to-dxf3d.ts --outDir ${out} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck${strict ? " --strict" : ""}${flag}`, { stdio: "pipe", cwd: root });
try { run(true); } catch { run(false); }
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (f.name === "node_modules") continue; const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
const N = require(find("ncs-layers.js")), X = require(find("model-to-dxf3d.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };

t("conforming names pass", () => {
  for (const n of ["A-WALL", "A-WALL-FULL", "A-DOOR-IDEN-N", "S-BEAM", "E-POWR", "A-GLAZ-CWMG", "AD-WALL", "C-ROAD-CURB-E", "I-FURN", "M-DUCT"]) assert.ok(N.checkNcsLayerName(n).ok, n);
});
t("non-conforming names fail with a reason", () => {
  for (const n of ["WALLS", "Walls-1", "A_WALL", "A-WALLS", "A-WAL", "A-WALL-FULL-DIMS-EXTRA-N", "A-", "-WALL", "A-WALL FULL", "A-DOOR-IDENTIFIER"]) {
    const r = N.checkNcsLayerName(n); assert.ok(!r.ok && r.issues.length, n);
  }
});
t("unknown discipline letter is rejected", () => {
  const r = N.checkNcsLayerName("K-WALL"); assert.ok(!r.ok && /discipline/i.test(r.issues.join(" ")));
});
t("lower-case is flagged, not silently accepted", () => {
  const r = N.checkNcsLayerName("a-wall"); assert.ok(!r.ok && /upper/i.test(r.issues[0]));
});
t("system layers exempt; xref layers judged on their own part", () => {
  assert.ok(N.checkNcsLayerName("0").exempt && N.checkNcsLayerName("Defpoints").exempt);
  assert.ok(N.checkNcsLayerName("site|A-WALL").ok);
  assert.ok(!N.checkNcsLayerName("site|walls").ok);
});
t("audit counts and de-duplicates", () => {
  const a = N.auditNcsLayers(["0", "A-WALL", "A-WALL", "walls", "S-BEAM", "Defpoints"]);
  assert.equal(a.total, 5); assert.equal(a.conforming, 2); assert.equal(a.exempt, 2); assert.deepEqual(a.offenders.map((o) => o.layer), ["walls"]);
});
t("empty/garbage input never throws", () => {
  for (const v of ["", " ", null, undefined, "|", "a|"]) assert.doesNotThrow(() => N.checkNcsLayerName(v));
  assert.ok(!N.checkNcsLayerName("").ok);
});
t("our export maps: common building types are NCS-shaped", () => {
  for (const ty of ["wall", "slab", "floor", "roof", "door", "window", "stair", "ceiling", "column", "beam", "footing", "duct", "pipe"])
    assert.ok(N.checkNcsLayerName(X.layerForElementType(ty)).ok, ty + " → " + X.layerForElementType(ty));
  for (const c of ["IFCWALL", "IFCSLAB", "IFCROOF", "IFCCOLUMN", "IFCBEAM", "IFCDOOR", "IFCWINDOW", "IFCCURTAINWALL", "IFCSPACE", "IFCDUCTSEGMENT"])
    assert.ok(N.checkNcsLayerName(X.layerForIfcCategory(c)).ok, c + " → " + X.layerForIfcCategory(c));
});
t("KNOWN GAP pinned: cable tray/conduit and unknown-type fallbacks are not NCS-shaped (flagged by the audit)", () => {
  assert.ok(!N.checkNcsLayerName(X.layerForElementType("cabletray")).ok);
  assert.ok(!N.checkNcsLayerName(X.layerForElementType("weird type!")).ok);
});
console.log(`cad-ncs-layers: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
