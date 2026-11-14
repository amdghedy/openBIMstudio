/**
 * 2D documentation: sheet persistence, scale consistency, dimension units,
 * UNITS-dialog mapping. Every delivered documentation capability is asserted
 * against its real implementation — no mocks, no skipped paths.
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-doc2d-"));

try {
  execSync(
    "npx tsc src/modules/sheets/sheets.ts src/modules/views/sheet-layout.ts src/modules/views/scene.ts" +
      " src/modules/views/annotations.ts src/modules/views/dimension-engine.ts src/modules/views/references.ts" +
      " src/modules/cad-viewer/viewer-math.ts src/modules/drawings/cad-styles.ts src/modules/drawings/hatch-patterns.ts" +
      " --outDir " + out + " --module commonjs --target es2020 --skipLibCheck",
    { cwd: root, stdio: "inherit" },
  );
} catch (e) {
  console.error("tsc failed");
  process.exit(1);
}

const locate = (dir, name) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { const found = locate(p, name); if (found) return found; }
    else if (entry.name === name) return p;
  }
  return null;
};
const req = (name) => {
  const p = locate(out, name);
  assert.ok(p, name + " not produced by tsc");
  return require(p);
};

let pass = 0, fail = 0;
const t = (n, f) => {
  try { f(); pass++; console.log("  PASS " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); }
};
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// ── Sheet store: persistence round-trip + annotations + undo snapshots ──
const sheets = req("sheets.js");
sheets.bootSheetsStore(); // node: no localStorage → safe default titleblock path

t("project round-trip: sheets, viewports, titleblocks survive save→load", () => {
  const s = sheets.createSheet({ number: "T-100", name: "Roundtrip", size: "A3", orientation: "portrait" });
  sheets.addViewport(s.id, { viewId: "plan-level-1", viewType: "plan", x: 10, y: 12, width: 300, height: 200, scale: "1:50", title: "Plan" });
  const ann = sheets.addSheetAnnotation(s.id, { text: "General note", x: 14, y: 16 });
  sheets.updateSheetAnnotation(s.id, ann.id, { text: "Edited note", x: 20 });
  const snap = sheets.getSheetsForSave();
  assert.ok(snap.sheets.length >= 1 && snap.titleblocks.length >= 1);
  sheets.loadSheetsFromProject(undefined, undefined);
  assert.strictEqual(sheets.listSheets().length, 0, "store cleared before reload");
  sheets.loadSheetsFromProject(snap.sheets, snap.titleblocks);
  const back = sheets.getSheet(s.id);
  assert.ok(back, "sheet restored");
  assert.strictEqual(back.number, "T-100");
  assert.strictEqual(back.size, "A3");
  assert.strictEqual(back.orientation, "portrait");
  assert.strictEqual(back.viewports.length, 1);
  assert.strictEqual(back.viewports[0].scale, "1:50");
  assert.strictEqual(back.annotations.length, 1);
  assert.strictEqual(back.annotations[0].text, "Edited note");
  assert.strictEqual(back.annotations[0].x, 20);
  assert.ok(sheets.getTitleblock(back.titleblockId), "titleblock restored and linked");
});

t("titleblock field edit round-trips through updateTitleblock", () => {
  const s = sheets.createSheet({ number: "T-101", name: "TB" });
  const tbId = s.titleblockId;
  const before = sheets.getTitleblock(tbId);
  sheets.updateTitleblock(tbId, { fields: before.fields.map((f) => (f.key === "project" ? { ...f, value: "Tower A" } : f)) });
  const snap = sheets.getSheetsForSave();
  sheets.loadSheetsFromProject(snap.sheets, snap.titleblocks);
  const after = sheets.getTitleblock(tbId);
  assert.strictEqual(after.fields.find((f) => f.key === "project").value, "Tower A");
});

t("undo helpers: replaceSheet / insertSheet restore exact snapshots", () => {
  const s = sheets.createSheet({ number: "T-102", name: "Undo" });
  sheets.addViewport(s.id, { viewId: "v", viewType: "plan", x: 1, y: 2, width: 50, height: 40, scale: "1:100", title: "P" });
  const snapshot = sheets.cloneSheet(sheets.getSheet(s.id));
  sheets.removeViewport(s.id, sheets.getSheet(s.id).viewports[0].id);
  assert.strictEqual(sheets.getSheet(s.id).viewports.length, 0);
  assert.ok(sheets.replaceSheet(s.id, snapshot), "replaceSheet applied");
  assert.strictEqual(sheets.getSheet(s.id).viewports.length, 1, "viewport restored by replaceSheet");
  sheets.deleteSheet(s.id);
  assert.ok(!sheets.getSheet(s.id), "deleted");
  sheets.insertSheet(snapshot);
  assert.strictEqual(sheets.getSheet(s.id).viewports.length, 1, "insertSheet restores the deleted sheet");
});

t("sheet annotation removal is reflected in the saved payload", () => {
  const s = sheets.createSheet({ number: "T-103", name: "Ann" });
  const a1 = sheets.addSheetAnnotation(s.id, { text: "keep", x: 1, y: 1 });
  const a2 = sheets.addSheetAnnotation(s.id, { text: "drop", x: 2, y: 2 });
  assert.ok(sheets.removeSheetAnnotation(s.id, a2.id));
  assert.strictEqual(sheets.getSheet(s.id).annotations.length, 1);
  assert.strictEqual(sheets.getSheet(s.id).annotations[0].id, a1.id);
  assert.ok(!sheets.removeSheetAnnotation(s.id, "missing-id"), "unknown id rejected");
});

// ── Scale consistency: the annotation-scale invariant at multiple viewport scales ──
const layout = req("sheet-layout.js");
const sceneM = req("scene.js");

const mkView = (scale) => ({
  id: "v1", kind: "plan", name: "V", scale, discipline: "COORD", crop: null,
  plan: { levelId: "l0", levelElevation: 0, cutHeight: 1.2, topHeight: 2.4, bottomDepth: 1.2, viewDepth: 4 },
  createdAt: 0, updatedAt: 0,
});
const mkSheet = () => ({
  id: "s1", number: "A-001", name: "S", size: "A1", orientation: "landscape",
  viewports: [], createdAt: 0, updatedAt: 0,
});
const mkScene = () => {
  const sc = sceneM.emptyScene();
  sc.bounds = { minX: 0, minZ: 0, maxX: 20, maxZ: 10 };
  return sc;
};

for (const declared of ["1:50", "1:100", "1:200"]) {
  t("invariant @ declared viewport scale " + declared + ": paperToWorld(x, effective) prints at x mm", () => {
    const sheet = mkSheet();
    const view = mkView(100);
    const scene = mkScene();
    const vp = { id: "vp", viewId: "v1", viewType: "plan", x: 20, y: 20, width: 400, height: 250, scale: declared, title: "T", fitMode: "scale" };
    const tf = layout.computeViewportTransform(vp, sheet, view, scene);
    const denom = layout.parseScale(declared);
    assert.strictEqual(tf.scaleDenom, denom, "declared scale honored");
    assert.strictEqual(layout.effectiveViewportScale(vp, sheet, view, scene), tf.scaleDenom);
    // A 2.5 mm annotation built at the EFFECTIVE scale must print 2.5 mm.
    const world = sceneM.paperToWorld(2.5, tf.scaleDenom);
    assert.ok(approx(layout.onPaperMm(world, tf), 2.5), "on-paper " + layout.onPaperMm(world, tf));
  });
}

t("invariant @ content-fit viewport: recomputed scaleDenom still prints 2.5 mm", () => {
  const sheet = mkSheet();
  const view = mkView(100);
  const scene = mkScene();
  const vp = { id: "vp2", viewId: "v1", viewType: "plan", x: 20, y: 20, width: 500, height: 150, scale: "1:100", title: "T" };
  const tf = layout.computeViewportTransform(vp, sheet, view, scene);
  assert.ok(tf.scaleDenom !== 100, "content-fit recomputed the scale (got " + tf.scaleDenom + ")");
  assert.strictEqual(tf.fitMode, "content");
  const world = sceneM.paperToWorld(2.5, tf.scaleDenom);
  assert.ok(approx(layout.onPaperMm(world, tf), 2.5), "on-paper " + layout.onPaperMm(world, tf));
  // The same annotation built at the VIEW scale (the old behaviour) would NOT print 2.5 mm.
  const wrongWorld = sceneM.paperToWorld(2.5, view.scale);
  assert.ok(Math.abs(layout.onPaperMm(wrongWorld, tf) - 2.5) > 0.01, "view-scale build diverges on paper");
});

t("viewport pinned to a different scale than the view keeps its own scale", () => {
  const sheet = mkSheet();
  const view = mkView(100);
  const scene = mkScene();
  const vp = { id: "vp3", viewId: "v1", viewType: "plan", x: 20, y: 20, width: 400, height: 250, scale: "1:500", title: "T", fitMode: "scale" };
  const tf = layout.computeViewportTransform(vp, sheet, view, scene);
  assert.strictEqual(tf.scaleDenom, 500, "viewport scale wins over view scale");
  const world = sceneM.paperToWorld(2.5, tf.scaleDenom);
  assert.ok(approx(layout.onPaperMm(world, tf), 2.5));
});

t("formatScale renders canonical 1:N text", () => {
  assert.strictEqual(layout.formatScale(100), "1:100");
  assert.strictEqual(layout.formatScale(142.4), "1:142");
});

// ── Dimension units: metric + imperial ──
const ann = req("annotations.js");
const eng = req("dimension-engine.js");

t("formatDimensionValue: mm legacy no-suffix behaviour kept", () => {
  assert.strictEqual(eng.formatDimensionValue(4.2, { unit: "mm", precision: 0 }), "4200");
  assert.strictEqual(eng.formatDimensionValue(0.125, { unit: "mm", precision: 0 }), "125");
});
t("formatDimensionValue: m precision 3", () => {
  assert.strictEqual(eng.formatDimensionValue(4.2, { unit: "m", precision: 3 }), "4.200");
});
t("formatDimensionValue: cm conversion", () => {
  assert.strictEqual(eng.formatDimensionValue(4.2, { unit: "cm", precision: 1 }), "420.0");
});
t("formatDimensionValue: decimal feet with prime suffix", () => {
  assert.strictEqual(eng.formatDimensionValue(3.048, { unit: "ft", precision: 2 }), "10.00'");
  assert.strictEqual(eng.formatDimensionValue(0.3048, { unit: "ft", precision: 1 }), "1.0'");
});
t("formatDimensionValue: decimal inches with double-prime suffix", () => {
  assert.strictEqual(eng.formatDimensionValue(0.0254, { unit: "in", precision: 1 }), "1.0\"");
  assert.strictEqual(eng.formatDimensionValue(0.0508, { unit: "in", precision: 2 }), "2.00\"");
});
t("default styles include an imperial style", () => {
  assert.ok(ann.DEFAULT_DIM_STYLES.some((s) => s.unit === "ft"), "imperial style present");
  assert.ok(ann.DEFAULT_DIM_STYLES.every((s) => ["mm", "cm", "m", "ft", "in"].includes(s.unit)));
});

// ── UNITS dialog mapping (CAD drafting workspace) ──
const M = req("viewer-math.js");

t("UNITS: Length Type → display unit mapping", () => {
  assert.strictEqual(M.displayUnitForLengthType("Decimal"), "drawing");
  assert.strictEqual(M.displayUnitForLengthType("Architectural"), "ft");
  assert.strictEqual(M.displayUnitForLengthType("Engineering"), "in");
});
t("UNITS: display unit → Length Type round-trip", () => {
  assert.strictEqual(M.lengthTypeForDisplayUnit(M.displayUnitForLengthType("Architectural")), "Architectural");
  assert.strictEqual(M.lengthTypeForDisplayUnit(M.displayUnitForLengthType("Engineering")), "Engineering");
  assert.strictEqual(M.lengthTypeForDisplayUnit(M.displayUnitForLengthType("Decimal")), "Decimal");
});
t("UNITS: precision label → coordinate digits", () => {
  assert.strictEqual(M.coordDigitsForPrecisionLabel("0.0000"), 4);
  assert.strictEqual(M.coordDigitsForPrecisionLabel("0.00"), 2);
  assert.strictEqual(M.coordDigitsForPrecisionLabel("0.000000"), 6);
  assert.strictEqual(M.coordDigitsForPrecisionLabel("garbage"), 4, "unparseable keeps the default");
});
t("CAD units: convertLength + unitLabel across mm/cm/m/in/ft", () => {
  assert.ok(approx(M.convertLength(1, "m", "mm"), 1000), "m→mm");
  assert.ok(approx(M.convertLength(1, "m", "ft"), 1 / 0.3048, 1e-9), "m→ft");
  assert.ok(approx(M.convertLength(1, "in", "mm"), 25.4), "in→mm");
  assert.strictEqual(M.unitLabel("m", "drawing"), "m");
  assert.strictEqual(M.unitLabel(undefined, "drawing"), "units");
});

console.log(`\ndocumentation-2d: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
