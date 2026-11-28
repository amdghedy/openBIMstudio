// Paper sizes: one exact registry shared by sheets, CAD layouts, plotting and region defaults (US + ISO).
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "paper-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
try { fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* linked */ }
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
const run = (strict) => execSync(`npx tsc src/core/paper-sizes.ts src/modules/sheets/sheets.ts src/core/region.ts src/modules/cad-viewer/viewer-math.ts src/modules/native-bim/documentation-validation.ts --outDir ${out} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck${strict ? " --strict" : ""}${flag}`, { stdio: "pipe", cwd: root });
try { run(true); } catch { run(false); }
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (f.name === "node_modules") continue; const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
global.localStorage = { _m: new Map(), getItem(k) { return this._m.has(k) ? this._m.get(k) : null; }, setItem(k, v) { this._m.set(k, String(v)); }, removeItem(k) { this._m.delete(k); } };
const P = require(find("paper-sizes.js")), S = require(find("sheets.js")), R = require(find("region.js")), V = require(find("viewer-math.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };
const near = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-6, `${m} ${a} vs ${b}`);

t("US sizes are exact (inches × 25.4)", () => {
  const d = (id) => P.paperDef(id);
  near(d("Arch-D").w, 914.4, "Arch D long"); near(d("Arch-D").h, 609.6, "Arch D short");
  near(d("ANSI-D").w, 863.6, "ANSI D"); near(d("ANSI-D").h, 558.8, "ANSI D");
  near(d("ANSI-A").w, 279.4, "Letter long"); near(d("ANSI-A").h, 215.9, "Letter short");
  near(d("ANSI-B").w, 431.8, "Tabloid"); near(d("Arch-E1").w, 1066.8, "E1"); near(d("Legal").w, 355.6, "Legal");
  near(d("A1").w, 841, "A1"); near(d("A1").h, 594, "A1");
});
t("every size has w ≥ h, a unique id, and resolves by id", () => {
  const seen = new Set();
  for (const p of P.PAPER_SIZES) { assert.ok(p.w >= p.h, p.id); assert.ok(!seen.has(p.id), "dup " + p.id); seen.add(p.id); assert.equal(P.paperDef(p.id).id, p.id); }
  assert.ok(P.PAPER_SIZES.length >= 17);
});
t("aliases and legacy spellings resolve, case-insensitively; unknown falls back", () => {
  assert.equal(P.paperDef("Letter").id, "ANSI-A"); assert.equal(P.paperDef("tabloid").id, "ANSI-B"); assert.equal(P.paperDef("Ledger").id, "ANSI-B");
  assert.equal(P.paperDef("ARCH-E1").id, "Arch-E1"); assert.equal(P.paperDef(" arch-d ").id, "Arch-D");
  assert.equal(P.paperDef("Foolscap"), undefined); assert.equal(P.paperDef(null), undefined); assert.equal(P.paperDef(42), undefined);
  assert.equal(P.normalizePaperId("Foolscap", "A3"), "A3"); assert.equal(P.normalizePaperId("Letter"), "ANSI-A");
});
t("page size honours orientation", () => {
  assert.deepEqual(P.paperSizeMm("Arch-D", "landscape"), { w: 914.4, h: 609.6 });
  assert.deepEqual(P.paperSizeMm("Arch-D", "portrait"), { w: 609.6, h: 914.4 });
  assert.deepEqual(P.paperSizeMm("nonsense", "landscape", "A4"), { w: 297, h: 210 });
});
t("paperIdForMm identifies a page in either orientation", () => {
  assert.equal(P.paperIdForMm(914.4, 609.6), "Arch-D"); assert.equal(P.paperIdForMm(609.6, 914.4), "Arch-D");
  assert.equal(P.paperIdForMm(841, 594), "A1"); assert.equal(P.paperIdForMm(500, 500), null);
});
t("sheets use the registry: US sizes are valid page sizes, and unknown sizes fall back to A1", () => {
  assert.deepEqual(S.getSheetSizeMm("Arch-D", "landscape"), { w: 914.4, h: 609.6 });
  assert.deepEqual(S.getSheetSizeMm("ANSI-A", "portrait"), { w: 215.9, h: 279.4 });
  assert.deepEqual(S.getSheetSizeMm("bogus", "landscape"), { w: 841, h: 594 });
});
t("new sheets follow the region's paper (US → Arch D; international → A1)", () => {
  R.region.boot();
  R.region.setProfile("intl"); assert.equal(S.createSheet().size, "A1");
  R.region.setProfile("us"); const s = S.createSheet(); assert.equal(s.size, "Arch-D"); assert.equal(R.region.getResolved().paper, "Arch-D");
  R.region.setOverride({ paper: "ANSI-B" }); assert.equal(S.createSheet().size, "ANSI-B");
  assert.equal(S.createSheet({ size: "A3" }).size, "A3", "explicit size wins");
  R.region.setProfile("intl");
});
t("setSheetPaper changes size/orientation, returns the previous values, rejects unknown sheets and sizes", () => {
  const s = S.createSheet({ size: "A1" });
  const prev = S.setSheetPaper(s.id, "Arch-C", "portrait");
  assert.deepEqual(prev, { size: "A1", orientation: "landscape" });
  assert.equal(S.getSheet(s.id).size, "Arch-C"); assert.equal(S.getSheet(s.id).orientation, "portrait");
  S.setSheetPaper(s.id, "Foolscap"); assert.equal(S.getSheet(s.id).size, "Arch-C", "unknown size keeps the current one");
  assert.equal(S.setSheetPaper("nope", "A4"), null);
});
t("CAD layout paper table keeps its names and gains the US sizes", () => {
  assert.deepEqual(V.PAPER_MM.Letter, [215.9, 279.4]); assert.deepEqual(V.PAPER_MM.A3, [297, 420]);
  assert.deepEqual(V.PAPER_MM["Arch-D"], [609.6, 914.4]); assert.deepEqual(V.PAPER_MM["ANSI-D"], [558.8, 863.6]);
  assert.equal(V.paperNameForMm(215.9, 279.4), "Letter", "existing name is preserved");
  assert.equal(V.paperNameForMm(609.6, 914.4), "Arch-D");
  assert.deepEqual(V.paperMm("Arch-D", true), { w: 914.4, h: 609.6 });
});
t("documentation validation accepts every registry size", () => {
  const D = require(find("documentation-validation.js"));
  for (const p of P.PAPER_SIZES) {
    const out = D.validateDocumentationSet({ sheets: [{ id: "s", number: "A-1", name: "n", size: p.id, orientation: "landscape", viewports: [] }], views: [], sheetSizesMm: { s: { w: p.w, h: p.h } } });
    assert.ok(!out.some((d) => /size/i.test(d.message) && /unknown|invalid|unsupported/i.test(d.message)), p.id + ": " + JSON.stringify(out));
  }
});
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
