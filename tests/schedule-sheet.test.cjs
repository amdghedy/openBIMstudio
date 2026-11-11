/**
 * Schedule-on-sheet unit tests — pure layout math from
 * src/modules/schedules/schedule-sheet-layout.ts (house pattern: compile
 * the module with tsc and require it).
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "schedsheet-"));
execSync(
  `npx tsc src/modules/schedules/schedule-sheet-layout.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,
  { stdio: "inherit" },
);
const m = require(path.join(out, "schedules", "schedule-sheet-layout.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// ── fixtures ─────────────────────────────────────────────────────────────
const cols = [
  { key: "mark", header: "Mark", format: "text", width: 120 },
  { key: "count", header: "Count", format: "count", unit: "pcs", width: 120 },
  { key: "cost", header: "Unit Cost", format: "currency", width: 120 },
];
const defn = {
  id: "sch-1", name: "Door Schedule", category: "doors", levelName: null,
  columns: cols, showTotals: true,
};
const run = {
  definition: defn,
  rows: [
    { id: "r1", source: "authored", values: { mark: "D01", count: 3, cost: 120.5 } },
    { id: "r2", source: "authored", values: { mark: "D02", count: 2, cost: 80 } },
    { id: "g1", source: "authored", subtotal: true, depth: 0, groupPath: ["D"],
      values: { mark: "D" }, subtotalValues: { count: 5, cost: 200.5 } },
  ],
  totals: { count: 5, cost: 200.5 },
  generatedAt: 0,
};

// ── formatScheduleCell ───────────────────────────────────────────────────
t("formatScheduleCell: count rounds, currency 2dp, default 3dp", () => {
  assert.strictEqual(m.formatScheduleCell({ format: "count" }, 3.6), "4");
  assert.strictEqual(m.formatScheduleCell({ format: "currency" }, 12.5), "12.50");
  assert.strictEqual(m.formatScheduleCell({ format: "percent" }, 0.5), "0.5%");
  assert.strictEqual(m.formatScheduleCell({ format: "number" }, 1.23456), "1.235");
  assert.strictEqual(m.formatScheduleCell({ format: "text" }, 12), "12");
  assert.strictEqual(m.formatScheduleCell({ format: "count" }, null), "");
  assert.strictEqual(m.formatScheduleCell({ format: "count" }, "abc"), "abc");
});

// ── sanitizeScheduleText ─────────────────────────────────────────────────
t("sanitizeScheduleText keeps WinAnsi, replaces exotic codepoints", () => {
  assert.strictEqual(m.sanitizeScheduleText("A㎡B"), "A?B");
  assert.strictEqual(m.sanitizeScheduleText("门表"), "??");
  assert.strictEqual(m.sanitizeScheduleText("45° 2× …–—"), "45° 2× …–—");
});

// ── columnWidthsMM ───────────────────────────────────────────────────────
t("columnWidthsMM: unit suffix, min clamp, px hint raises floor", () => {
  const w = m.columnWidthsMM(defn, run);
  assert.strictEqual(w[1].header, "Count (pcs)");
  assert.strictEqual(w.length, 3);
  for (const c of w) assert.ok(c.widthMM >= 18 && c.widthMM <= 60, "width " + c.widthMM);
  assert.strictEqual(w[0].numeric, false);
  assert.strictEqual(w[1].numeric, true);
  const hinted = m.columnWidthsMM(
    { ...defn, columns: [{ key: "mark", header: "Mark", format: "text", width: 500 }] },
    run,
  );
  assert.ok(hinted[0].widthMM >= 60 || hinted[0].widthMM === 60, "500px hint should raise width, got " + hinted[0].widthMM);
});
t("columnWidthsMM: runaway header caps at 40 chars; px hint clamps to max", () => {
  const capped = m.columnWidthsMM(
    { ...defn, columns: [{ key: "x", header: "X".repeat(200), format: "text", width: 120 }] },
    run,
  );
  assert.strictEqual(capped[0].widthMM, 58); // 40 chars * 1.35 + 2*1.5 + 1
  const clamped = m.columnWidthsMM(
    { ...defn, columns: [{ key: "x", header: "X".repeat(200), format: "text", width: 1000 }] },
    run,
  );
  assert.strictEqual(clamped[0].widthMM, 60); // hint clamped at SCHEDULE_MAX_COL_MM
});

// ── layoutScheduleTable ──────────────────────────────────────────────────
t("layoutScheduleTable: data + subtotal cells + grand total", () => {
  const L = m.layoutScheduleTable(defn, run);
  assert.strictEqual(L.title, "Door Schedule");
  assert.strictEqual(L.rows.length, 3);
  assert.strictEqual(L.rows[0].kind, "data");
  assert.strictEqual(L.rows[0].cells[0], "D01");
  assert.strictEqual(L.rows[0].cells[1], "3");
  assert.strictEqual(L.rows[2].kind, "subtotal");
  assert.strictEqual(L.rows[2].cells[1], "5");       // subtotalValues wins
  assert.strictEqual(L.rows[2].cells[2], "200.50");
  assert.ok(L.hasTotals);
  assert.strictEqual(L.totalsCells[0], "Grand total (2 rows)");
  assert.strictEqual(L.totalsCells[1], "5");
  assert.strictEqual(L.totalsCells[2], "200.50");
});
t("layoutScheduleTable: showTotals=false drops totals", () => {
  const L = m.layoutScheduleTable({ ...defn, showTotals: false }, run);
  assert.strictEqual(L.hasTotals, false);
});
t("layoutScheduleTable: hidden column excluded everywhere", () => {
  const hidden = { ...defn, columns: [{ ...cols[0] }, { ...cols[1], hidden: true }] };
  const L = m.layoutScheduleTable(hidden, run);
  assert.strictEqual(L.cols.length, 1);
  assert.strictEqual(L.rows[0].cells.length, 1);
});
t("layoutScheduleTable: group indent only on text columns", () => {
  const grp = {
    definition: defn,
    rows: [
      { id: "d", source: "authored", depth: 1, values: { mark: "D01", count: 1, cost: 5 } },
    ],
    totals: {}, generatedAt: 0,
  };
  const L = m.layoutScheduleTable(defn, grp);
  assert.ok(L.rows[0].cells[0].startsWith("  "), "text cell indented: '" + L.rows[0].cells[0] + "'");
  assert.strictEqual(L.rows[0].cells[1], "1");        // numeric cell untouched
});
t("layoutScheduleTable: empty run → placeholder row", () => {
  const empty = { definition: defn, rows: [], totals: {}, generatedAt: 0 };
  const L = m.layoutScheduleTable(defn, empty);
  assert.strictEqual(L.rows[0].kind, "placeholder");
  assert.strictEqual(L.rows[0].cells[0], "No elements in this category.");
});
t("layoutScheduleTable: all columns hidden → placeholder + min width", () => {
  const hiddenAll = { ...defn, columns: cols.map((c) => ({ ...c, hidden: true })) };
  const L = m.layoutScheduleTable(hiddenAll, run);
  assert.strictEqual(L.rows[0].cells[0], "All columns hidden.");
  assert.strictEqual(L.tableW, 18);
  assert.strictEqual(L.hasTotals, false);
});

// ── buildScheduleSceneFromRun ────────────────────────────────────────────
t("scene: true paper size — coordinates are mm/1000", () => {
  const scene = m.buildScheduleSceneFromRun(defn, run);
  const L = m.layoutScheduleTable(defn, run);
  near(scene.bounds.maxX, L.tableW / 1000);
  near(scene.bounds.maxZ, 7 / 1000);
  near(scene.bounds.minZ, -(L.tableH) / 1000);
});
t("scene: title text in symbols layer (annotation layer is overwritten by sheets)", () => {
  const scene = m.buildScheduleSceneFromRun(defn, run);
  const texts = scene.layers.symbols.filter((e) => e.kind === "text");
  assert.ok(texts.some((e) => e.text === "Door Schedule"), "title present");
  assert.ok(texts.some((e) => e.text === "Grand total (2 rows)"), "totals present");
  assert.ok(texts.some((e) => e.text === "D01"), "data cell present");
});
t("scene: header band + subtotal band fills in project layer", () => {
  const scene = m.buildScheduleSceneFromRun(defn, run);
  const fills = scene.layers.project.filter((e) => e.kind === "polyline" && e.fill);
  const fillColors = fills.map((e) => e.fill.color);
  assert.ok(fillColors.includes("#e5e7eb"), "header fill");
  assert.ok(fillColors.includes("#f3f4f6"), "subtotal fill");
});
t("scene: grid rules — rows+1 horizontals, cols+1 verticals, outer border", () => {
  const scene = m.buildScheduleSceneFromRun(defn, run);
  const lines = scene.layers.project.filter((e) => e.kind === "line" && e.stroke.color === "#9ca3af");
  const horizontals = lines.filter((e) => Math.abs(e.z1 - e.z2) < 1e-12).length;
  const verticals = lines.filter((e) => Math.abs(e.x1 - e.x2) < 1e-12).length;
  assert.strictEqual(horizontals, 3 + 1, "row rules"); // 3 run rows
  assert.strictEqual(verticals, 3 + 1, "column rules");
  const border = scene.layers.project.find(
    (e) => e.kind === "polyline" && e.stroke.color === "#111827" && !e.fill,
  );
  assert.ok(border, "outer border polyline");
});
t("scene: numeric cells right-aligned near column right edge", () => {
  const scene = m.buildScheduleSceneFromRun(defn, run);
  const texts = scene.layers.symbols.filter((e) => e.kind === "text" && e.text === "3");
  assert.strictEqual(texts.length, 1);
  assert.strictEqual(texts[0].anchor, "end");
});

// ── emptyScheduleScene ───────────────────────────────────────────────────
t("emptyScheduleScene: placeholder message scene", () => {
  const scene = m.emptyScheduleScene("Saved schedule not found (x)");
  const texts = scene.layers.symbols.filter((e) => e.kind === "text");
  assert.strictEqual(texts[0].text, "Saved schedule not found (x)");
});

console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
