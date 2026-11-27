/* MLEADER / TABLE / MLINE / IMAGE / TOLERANCE conversion from the engine's JSON. */
const { execSync } = require("child_process"); const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "acadx-"));
execSync(`npx tsc src/modules/drawings/acad-extra-entities.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`, { stdio: "pipe" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const X = require(find(out, "acad-extra-entities.js"));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n) } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message) } };
const notes = []; const cx = { pt: (a) => ({ x: +(a?.[0] ?? 0), y: +(a?.[1] ?? 0), z: +(a?.[2] ?? 0) }), clean: (s) => s.replace(/\\P/g, " "), deg: 180 / Math.PI, note: (m) => notes.push(m) };
const c = { layer: "L" };

t("MLEADER: leader lines and text both survive", () => {
  const r = X.convertMleader({ text: "Door D1\\Pfire", textLocation: [10, 5, 0], textHeight: 3, textRotation: 0, lines: [[[0, 0, 0], [5, 2, 0], [10, 5, 0]]] }, c, cx);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].type, "LWPOLYLINE"); assert.strictEqual(r[0].points.length, 3);
  assert.strictEqual(r[1].type, "TEXT"); assert.strictEqual(r[1].value, "Door D1 fire"); assert.strictEqual(r[1].height, 3);
});
t("MLEADER: text-only and empty cases", () => {
  assert.strictEqual(X.convertMleader({ text: "A", textLocation: [1, 1, 0], lines: [] }, c, cx).length, 1);
  assert.strictEqual(X.convertMleader({ text: "", lines: [] }, c, cx).length, 0);
});
t("TABLE: one editable TABLE entity keeps the grid, the cells and the frame", () => {
  const r = X.convertTable({ position: [100, 50, 0], dir: [1, 0, 0], colWidths: [20, 30], rowHeights: [10, 10], cells: [["Mark", "Type"], ["D1", ""]], textHeight: 2.5 }, c, cx);
  assert.strictEqual(r.length, 1, "one entity, not loose geometry");
  assert.strictEqual(r[0].type, "TABLE");
  assert.deepStrictEqual(r[0].position, { x: 100, y: 50, z: 0 });
  assert.deepStrictEqual(r[0].colWidths, [20, 30]);
  assert.deepStrictEqual(r[0].rowHeights, [10, 10]);
  assert.deepStrictEqual(r[0].cells, [["Mark", "Type"], ["D1", ""]]);
  assert.strictEqual(r[0].textHeight, 2.5);
  assert.strictEqual(r[0].rotation, undefined, "axis-aligned tables carry no rotation");
});
t("TABLE: a rotated table keeps its rotation on the entity", () => {
  const r = X.convertTable({ position: [0, 0, 0], dir: [0, 1, 0], colWidths: [10], rowHeights: [4], cells: [["X"]] }, c, cx);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].type, "TABLE");
  assert.ok(Math.abs((r[0].rotation ?? 0) - 90) < 1e-9, "rotation 90, got " + r[0].rotation);
  assert.deepStrictEqual(r[0].cells, [["X"]]);
});
t("TABLE: an oversized table stays loose grid + text (no data lost to the 50x50 cap)", () => {
  const big = X.convertTable({ position: [0, 0, 0], dir: [1, 0, 0], colWidths: Array.from({ length: 60 }, () => 10), rowHeights: [10], cells: [Array.from({ length: 60 }, (_, i) => `C${i}`)] }, c, cx);
  assert.ok(big.length > 1, "loose geometry, got " + big.length);
  assert.ok(big.some((e) => e.type === "TEXT" && e.value === "C59"));
});
t("TABLE without rows is reported, not silently dropped", () => {
  notes.length = 0; assert.strictEqual(X.convertTable({ position: [0, 0, 0], colWidths: [], rowHeights: [] }, c, cx).length, 0); assert.ok(notes.length);
});
const wallStyle = { offsets: [-0.5, 0.5], startCap: true, endCap: true };
const cxs = { ...cx, mlineStyle: () => wallStyle };
t("MLINE with a style: two parallel lines 1 apart plus square end caps", () => {
  const r = X.convertMline({ style: "WALL", scale: 1, vertices: [[0, 0, 0], [10, 0, 0]], miters: [[0, 1, 0], [0, 1, 0]] }, c, cxs);
  const pl = r.filter((e) => e.type === "LWPOLYLINE");
  assert.strictEqual(pl.length, 2); assert.strictEqual(r.filter((e) => e.type === "LINE").length, 2);
  const ys = pl.map((e) => e.points[0].y).sort((a, b) => a - b);
  assert.ok(Math.abs(ys[0] + 0.5) < 1e-9 && Math.abs(ys[1] - 0.5) < 1e-9, ys.join());
});
t("MLINE scale factor multiplies the offsets", () => {
  const r = X.convertMline({ scale: 200, vertices: [[0, 0, 0], [1000, 0, 0]], miters: [[0, 1, 0], [0, 1, 0]] }, c, cxs);
  const ys = r.filter((e) => e.type === "LWPOLYLINE").map((e) => e.points[0].y).sort((a, b) => a - b);
  assert.ok(Math.abs(ys[1] - ys[0] - 200) < 1e-9, ys.join());
});
t("MLINE right-angle corner: offset lines meet at a true mitre (constant distance from both segments)", () => {
  const s2 = Math.SQRT1_2;
  const r = X.convertMline({ scale: 1, vertices: [[0, 0, 0], [10, 0, 0], [10, 10, 0]], miters: [[0, 1, 0], [-s2, s2, 0], [-1, 0, 0]] }, c, cxs);
  const outer = r.filter((e) => e.type === "LWPOLYLINE").map((e) => e.points[1]);
  const p = outer.find((q) => q.y < 0); // the line on the outside of the turn
  assert.ok(Math.abs(p.x - 10.5) < 1e-9 && Math.abs(p.y + 0.5) < 1e-9, JSON.stringify(p));
});
t("MLINE without style data falls back to the centre path and says so", () => {
  notes.length = 0; const r = X.convertMline({ vertices: [[0, 0, 0], [10, 0, 0]], miters: [] }, c, cx);
  assert.strictEqual(r.length, 1); assert.ok(notes.some((n) => n.includes("centre path only")));
});
t("MLINE: centre path drawn and the limitation is reported", () => {
  notes.length = 0; const r = X.convertMline({ vertices: [[0, 0, 0], [10, 0, 0], [10, 5, 0]] }, c, cx);
  assert.strictEqual(r.length, 1); assert.ok(notes.some((n) => n.includes("centre path only")));
});
t("IMAGE: frame uses the u/v vectors and says pixels are not drawn", () => {
  notes.length = 0; const r = X.convertImage({ position: [0, 0, 0], u: [1, 0, 0], v: [0, 1, 0], size: [40, 20] }, c, cx);
  assert.deepStrictEqual(r[0].points.map((p) => [p.x, p.y]), [[0, 0], [40, 0], [40, 20], [0, 20]]); assert.ok(r[0].closed); assert.ok(notes.some((n) => n.includes("pixels not drawn")));
});
t("TOLERANCE becomes text", () => { assert.strictEqual(X.convertTolerance({ position: [1, 2, 0], text: "{\\Fgdt;j}%%v0.1" }, c, cx).length, 1); });
t("WIPEOUT: polygonal clip maps through the u/v frame and fills with the background", () => {
  const r = X.convertWipeout({ position: [10, 20, 0], u: [100, 0, 0], v: [0, 50, 0], clipEnabled: true, clipType: 2, clip: [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] }, c, cx);
  assert.strictEqual(r.length, 1); assert.ok(r[0].hatch.wipeout && r[0].hatch.solid && r[0].closed);
  assert.deepStrictEqual(r[0].points.map((p) => [p.x, p.y]), [[10, 20], [110, 20], [110, 70], [10, 70]]);
});
t("WIPEOUT: 2-vertex rectangular clip and unclipped default both give a rectangle", () => {
  const a = X.convertWipeout({ position: [0, 0, 0], u: [10, 0, 0], v: [0, 10, 0], clipEnabled: true, clipType: 1, clip: [[-0.5, -0.5], [0, 0.5]] }, c, cx);
  assert.deepStrictEqual(a[0].points.map((p) => [p.x, p.y]), [[0, 0], [5, 0], [5, 10], [0, 10]]);
  const b = X.convertWipeout({ position: [0, 0, 0], u: [10, 0, 0], v: [0, 10, 0], clipEnabled: false, clip: [] }, c, cx);
  assert.strictEqual(b[0].points.length, 4);
});
console.log(`acad-extra-entities: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
