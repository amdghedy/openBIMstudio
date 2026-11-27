/* 2D-7 editable TABLE — a table is one editable entity, not loose LINE+TEXT.
 *
 * Proves, in Node (no browser):
 *  1. createTable / cell edit / row+column insert+delete are pure and exact.
 *  2. The DXF writer emits a real ACAD_TABLE (Autodesk group codes
 *     91 rows / 92 cols / 141 row heights / 142 column widths /
 *     171 cell type / 1 cell text) and the reader parses it back —
 *     an edited cell survives save + reload.
 *  3. The reader accepts a foreign-style ACAD_TABLE (direction vector,
 *     302 cell text) the way AutoCAD writes one.
 *  4. The DWG import leg (acadrust engine JSON -> convertTable) yields one
 *     TABLE entity, and the DWG export leg (writeDxf -> engine DWG ->
 *     engine read-back) keeps the table and its edited cell.
 *  5. Picking / bbox / MOVE / ROTATE / SCALE / MIRROR treat the table as
 *     one entity, and the PE-20 schema gate accepts it.
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cad-table-2d7-"));
try { fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* zod is a runtime dep of compiled safeLoad (PE-20) */ }
execSync(
  `npx tsc src/modules/drawings/cad-table.ts src/modules/drawings/dxf-reader.ts src/modules/drawings/dxf-writer.ts ` +
  `src/modules/cad-viewer/viewer-math.ts src/modules/cad-viewer/modify-math.ts src/modules/drawings/acad-extra-entities.ts ` +
  `src/core/safeLoad.ts src/modules/drawings/acad-engine.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop`,
  { cwd: root, stdio: "pipe" },
);
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const T = require(find(out, "cad-table.js"));
const { parseDxf } = require(find(out, "dxf-reader.js"));
const { writeDxf } = require(find(out, "dxf-writer.js"));
const M = require(find(out, "viewer-math.js"));
const Mod = require(find(out, "modify-math.js"));
const X = require(find(out, "acad-extra-entities.js"));
const { validateDxfDocument } = require(find(out, "safeLoad.js"));
const A = require(find(out, "acad-engine.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const ta = async (n, f) => { try { await f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

/** A 2-row x 3-col table, top-left (0,100), cols 20/30/25, rows 10/12, header on. */
const table = () => T.createTable({
  layer: "0",
  position: { x: 0, y: 100 },
  colWidths: [20, 30, 25],
  rowHeights: [10, 12],
  cells: [["A", "B", "C"], ["D", "E", "F"]],
  textHeight: 5,
  headerRow: true,
});
const docWith = (e) => ({ layers: [{ name: "0", color: 7 }], entities: [e] });
const roundTrip = (e) => {
  const back = parseDxf(writeDxf(docWith(e)));
  assert.strictEqual(back.skipped, undefined, "nothing skipped: " + JSON.stringify(back.skipped));
  const tables = back.entities.filter((x) => x.type === "TABLE");
  assert.strictEqual(tables.length, 1, "exactly one TABLE back, got " + back.entities.map((x) => x.type).join(","));
  return tables[0];
};

t("createTable: two picks normalise to a top-left table with equal widths and r,c labels", () => {
  const tb = T.createTable({ layer: "0", position: { x: 100, y: 20 }, size: { x: 60, y: 30 }, rows: 2, cols: 3 });
  assert.strictEqual(tb.type, "TABLE");
  assert.deepStrictEqual(tb.position, { x: 100, y: 50 });
  assert.deepStrictEqual(tb.colWidths, [20, 20, 20]);
  assert.deepStrictEqual(tb.rowHeights, [15, 15]);
  assert.deepStrictEqual(tb.cells, [["1,1", "1,2", "1,3"], ["2,1", "2,2", "2,3"]]);
  assert.strictEqual(T.tableWidth(tb), 60);
  assert.strictEqual(T.tableHeight(tb), 30);
});

t("setCellText changes one cell only; cellAt finds the cell under a point", () => {
  const tb = table();
  const ed = T.setCellText(tb, 1, 2, "Edited");
  assert.strictEqual(ed.cells[1][2], "Edited");
  assert.strictEqual(ed.cells[0][2], "C");
  assert.strictEqual(tb.cells[1][2], "F", "immutable: the original is untouched");
  assert.deepStrictEqual(T.cellAt(tb, 55, 84), { row: 1, col: 2 }, "x=55 is col 2, y=84 is row 1 (78..90)");
  assert.deepStrictEqual(T.cellAt(tb, 5, 95), { row: 0, col: 0 });
  assert.strictEqual(T.cellAt(tb, 500, 500), null);
  assert.throws(() => T.setCellText(tb, 9, 0, "x"), /out of range/);
});

t("insert/delete row and column keep the other cells; the last row/column refuses", () => {
  let tb = table();
  tb = T.insertTableRow(tb, 1);
  assert.deepStrictEqual(tb.rowHeights, [10, 10, 12]);
  assert.deepStrictEqual(tb.cells, [["A", "B", "C"], ["", "", ""], ["D", "E", "F"]]);
  tb = T.deleteTableRow(tb, 0);
  assert.deepStrictEqual(tb.cells, [["", "", ""], ["D", "E", "F"]]);
  tb = T.insertTableColumn(tb, 0);
  assert.deepStrictEqual(tb.colWidths, [20, 20, 30, 25]);
  assert.strictEqual(tb.cells[1][0], "");
  assert.strictEqual(tb.cells[1][1], "D");
  tb = T.deleteTableColumn(tb, 3);
  assert.deepStrictEqual(tb.colWidths, [20, 20, 30]);
  const one = T.createTable({ layer: "0", position: { x: 0, y: 10 }, colWidths: [10], rowHeights: [5], cells: [["x"]] });
  assert.strictEqual(T.deleteTableRow(one, 0), null);
  assert.strictEqual(T.deleteTableColumn(one, 0), null);
});

t("writer emits a real ACAD_TABLE, not loose LINE/TEXT", () => {
  const dxf = writeDxf(docWith(table()));
  assert.ok(dxf.includes("ACAD_TABLE"), "ACAD_TABLE present");
  assert.ok(!/^\s*LINE\s*$/m.test(dxf.split("ENTITIES")[1] || ""), "no LINE entities for the table");
  const lines = dxf.split("\n").map((s) => s.trim());
  const codes = [];
  for (let i = 0; i + 1 < lines.length; i += 2) codes.push([lines[i], lines[i + 1]]);
  const at = codes.findIndex(([c, v]) => c === "0" && v === "ACAD_TABLE");
  assert.ok(at >= 0);
  // Scope to this entity only: later sections carry group 141 too (a scale
  // factor), and the unscoped slice used to pick it up as a row height.
  const after = codes.slice(at + 1);
  const end = after.findIndex(([c]) => c === "0");
  const body = end >= 0 ? after.slice(0, end) : after;
  const val = (c, k = 0) => body.filter(([cc]) => cc === String(c)).map(([, v]) => v)[k];
  assert.strictEqual(val(91), "2", "group 91 = 2 rows");
  assert.strictEqual(val(92), "3", "group 92 = 3 cols");
  assert.deepStrictEqual(body.filter(([c]) => c === "141").map(([, v]) => Number(v)), [10, 12], "group 141 = row heights");
  assert.deepStrictEqual(body.filter(([c]) => c === "142").map(([, v]) => Number(v)), [20, 30, 25], "group 142 = column widths");
  assert.strictEqual(body.filter(([c]) => c === "171").length, 6, "group 171 once per cell");
  assert.deepStrictEqual(body.filter(([c]) => c === "1").map(([, v]) => v), ["A", "B", "C", "D", "E", "F"], "group 1 = cell text row-major");
});

t("DXF round-trip: an edited cell, the header flag and the sizes survive save + reload", () => {
  const ed = T.setCellText(table(), 1, 2, "Edited");
  const back = roundTrip(ed);
  assert.strictEqual(back.cells[1][2], "Edited");
  assert.strictEqual(back.cells[0][0], "A");
  assert.deepStrictEqual(back.colWidths, [20, 30, 25]);
  assert.deepStrictEqual(back.rowHeights, [10, 12]);
  assert.deepStrictEqual(back.position, { x: 0, y: 100, z: 0 }, "the reader's pt() always carries z (0 when the file's group 30 is 0)");
  assert.strictEqual(back.textHeight, 5);
  assert.strictEqual(back.headerRow, true);
  const plain = roundTrip(T.createTable({ layer: "0", position: { x: 0, y: 10 }, colWidths: [10], rowHeights: [5], cells: [["x"]] }));
  assert.strictEqual(plain.headerRow, undefined, "no header flag without a header row");
});

t("reader accepts a foreign-style ACAD_TABLE (direction vector, 302 cell text)", () => {
  const D = (...a) => a.flat().map(String).join("\n");
  const dxf = D("0", "SECTION", "2", "ENTITIES",
    "0", "ACAD_TABLE", "5", "AB", "100", "AcDbEntity", "8", "0",
    "100", "AcDbBlockReference", "2", "*T1", "10", "5", "20", "50", "30", "0",
    "100", "AcDbTable", "280", "0", "11", "1", "21", "0", "31", "0",
    "90", "0", "91", "2", "92", "2", "93", "0", "94", "0", "95", "0", "96", "0",
    "141", "8", "141", "8", "142", "15", "142", "15",
    "171", "1", "172", "0", "173", "0", "174", "0", "175", "1", "176", "1", "91", "0", "178", "0", "145", "0",
    "302", "Foreign",
    "171", "1", "172", "0", "173", "0", "174", "0", "175", "1", "176", "1", "91", "0", "178", "0", "145", "0",
    "302", "Cell",
    "171", "1", "172", "0", "173", "0", "174", "0", "175", "1", "176", "1", "91", "0", "178", "0", "145", "0",
    "302", "",
    "171", "1", "172", "0", "173", "0", "174", "0", "175", "1", "176", "1", "91", "0", "178", "0", "145", "0",
    "302", "Last",
    "281", "0", "140", "4",
    "0", "ENDSEC", "0", "EOF");
  const doc = parseDxf(dxf);
  assert.strictEqual(doc.skipped, undefined, JSON.stringify(doc.skipped));
  const tb = doc.entities.find((e) => e.type === "TABLE");
  assert.ok(tb, "TABLE parsed");
  assert.deepStrictEqual(tb.cells, [["Foreign", "Cell"], ["", "Last"]]);
  assert.strictEqual(tb.textHeight, 4);
  assert.strictEqual(tb.headerRow, true);
});

t("DWG import leg: convertTable yields one TABLE entity (axis-aligned and rotated)", () => {
  const cx = { pt: (a) => ({ x: +(a?.[0] ?? 0), y: +(a?.[1] ?? 0), z: +(a?.[2] ?? 0) }), clean: (s) => s.replace(/\\P/g, " "), deg: 180 / Math.PI, note: () => {} };
  const c = { layer: "L" };
  const r = X.convertTable({ position: [100, 50, 0], dir: [1, 0, 0], colWidths: [20, 30], rowHeights: [10, 10], cells: [["Mark", "Type"], ["D1", ""]], textHeight: 2.5 }, c, cx);
  assert.strictEqual(r.length, 1, "one entity, not loose geometry");
  assert.strictEqual(r[0].type, "TABLE");
  assert.deepStrictEqual(r[0].cells, [["Mark", "Type"], ["D1", ""]]);
  assert.deepStrictEqual(r[0].position, { x: 100, y: 50, z: 0 });
  const rot = X.convertTable({ position: [0, 0, 0], dir: [0, 1, 0], colWidths: [10], rowHeights: [4], cells: [["X"]] }, c, cx);
  assert.strictEqual(rot.length, 1);
  assert.ok(Math.abs((rot[0].rotation ?? 0) - 90) < 1e-9, "rotated table keeps rotation 90, got " + rot[0].rotation);
  const notes = []; const cx2 = { ...cx, note: (m) => notes.push(m) };
  assert.strictEqual(X.convertTable({ position: [0, 0, 0], colWidths: [], rowHeights: [] }, c, cx2).length, 0);
  assert.ok(notes.length, "empty table still reported, not silently dropped");
});

t("picking: the table is one pickable entity with the table's own bbox", () => {
  const tb = table();
  const box = M.entityBBox(tb);
  assert.deepStrictEqual(box, { minX: 0, minY: 78, maxX: 75, maxY: 100 });
  assert.strictEqual(M.distToEntity(tb, 30, 90), 0, "inside the table");
  assert.ok(M.distToEntity(tb, 200, 200) > 0, "outside the table");
  const ents = [tb, { type: "LINE", layer: "0", start: { x: 500, y: 500 }, end: { x: 600, y: 500 } }];
  const idx = M.buildIndex(ents, { minX: -10, minY: 0, maxX: 700, maxY: 600 });
  assert.strictEqual(M.pickEntity(idx, ents, 30, 90, 5), 0, "click inside the table picks the table");
  assert.strictEqual(M.pickEntity(idx, ents, 550, 500, 5), 1, "click on the line still picks the line");
  assert.strictEqual(M.pickEntity(idx, ents, 300, 300, 5), -1, "click in empty space picks nothing");
});

t("MOVE / ROTATE / SCALE / MIRROR treat the table as one entity", () => {
  const tb = table();
  const moved = Mod.translateEnt(tb, 10, -20);
  assert.deepStrictEqual(moved.position, { x: 10, y: 80 });
  assert.deepStrictEqual(moved.cells, tb.cells);
  const rot = Mod.rotateEnt(tb, 0, 0, 90);
  assert.ok(Math.abs(rot.position.x - -100) < 1e-9 && Math.abs(rot.position.y - 0) < 1e-9, "rotated position " + JSON.stringify(rot.position));
  assert.ok(Math.abs((rot.rotation ?? 0) - 90) < 1e-9);
  const sc = Mod.scaleEnt(tb, 0, 0, 2);
  assert.deepStrictEqual(sc.colWidths, [40, 60, 50]);
  assert.deepStrictEqual(sc.rowHeights, [20, 24]);
  assert.strictEqual(sc.textHeight, 10);
  const mir = Mod.mirrorEnt(tb, { x: 0, y: 0 }, { x: 0, y: 100 });
  const box = M.entityBBox(mir);
  assert.ok(Math.abs(box.minX - -75) < 1e-9 && Math.abs(box.maxX - 0) < 1e-9, "mirrored bbox " + JSON.stringify(box));
  assert.deepStrictEqual(mir.cells, [["D", "E", "F"], ["A", "B", "C"]], "mirror reverses the rows so the text stays in place");
});

t("PE-20 schema gate accepts a document holding a TABLE", () => {
  assert.strictEqual(validateDxfDocument(docWith(table())).ok, true);
});

t("explodeTable reproduces the old loose grid + cell text", () => {
  const parts = T.explodeTable(table());
  const lines = parts.filter((e) => e.type === "LINE");
  const texts = parts.filter((e) => e.type === "TEXT");
  assert.strictEqual(lines.length, 3 + 4, "3 horizontal + 4 vertical grid lines");
  assert.deepStrictEqual(texts.map((e) => e.value), ["A", "B", "C", "D", "E", "F"]);
});

(async () => {
  const wasmPath = path.join(root, "public", "cad-engine", "obim-cad-engine.wasm");
  if (!fs.existsSync(wasmPath)) { console.log("  SKIP DWG leg: public/cad-engine/obim-cad-engine.wasm is missing"); }
  else {
    const wasm = fs.readFileSync(wasmPath);
    assert.ok(await A.setAcadEngineForTests(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)), "engine failed to load");
    await ta("DWG leg: DXF -> real DWG -> engine read-back keeps the table and its edited cell", async () => {
      const ed = T.setCellText(table(), 0, 1, "Edited");
      const dxf = writeDxf(docWith(ed));
      const dwg = await A.exportDxfToDwg(dxf);
      assert.strictEqual(Buffer.from(dwg.subarray(0, 6)).toString(), "AC1024", "a real DWG");
      const back = (await A.parseWithAcadEngine(dwg, "rt.dwg")).doc;
      const tb = back.entities.find((e) => e.type === "TABLE");
      assert.ok(tb, "TABLE survives the DWG round-trip, got: " + back.entities.map((e) => e.type).join(","));
      assert.strictEqual(tb.cells[0][1], "Edited");
      assert.strictEqual(tb.cells[1][0], "D");
      assert.deepStrictEqual(tb.colWidths, [20, 30, 25]);
    });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
