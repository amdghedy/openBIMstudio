// DWG table/entity reading fidelity — DXF tables round-trip.
//
// The CAD editor must read the drawing like DWG does: layer true colour /
// transparency / plot flag, the STYLE table (fixed height, backwards /
// upside-down, big font), the DIMSTYLE table, per-entity linetype scale and
// transparency, MTEXT inline colours, and fixed-height styles driving
// zero-height TEXT. Written DXF keeps the same fields.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cad-tab-"));
execSync(`npx tsc src/modules/drawings/dxf-reader.ts src/modules/drawings/dxf-writer.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "ignore" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const { parseDxf } = require(find(out, "dxf-reader.js"));
const { writeDxf } = require(find(out, "dxf-writer.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const D = (...a) => a.flat().map(String).filter(x => x !== "").join("\n");
const sec = (name, body) => D("0", "SECTION", "2", name, body, "0", "ENDSEC");
const file = (o = {}) => D(o.header ? sec("HEADER", o.header) : "", o.tables ? sec("TABLES", o.tables) : "", o.blocks ? sec("BLOCKS", o.blocks) : "", sec("ENTITIES", o.ents || ""), o.objects ? sec("OBJECTS", o.objects) : "", "0", "EOF");

const TABLES = sec("TABLES", D(
  D(
    "0", "TABLE", "2", "LAYER", "70", "2",
    "0", "LAYER", "2", "TrueCol", "70", "0", "62", "7", "420", "863045", "440", "30", "290", "0", "6", "Continuous",
    "0", "LAYER", "2", "Plain", "70", "0", "62", "3", "6", "HIDDEN",
    "0", "ENDTAB"),
  D(
    "0", "TABLE", "2", "STYLE", "70", "2",
    "0", "STYLE", "2", "FIXED", "70", "0", "40", "3.5", "41", "0.8", "50", "15", "71", "2", "3", "simplex.shx", "4", "bigfont.shx",
    "0", "STYLE", "2", "STANDARD", "70", "0", "40", "0", "41", "1", "50", "0", "71", "0", "3", "txt.shx",
    "0", "ENDTAB"),
  D(
    "0", "TABLE", "2", "DIMSTYLE", "70", "1",
    "0", "DIMSTYLE", "2", "ISO-25", "70", "0", "3", "", "4", "", "5", "", "6", "", "7", "", "40", "1",
    "0", "ENDTAB"),
  D(
    "0", "TABLE", "2", "LTYPE", "70", "1",
    "0", "LTYPE", "2", "HIDDEN", "70", "0", "3", "", "72", "65", "73", "2", "40", "9.5", "49", "6.35", "49", "-3.175",
    "0", "ENDTAB"),
));

t("layer table: true colour, transparency, plot flag", () => {
  const d = parseDxf(file({ tables: TABLES, ents: D("0", "LINE", "8", "TrueCol", "10", "0", "20", "0", "11", "1", "21", "1") }));
  const l = d.layers.find((x) => x.name === "TrueCol");
  assert.ok(l, "TrueCol layer missing");
  assert.strictEqual(l.rgb, 0x0D2B45);
  assert.strictEqual(l.transparency, 30);
  assert.strictEqual(l.plot, false);
  const p = d.layers.find((x) => x.name === "Plain");
  assert.ok(p, "Plain layer missing");
  assert.strictEqual(p.rgb, undefined);
  assert.strictEqual(p.plot, undefined); // absent 290 -> plots
});

t("STYLE table exposed with fixed height, width, oblique, flags, big font", () => {
  const d = parseDxf(file({ tables: TABLES, ents: "" }));
  const s = d.textStyles?.FIXED;
  assert.ok(s, "FIXED style missing");
  assert.strictEqual(s.font, "simplex.shx");
  assert.strictEqual(s.bigFont, "bigfont.shx");
  assert.strictEqual(s.height, 3.5);
  assert.strictEqual(s.width, 0.8);
  assert.strictEqual(s.oblique, 15);
  assert.strictEqual(s.backwards, true);
  assert.strictEqual(s.upsideDown, undefined); // 71=2 only
  assert.ok(d.textStyles.STANDARD && !d.textStyles.STANDARD.height, "STANDARD must not inherit a fixed height");
});

t("DIMSTYLE table names are read", () => {
  const d = parseDxf(file({ tables: TABLES, ents: "" }));
  assert.deepStrictEqual(d.dimStyles, ["ISO-25"]);
});

t("TEXT: zero height falls back to the style's fixed height; flags parsed", () => {
  const ents = D(
    "0", "TEXT", "8", "Plain", "7", "FIXED", "10", "0", "20", "0", "40", "0", "1", "Backwards", "71", "6",
    "0", "TEXT", "8", "Plain", "7", "STANDARD", "10", "0", "20", "5", "40", "0", "1", "Fallback 2.5",
  );
  const d = parseDxf(file({ tables: TABLES, ents }));
  const a = d.entities[0], b = d.entities[1];
  assert.strictEqual(a.height, 3.5); // fixed style height
  assert.strictEqual(a.backwards, true);
  assert.strictEqual(a.upsideDown, true); // 71=6 -> both flags
  assert.strictEqual(b.height, 2.5); // no fixed height -> engine default
});

t("entity linetype scale (48) and transparency (440)", () => {
  const ents = D("0", "LINE", "8", "Plain", "6", "HIDDEN", "48", "2.5", "440", "50", "10", "0", "20", "0", "11", "5", "21", "5");
  const d = parseDxf(file({ tables: TABLES, ents }));
  const e = d.entities[0];
  assert.strictEqual(e.ltScale, 2.5);
  assert.strictEqual(e.transparency, 50);
});

t("MTEXT inline colour (\\C aci / \\c true colour)", () => {
  const ents = D(
    "0", "MTEXT", "8", "Plain", "10", "0", "20", "0", "40", "2.5", "71", "1", "1", "\\C1;Red note",
    "0", "MTEXT", "8", "Plain", "10", "0", "20", "5", "40", "2.5", "71", "1", "1", "\\c16711680;Blue title",
  );
  const d = parseDxf(file({ tables: TABLES, ents }));
  assert.strictEqual(d.entities[0].color, 1);
  assert.strictEqual(d.entities[0].rgb, undefined);
  assert.strictEqual(d.entities[1].rgb, 0xff0000);
});

t("writer round-trip keeps layer true colour / transparency / plot + entity fields", () => {
  const doc = {
    layers: [
      { name: "TrueCol", color: 7, rgb: 0x0D2B45, transparency: 30, plot: false },
      { name: "Plain", color: 3 },
    ],
    entities: [
      { type: "LINE", layer: "TrueCol", ltScale: 2.5, transparency: 50, start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
      { type: "TEXT", layer: "Plain", position: { x: 0, y: 3 }, height: 2.5, value: "Mirror", backwards: true },
    ],
    units: "mm",
  };
  const dxf = writeDxf(doc);
  const back = parseDxf(dxf);
  const l = back.layers.find((x) => x.name === "TrueCol");
  assert.strictEqual(l.rgb, 0x0D2B45);
  assert.strictEqual(l.transparency, 30);
  assert.strictEqual(l.plot, false);
  const e = back.entities[0];
  assert.strictEqual(e.ltScale, 2.5);
  assert.strictEqual(e.transparency, 50);
  const tx = back.entities[1];
  assert.strictEqual(tx.backwards, true);
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
