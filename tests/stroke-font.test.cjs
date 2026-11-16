/* Stroke fonts for SHX text: mapping, glyph parsing and layout. */
const { execSync } = require("child_process"); const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "strokef-"));
execSync(`npx tsc src/modules/drawings/stroke-font.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`, { stdio: "pipe" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const S = require(find(out, "stroke-font.js"));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n) } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message) } };

t("SHX names map to the right Hershey set; TrueType names are left alone", () => {
  assert.strictEqual(S.strokeSetFor("romans.shx"), "rowmans"); assert.strictEqual(S.strokeSetFor("SIMPLEX"), "rowmans");
  assert.strictEqual(S.strokeSetFor("isocpeur.shx"), "rowmans"); assert.strictEqual(S.strokeSetFor("romanc.shx"), "rowmand");
  assert.strictEqual(S.strokeSetFor("romant"), "rowmant"); assert.strictEqual(S.strokeSetFor("italicc.shx"), "timesi");
  assert.strictEqual(S.strokeSetFor("scriptc.shx"), "scripts");
  for (const n of ["Arial", "Tahoma", "Simplified Arabic", "monotxt.shx", "", undefined]) assert.strictEqual(S.strokeSetFor(n), undefined, String(n));
});
t("every printable ASCII char has a glyph in every set, caps sit on the baseline and reach ~21 units", () => {
  for (const set of ["rowmans", "rowmand", "rowmant", "timesi", "scripts"]) {
    const f = S.strokeFont(set);
    for (let c = 33; c < 127; c++) assert.ok(f.glyph(String.fromCharCode(c)), set + " missing " + c);
    assert.strictEqual(f.glyph(" ").strokes.length, 0, "space has no strokes");
    const H = f.glyph("H"); const ys = H.strokes.flat().map((p) => p[1]);
    assert.strictEqual(Math.max(...ys), 0, set + " H baseline"); assert.ok(Math.min(...ys) <= -20 && Math.min(...ys) >= -22, set + " H cap height " + Math.min(...ys));
  }
});
t("'I' in romans is a single vertical line; 'H' has three strokes", () => {
  const f = S.strokeFont("rowmans");
  assert.strictEqual(f.glyph("I").strokes.length, 1); assert.strictEqual(f.glyph("H").strokes.length, 3);
});
t("line width is the sum of advances and layout offsets glyphs", () => {
  const f = S.strokeFont("rowmans");
  const w1 = S.strokeLineWidth(f, "A"), w3 = S.strokeLineWidth(f, "AAA");
  assert.ok(w1 > 10 && Math.abs(w3 - 3 * w1) < 1e-9);
  const poly = S.strokeLinePolylines(f, "II");
  assert.ok(Math.abs(poly[1][0][0] - poly[0][0][0] - f.glyph("I").adv) < 1e-9, "2nd glyph offset by the 1st advance");
});
t("unsupported characters (e.g. Arabic) make the line fall back to the normal font", () => {
  const f = S.strokeFont("rowmans");
  assert.strictEqual(S.strokeLineWidth(f, "باب"), null); assert.strictEqual(S.strokeLinePolylines(f, "A°"), null);
});
console.log(`stroke-font: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
