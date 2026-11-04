// Native annotation rendering — DIMENSION without a geometry block, LEADER
// arrows + inline text, DIMSTYLE values, and real glyphs for tiny text.
//
// AutoCAD never needs an anonymous block to draw a dimension: it computes the
// geometry from the definition points. Third-party writers often omit the
// block, and the editor used to skip the whole DIMENSION (missing annotations
// in civil/bridge drawings). Same for LEADER: the arrowhead and the inline
// annotation text were dropped. And text smaller than 3 px on screen was
// drawn as a placeholder line — the long "stripes" users reported instead of
// native-looking text.
//
// The suite compiles the real dxf-reader.ts and parses real DXF content:
//   1. DIMSTYLE table values land on doc.dimStyleTable (40/140/41/42/44/147).
//   2. Rotated-linear DIMENSION (no block) -> 2 extension lines, dim line,
//      2 filled arrows, measurement text with the style's text height.
//   3. Aligned DIMENSION -> measurement along the true point distance.
//   4. Radius / diameter DIMENSION -> R / ⌀ prefix, arrow on the curve.
//   5. DIMENSION with an anonymous block still expands the block (no double draw).
//   6. LEADER: arrowhead triangle + inline text; no arrow when flag 71 = 0.
//   7. cad-viewer draws real text down to 0.75 px (drift guard).
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cad-ann-"));
execSync(`npx tsc src/modules/drawings/dxf-reader.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "ignore", cwd: path.join(__dirname, "..") });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const { parseDxf } = require(find(out, "dxf-reader.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const D = (...a) => a.flat().map(String).filter(x => x !== "").join("\n");
const sec = (name, body) => D("0", "SECTION", "2", name, body, "0", "ENDSEC");
const file = (o = {}) => D(o.header ? sec("HEADER", o.header) : "", o.tables ? sec("TABLES", o.tables) : "", o.blocks ? sec("BLOCKS", o.blocks) : "", sec("ENTITIES", o.ents || ""), "0", "EOF");

const DIMSTYLE_TABLE = sec("TABLES", D(
  D("0", "TABLE", "2", "DIMSTYLE", "70", "1",
    "0", "DIMSTYLE", "2", "ISO-25", "70", "0", "40", "10", "140", "3.5", "41", "2.5", "42", "0.8", "44", "1.6", "147", "0.9",
    "0", "ENDTAB"),
));

const TYPES = () => {
  const doc = parseDxf(file({ tables: DIMSTYLE_TABLE, ents: "" }));
  return doc.dimStyleTable?.["ISO-25"];
};

t("DIMSTYLE table values read into doc.dimStyleTable", () => {
  const st = TYPES();
  assert.ok(st, "ISO-25 missing from dimStyleTable");
  assert.strictEqual(st.scale, 10);       // DIMSCALE 40
  assert.strictEqual(st.textHeight, 3.5); // DIMTXT 140
  assert.strictEqual(st.arrowSize, 2.5);  // DIMASZ 41
  assert.strictEqual(st.extOffset, 0.8);  // DIMEXO 42
  assert.strictEqual(st.extExtend, 1.6);  // DIMEXE 44
  assert.strictEqual(st.textGap, 0.9);    // DIMGAP 147
  assert.ok(parseDxf(file({ tables: DIMSTYLE_TABLE, ents: "" })).dimStyles, "names list dropped");
});

// Rotated linear dimension: p1=(0,0) p2=(100,0), dim line at y=20, rotation 0.
const LIN_DIM = D(
  "0", "DIMENSION", "8", "DIM", "70", "0", "3", "ISO-25",
  "13", "0", "23", "0", "14", "100", "24", "0", "10", "50", "20", "20",
  "50", "0", "1", "<>",
);

t("rotated linear DIMENSION without block -> native geometry + text", () => {
  const d = parseDxf(file({ tables: DIMSTYLE_TABLE, ents: LIN_DIM }));
  assert.ok(!d.skipped?.DIMENSION, "DIMENSION skipped instead of drawn");
  const lines = d.entities.filter((e) => e.type === "LINE");
  assert.strictEqual(lines.length, 3, `expected 2 ext + 1 dim line, got ${lines.length}`);
  // Dim line runs between the projected origins at y=20.
  const dimLine = lines.find((l) => Math.abs(l.start.y - 20) < 1e-9 && Math.abs(l.end.y - 20) < 1e-9);
  assert.ok(dimLine, "dimension line missing");
  assert.ok(Math.abs(dimLine.start.x) < 1e-9 && Math.abs(dimLine.end.x - 100) < 1e-9);
  // Arrowheads are filled triangles.
  const arrows = d.entities.filter((e) => e.type === "LWPOLYLINE" && e.hatch?.solid);
  assert.strictEqual(arrows.length, 2, "arrowheads missing");
  // Text: measurement text height = DIMTXT(3.5) × DIMSCALE(10) = 35, value "100.00", centred.
  const texts = d.entities.filter((e) => e.type === "TEXT");
  assert.strictEqual(texts.length, 1, "measurement text missing");
  assert.strictEqual(texts[0].value, "100.00");
  assert.strictEqual(texts[0].height, 35);
  assert.strictEqual(texts[0].align, "center");
  // Text sits above the dim line midpoint (50, >20).
  assert.ok(Math.abs(texts[0].position.x - 50) < 1e-9);
  assert.ok(texts[0].position.y > 20);
});

t("aligned DIMENSION measures the true point distance", () => {
  const d = parseDxf(file({ tables: DIMSTYLE_TABLE, ents: D(
    "0", "DIMENSION", "8", "DIM", "70", "1", "3", "ISO-25",
    "13", "0", "23", "0", "14", "30", "24", "40", "10", "60", "20", "50",
  ) }));
  const texts = d.entities.filter((e) => e.type === "TEXT");
  assert.strictEqual(texts.length, 1);
  assert.strictEqual(texts[0].value, "50.00"); // sqrt(30^2 + 40^2)
  assert.ok(!d.skipped?.DIMENSION);
});

t("radius / diameter DIMENSION get R / ⌀ text and an arrow on the curve", () => {
  const rad = parseDxf(file({ tables: DIMSTYLE_TABLE, ents: D(
    "0", "DIMENSION", "8", "DIM", "70", "4", "3", "ISO-25",
    "10", "0", "20", "0", "15", "25", "25", "0", "40", "10",
  ) }));
  const rt = rad.entities.find((e) => e.type === "TEXT");
  assert.ok(rt, "radius text missing");
  assert.strictEqual(rt.value, "R25.00");
  assert.strictEqual(rad.entities.filter((e) => e.type === "LWPOLYLINE" && e.hatch?.solid).length, 1);

  const dia = parseDxf(file({ tables: DIMSTYLE_TABLE, ents: D(
    "0", "DIMENSION", "8", "DIM", "70", "3", "3", "ISO-25",
    "10", "0", "20", "0", "15", "25", "25", "0",
  ) }));
  const dt = dia.entities.find((e) => e.type === "TEXT");
  assert.ok(dt, "diameter text missing");
  assert.strictEqual(dt.value, "⌀50.00");
  assert.strictEqual(dia.entities.filter((e) => e.type === "LINE").length, 1);
});

t("DIMENSION with anonymous block still expands the block", () => {
  const d = parseDxf(file({
    blocks: sec("BLOCKS", D(
      "0", "BLOCK", "2", "*D1", "10", "0", "20", "0", "30", "0",
      "0", "LINE", "8", "DIM", "10", "0", "20", "0", "11", "5", "21", "0",
      "0", "ENDBLK",
    )),
    ents: D("0", "DIMENSION", "8", "DIM", "70", "0", "2", "*D1", "13", "0", "23", "0", "14", "9", "24", "0", "10", "4", "20", "0"),
  }));
  assert.ok(d.entities.some((e) => e.type === "LINE"), "block not expanded");
  assert.strictEqual(d.entities.filter((e) => e.type === "TEXT").length, 0, "native text drawn alongside block (double draw)");
});

const LEADER = (flag) => D(
  "0", "LEADER", "8", "NOTES", "70", "3", flag != null ? D("71", String(flag)) : "",
  "10", "0", "20", "0", "10", "20", "20", "10", "10", "30", "20", "10",
  "40", "6", "41", "2.5", "1", "START",
);

t("LEADER: arrowhead triangle + inline annotation text", () => {
  const d = parseDxf(file({ ents: LEADER(1) }));
  const arrows = d.entities.filter((e) => e.type === "LWPOLYLINE" && e.hatch?.solid);
  assert.strictEqual(arrows.length, 1, "arrowhead missing");
  // The leader polyline itself (3 vertices) plus the arrow triangle.
  const paths = d.entities.filter((e) => e.type === "LWPOLYLINE" && !e.hatch);
  assert.strictEqual(paths.length, 1);
  assert.strictEqual(paths[0].points.length, 3);
  const txt = d.entities.find((e) => e.type === "TEXT");
  assert.ok(txt, "inline LEADER text missing");
  assert.strictEqual(txt.value, "START");
  assert.strictEqual(txt.height, 2.5);
  // Text is placed past the last vertex (x > 30).
  assert.ok(txt.position.x > 30);
});

t("LEADER without arrowhead flag (71=0) draws no arrow", () => {
  const d = parseDxf(file({ ents: LEADER(0) }));
  assert.strictEqual(d.entities.filter((e) => e.type === "LWPOLYLINE" && e.hatch?.solid).length, 0);
  assert.ok(d.entities.some((e) => e.type === "TEXT"));
});

t("cad-viewer draws real glyphs down to 0.75 px (drift guard)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "features", "cad-viewer.ts"), "utf8");
  assert.ok(src.includes("if (px < 0.75) {"), "tiny-text threshold drifted");
  assert.ok(!/\n\s*if \(px < 3\) \{/.test(src), "old 3px placeholder threshold still present");
  assert.ok(src.includes("Native CAD keeps drawing real glyphs at any zoom"), "explanatory comment missing");
});

fs.rmSync(out, { recursive: true, force: true });
console.log(`\ncad-native-annotation: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
