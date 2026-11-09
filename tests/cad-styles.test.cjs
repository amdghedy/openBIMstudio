// CAD styles: linetype/font libraries and a DXF write -> read round trip that keeps them.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cad-styles-"));
execFileSync("npx", ["tsc", "--rootDir", "src", "--outDir", out, "--module", "commonjs", "--target", "ES2022", "--skipLibCheck", "--noCheck", "src/modules/drawings/dxf-writer.ts", "src/modules/drawings/dxf-reader.ts", "src/modules/drawings/cad-styles.ts"], { stdio: "inherit" });
const dir = path.join(out, "modules/drawings");
const S = require(path.join(dir, "cad-styles.js"));
const { writeDxf } = require(path.join(dir, "dxf-writer.js"));
const { parseDxf } = require(path.join(dir, "dxf-reader.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

t("linetype library has the standard DWG set with valid patterns", () => {
  assert.ok(S.LINETYPE_LIBRARY.length >= 35);
  const names = new Set();
  for (const l of S.LINETYPE_LIBRARY) {
    assert.ok(!names.has(l.name), "duplicate " + l.name); names.add(l.name);
    assert.ok(l.pattern.length >= 2 && l.pattern.some((v) => v < 0) && l.pattern.length % 2 === 0, l.name);
  }
  for (const n of ["DASHED", "HIDDEN", "CENTER", "PHANTOM", "DASHDOT", "DIVIDE", "BORDER", "ACAD_ISO02W100", "ACAD_ISO15W100"]) assert.ok(S.findLinetype(n), n);
  assert.ok(S.findLinetype(" dashed "));
});
t("patterns scale to the drawing units", () => {
  const d = S.findLinetype("DASHED");
  assert.deepStrictEqual(S.scaledPattern(d, "mm"), [12.7, -6.35]);
  assert.ok(Math.abs(S.scaledPattern(d, "m")[0] - 0.0127) < 1e-9);
  assert.ok(Math.abs(S.scaledPattern(d, "in")[0] - 0.5) < 1e-9);
  assert.strictEqual(S.scaledPattern(S.findLinetype("DOT"), "m")[0], 0);
});
t("ensureLinetypes adds only missing library names and ignores built-ins", () => {
  const doc = { units: "mm", linetypes: { DASHED: [1, -1] } };
  const added = S.ensureLinetypes(doc, ["Dashed", "hidden", "Continuous", "ByLayer", "NOPE"]);
  assert.deepStrictEqual(added, ["HIDDEN"]);
  assert.deepStrictEqual(doc.linetypes.DASHED, [1, -1]); // existing definition kept
  assert.ok(!doc.linetypes.NOPE);
});
t("lineweights: nearest, DXF encode/decode", () => {
  assert.strictEqual(S.nearestLineweight(0.27), 0.25);
  assert.strictEqual(S.lineweightToDxf(0.5), 50);
  assert.strictEqual(S.lineweightFromDxf(25), 0.25);
  assert.strictEqual(S.lineweightFromDxf(-1), undefined);
  assert.strictEqual(S.lineweightFromDxf(-3), undefined);
});
t("fonts: lookup by id, file and label; DXF file names", () => {
  assert.ok(S.CAD_FONTS.length >= 25);
  assert.strictEqual(S.findFont("ARIAL").id, "Arial");
  assert.strictEqual(S.findFont("simplex.shx").kind, "stroke");
  assert.strictEqual(S.findFont("Consolas").kind, "mono");
  assert.strictEqual(S.fontDxfFile("Arial"), "arial.ttf");
  assert.strictEqual(S.fontDxfFile("Some Font"), "somefont.ttf");
  assert.strictEqual(S.fontDxfFile("custom.shx"), "custom.shx");
  assert.ok(S.isTrueTypeFont("Arial") && !S.isTrueTypeFont("simplex.shx"));
});
t("text styles apply to a TEXT without mutating it", () => {
  const e = { type: "TEXT", layer: "0", position: { x: 0, y: 0 }, height: 1, value: "x", widthFactor: 2, bold: true };
  const st = S.TEXT_STYLE_PRESETS.find((s) => s.name === "ISO 3098");
  const r = S.applyTextStyle(e, st);
  assert.strictEqual(r.font, "isocpeur.shx"); assert.strictEqual(r.height, 3.5); assert.strictEqual(r.oblique, 15); assert.strictEqual(r.italic, true);
  assert.ok(!("bold" in r) && !("widthFactor" in r));
  assert.strictEqual(e.height, 1); assert.strictEqual(e.bold, true);
  assert.strictEqual(S.applyTextStyle(e, st, { keepHeight: true }).height, 1);
});

const doc = {
  units: "mm", ltscale: 2,
  layers: [
    { name: "0", color: 7 },
    { name: "Walls", color: 3, lineType: "HIDDEN", lineweight: 0.5 },
    { name: "Frozen", color: 5, frozen: true },
    { name: "Locked", color: 1, locked: true },
    { name: "Off", color: 2, off: true },
  ],
  linetypes: { MYSPECIAL: [10, -2, 0, -2] },
  entities: [
    { type: "LINE", layer: "Walls", start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
    { type: "LINE", layer: "0", lineType: "CENTER", lineweight: 0.35, rgb: 0xff8800, color: 30, start: { x: 0, y: 5 }, end: { x: 100, y: 5 } },
    { type: "LINE", layer: "0", lineType: "MYSPECIAL", start: { x: 0, y: 9 }, end: { x: 10, y: 9 } },
    { type: "TEXT", layer: "0", position: { x: 5, y: 5 }, height: 3, value: "Hello", font: "Arial", bold: true, italic: true, widthFactor: 0.8, oblique: 12, align: "center", valign: "middle", rotation: 30 },
    { type: "TEXT", layer: "0", position: { x: 5, y: 15 }, height: 2.5, value: "Stroke", font: "simplex.shx" },
    { type: "TEXT", layer: "0", position: { x: 5, y: 25 }, height: 2.5, value: "Plain" },
  ],
};
const text = writeDxf(doc);
const back = parseDxf(text);
t("write -> read keeps layer linetype, lineweight, frozen, locked, off", () => {
  const L = Object.fromEntries(back.layers.map((l) => [l.name, l]));
  assert.strictEqual(String(L.Walls.lineType).toUpperCase(), "HIDDEN");
  assert.strictEqual(L.Walls.lineweight, 0.5);
  assert.ok(L.Frozen.frozen && !L.Frozen.locked);
  assert.ok(L.Locked.locked && !L.Locked.frozen);
  assert.ok(L.Off.off && L.Off.color === 2);
});
t("write -> read keeps entity linetype, lineweight and true colour", () => {
  const e = back.entities.find((x) => x.lineType && x.lineType.toUpperCase() === "CENTER");
  assert.ok(e, "centre line survived");
  assert.strictEqual(e.lineweight, 0.35); assert.strictEqual(e.rgb, 0xff8800); assert.strictEqual(e.color, 30);
});
t("linetype definitions are written: custom ones kept, library ones added when used", () => {
  assert.deepStrictEqual(back.linetypes.MYSPECIAL, [10, -2, 0, -2]);
  assert.deepStrictEqual(back.linetypes.CENTER, [31.75, -6.35, 6.35, -6.35]);
  assert.deepStrictEqual(back.linetypes.HIDDEN, [6.35, -3.175]);
  assert.strictEqual(back.ltscale, 2);
});
t("write -> read keeps text font, bold/italic, width, oblique, anchor, rotation", () => {
  const e = back.entities.find((x) => x.type === "TEXT" && x.value === "Hello");
  assert.strictEqual(e.font, "Arial"); assert.ok(e.bold && e.italic);
  assert.ok(Math.abs(e.widthFactor - 0.8) < 1e-9 && Math.abs(e.oblique - 12) < 1e-9);
  assert.strictEqual(e.align, "center"); assert.strictEqual(e.valign, "middle");
  assert.strictEqual(e.rotation, 30); assert.deepStrictEqual([e.position.x, e.position.y], [5, 5]);
  const s = back.entities.find((x) => x.type === "TEXT" && x.value === "Stroke");
  assert.strictEqual(s.font, "simplex.shx");
  const p = back.entities.find((x) => x.type === "TEXT" && x.value === "Plain");
  assert.ok(!p.bold && !p.italic && (!p.font || p.font === "Arial"));
});
t("a second write of the read-back document is stable (idempotent round trip)", () => {
  const again = parseDxf(writeDxf(back));
  assert.deepStrictEqual(again.entities.map((e) => [e.type, e.layer, e.lineType, e.lineweight, e.rgb, e.font]), back.entities.map((e) => [e.type, e.layer, e.lineType, e.lineweight, e.rgb, e.font]));
});
t("DXF structure: unique handles and balanced sections", () => {
  const handles = [...text.matchAll(/\n5\n([0-9A-F]+)\n/g)].map((m) => m[1]);
  const record = handles.filter((h) => h.length >= 3);
  assert.strictEqual(new Set(record).size, record.length, "duplicate handles");
  assert.strictEqual((text.match(/\n0\nSECTION\n/g) || []).length + (text.startsWith("0\nSECTION") ? 1 : 0), (text.match(/\n0\nENDSEC\n/g) || []).length);
  assert.ok(!/NaN|undefined|Infinity/.test(text));
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
