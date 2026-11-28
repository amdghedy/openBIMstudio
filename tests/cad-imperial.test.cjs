// Imperial units: feet-inch display (12'-6 1/2") and typed feet/inch input → drawing units.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "imp-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
try { fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* linked */ }
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
const run = (strict) => execSync(`npx tsc src/modules/cad-viewer/imperial.ts src/modules/cad-viewer/viewer-math.ts --outDir ${out} --module commonjs --target es2020 --moduleResolution node --esModuleInterop --skipLibCheck${strict ? " --strict" : ""}${flag}`, { stdio: "pipe", cwd: root });
try { run(true); } catch { run(false); }
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (f.name === "node_modules") continue; const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
const I = require(find("imperial.js")), V = require(find("viewer-math.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };
const F = V.formatFeetInches;

t("format: feet, inches, fractions", () => {
  assert.equal(F(150.5), `12'-6 1/2"`);
  assert.equal(F(144), `12'-0"`);
  assert.equal(F(6.25), `6 1/4"`);
  assert.equal(F(0.5), `1/2"`);
  assert.equal(F(0), `0"`);
  assert.equal(F(-18), `-1'-6"`);
});
t("format: rounding carries into inches and feet", () => {
  assert.equal(F(11.99), `1'-0"`);
  assert.equal(F(23.999), `2'-0"`);
  assert.equal(F(0.01), `0"`);
  assert.equal(F(5.5 + 1 / 64, 16), `5 1/2"`);
  assert.equal(F(Infinity), "n/a");
});
t("formatQty ft-in from every drawing unit", () => {
  assert.equal(V.formatQty(1, "ft", "ft-in"), `1'-0"`);
  assert.equal(V.formatQty(3.81, "m", "ft-in"), `12'-6"`);
  assert.equal(V.formatQty(3810, "mm", "ft-in"), `12'-6"`);
  assert.equal(V.formatQty(150.5, "in", "ft-in"), `12'-6 1/2"`);
  assert.equal(V.unitLabel("ft", "ft-in"), "in");
});
t("formatQty ft-in: areas stay decimal in ft², unitless is not relabelled", () => {
  assert.equal(V.formatQty(4, "ft", "ft-in", 2), "4.000 ft²");
  assert.equal(V.formatQty(5, undefined, "ft-in"), "5.000 units");
});
t("existing units unchanged; Architectural still maps to ft", () => {
  assert.equal(V.formatQty(1, "m", "mm"), "1000.0 mm");
  assert.equal(V.displayUnitForLengthType("Architectural"), "ft");
});
t("input: feet-inch forms in mm drawing", () => {
  const r = (s) => I.rewriteImperialInput(s, "mm").text;
  assert.equal(r("LINE 0,0 12'"), "LINE 0,0 3657.6");
  assert.equal(r("LINE 0,0 12'6\""), "LINE 0,0 3810");
  assert.equal(r("LINE 0,0 12'-6\""), "LINE 0,0 3810");
  assert.equal(r("LINE 0,0 12'-6 1/2\""), "LINE 0,0 3822.7");
  assert.equal(r("OFFSET 10\""), "OFFSET 254");
  assert.equal(r("OFFSET 1/2\""), "OFFSET 12.7");
  assert.equal(r("OFFSET 3.5'"), "OFFSET 1066.8");
});
t("input: drawing in ft / in / m", () => {
  assert.equal(I.rewriteImperialInput("OFFSET 6\"", "ft").text, "OFFSET 0.5");
  assert.equal(I.rewriteImperialInput("OFFSET 2'", "in").text, "OFFSET 24");
  assert.equal(I.rewriteImperialInput("OFFSET 10'", "m").text, "OFFSET 3.048");
});
t("input: coordinates, @relative and negatives", () => {
  assert.equal(I.rewriteImperialInput("LINE 0,0 @10',5'", "ft").text, "LINE 0,0 @10,5");
  assert.equal(I.rewriteImperialInput("MOVE -2'", "ft").text, "MOVE -2");
});
t("input: no change when no feet/inch token, and decimals untouched", () => {
  const r = I.rewriteImperialInput("LINE 0,0 100,50", "mm");
  assert.equal(r.changed, false); assert.equal(r.text, "LINE 0,0 100,50");
});
t("input: text-bearing commands are never rewritten", () => {
  for (const c of [`TEXT 0,0 5 Door 36"`, `LAYER NEW A-WALL-12'`, `MTEXT 12'6"`]) {
    const r = I.rewriteImperialInput(c, "mm"); assert.equal(r.changed, false, c); assert.equal(r.text, c);
  }
});
t("input: unitless or unknown drawing refuses instead of guessing", () => {
  for (const u of ["unitless", undefined]) {
    const r = I.rewriteImperialInput("OFFSET 10'", u);
    assert.ok(r.error && /units/i.test(r.error)); assert.equal(r.text, "OFFSET 10'"); assert.equal(r.changed, false);
  }
});
t("input: zero denominator and absurd values are errors, not NaN/Infinity", () => {
  assert.ok(I.rewriteImperialInput("OFFSET 1/0\"", "mm").error);
  assert.ok(I.rewriteImperialInput("OFFSET 99999999999'", "mm").error);
});
t("input: words that merely contain quotes are not mangled", () => {
  const r = I.rewriteImperialInput("OFFSET a10'b", "mm"); assert.equal(r.changed, false);
});
t("input: hostile long line stays linear", () => {
  const s = "LINE " + "1'".repeat(1) + " 2".repeat(50000) + "'".repeat(50000);
  const t0 = Date.now(); I.rewriteImperialInput(s, "mm"); assert.ok(Date.now() - t0 < 2000);
});
console.log(`cad-imperial: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
