// CAD layer manager (AutoCAD parity A16) — pure module tests.
//
// The module under test is src/modules/cad-viewer/cad-layer-manager.ts:
// rename/delete with AutoCAD's guards, plot/transparency setters, full
// layer-state capture/apply, and defensive persistence validation.
//
// Fail-without-fix: on the base the module does not exist at all (the
// tsc compile below fails), and the behaviours it encodes — rename in
// the manager, delete in the manager, plot toggling, editable
// transparency, full layer states, click-to-make-current, a Properties
// layer control — have no implementation anywhere in the app.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cad-layer-a16-"));
try {
  execSync(`npx tsc src/modules/cad-viewer/cad-layer-manager.ts --outDir ${out} --rootDir src --module commonjs --target es2020 --skipLibCheck`, { cwd: root, stdio: "pipe" });
} catch (e) {
  const log = String((e.stdout || "") + (e.stderr || ""));
  assert.fail("type errors in cad-layer-manager.ts:\n" + log);
}
const lm = require(path.join(out, "modules/cad-viewer/cad-layer-manager.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

const line = (layer, x = 0) => ({ type: "LINE", layer, start: { x, y: 0 }, end: { x: x + 10, y: 0 } });
function doc() {
  return {
    layers: [
      { name: "0", color: 7 },
      { name: "Walls", color: 1, lineType: "Continuous", lineweight: 0.5 },
      { name: "Doors", color: 3, frozen: true },
      { name: "Hidden", color: 2, off: true, locked: true, transparency: 40, plot: false },
    ],
    entities: [line("0"), line("Walls", 20), line("Walls", 40), line("Doors", 60)],
    layouts: [{ name: "Layout1", entities: [line("Walls", 80)] }],
  };
}

// ---- Name validation ----
t("validate: empty / blank rejected", () => {
  assert.ok(lm.validateLayerName("", ["0"]));
  assert.ok(lm.validateLayerName("   ", ["0"]));
});
t("validate: forbidden characters rejected", () => {
  for (const bad of ["A<B", "A>B", "A/B", 'A"B', "A\\B", "A:B", "A;B", "A?B", "A*B", "A|B", "A=B", "A,B"]) {
    assert.ok(lm.validateLayerName(bad, ["0"]), bad);
  }
});
t("validate: duplicate rejected case-insensitively, own name allowed", () => {
  assert.ok(lm.validateLayerName("walls", ["0", "Walls"]));
  assert.ok(lm.validateLayerName("WALLS", ["0", "Walls"]));
  assert.strictEqual(lm.validateLayerName("Walls", ["0", "Walls"], "Walls"), null);
  assert.strictEqual(lm.validateLayerName("Walls-New", ["0", "Walls"]), null);
});
t("validate: over-long name rejected", () => {
  assert.ok(lm.validateLayerName("x".repeat(256), ["0"]));
  assert.strictEqual(lm.validateLayerName("x".repeat(255), ["0"]), null);
});

// ---- Plot flag ----
t("layerPlots: undefined and true plot, false does not", () => {
  assert.strictEqual(lm.layerPlots(undefined), true);
  assert.strictEqual(lm.layerPlots({ name: "A", color: 7 }), true);
  assert.strictEqual(lm.layerPlots({ name: "A", color: 7, plot: true }), true);
  assert.strictEqual(lm.layerPlots({ name: "A", color: 7, plot: false }), false);
});
t("setLayerPlot flips the flag, missing layer fails", () => {
  const d = doc();
  assert.strictEqual(lm.setLayerPlot(d, "Walls", false), true);
  assert.strictEqual(d.layers[1].plot, false);
  assert.strictEqual(lm.setLayerPlot(d, "Walls", true), true);
  assert.strictEqual(d.layers[1].plot, true);
  assert.strictEqual(lm.setLayerPlot(d, "Nope", false), false);
});
t("setLayerTransparency validates 0-90 integers, 0 clears", () => {
  const d = doc();
  assert.strictEqual(lm.setLayerTransparency(d, "Walls", 50), true);
  assert.strictEqual(d.layers[1].transparency, 50);
  assert.strictEqual(lm.setLayerTransparency(d, "Walls", 0), true);
  assert.strictEqual("transparency" in d.layers[1], false);
  assert.strictEqual(lm.setLayerTransparency(d, "Walls", 91), false);
  assert.strictEqual(lm.setLayerTransparency(d, "Walls", -1), false);
  assert.strictEqual(lm.setLayerTransparency(d, "Walls", 12.5), false);
  assert.strictEqual(lm.setLayerTransparency(d, "Nope", 10), false);
});

// ---- Rename ----
t("rename: retargets model + layout entities, hidden set, current layer", () => {
  const d = doc();
  const hidden = new Set(["Walls", "Hidden"]);
  const r = lm.renameLayer(d, "Walls", "Walls-New", "Walls", hidden);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.current, "Walls-New");
  assert.strictEqual(d.layers[1].name, "Walls-New");
  assert.ok(d.entities.every((e) => e.layer !== "Walls"));
  assert.strictEqual(d.entities.filter((e) => e.layer === "Walls-New").length, 2);
  assert.strictEqual(d.layouts[0].entities[0].layer, "Walls-New");
  assert.ok(!hidden.has("Walls") && hidden.has("Walls-New") && hidden.has("Hidden"));
});
t("rename: leaves current alone when another layer is renamed", () => {
  const d = doc();
  const r = lm.renameLayer(d, "Doors", "Doors-New", "Walls", new Set());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.current, "Walls");
});
t("rename: refuses layer 0, duplicates, bad names, missing layer", () => {
  const d = doc();
  assert.strictEqual(lm.renameLayer(d, "0", "Zero", "0", new Set()).ok, false);
  assert.strictEqual(lm.renameLayer(d, "Walls", "Doors", "Walls", new Set()).ok, false);
  assert.strictEqual(lm.renameLayer(d, "Walls", "Bad/Name", "Walls", new Set()).ok, false);
  assert.strictEqual(lm.renameLayer(d, "Walls", "  ", "Walls", new Set()).ok, false);
  assert.strictEqual(lm.renameLayer(d, "Ghost", "New", "Walls", new Set()).ok, false);
  assert.strictEqual(d.layers[1].name, "Walls");
});

// ---- Delete ----
t("delete: removes layer and its entities everywhere, returns them", () => {
  const d = doc();
  const r = lm.deleteLayer(d, "Walls", "0");
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.deleted.length, 3);
  assert.strictEqual(d.layers.some((l) => l.name === "Walls"), false);
  assert.ok(d.entities.every((e) => e.layer !== "Walls"));
  assert.strictEqual(d.layouts[0].entities.length, 0);
});
t("delete: refuses layer 0, current layer, missing layer", () => {
  const d = doc();
  assert.strictEqual(lm.deleteLayer(d, "0", "Walls").ok, false);
  assert.strictEqual(lm.deleteLayer(d, "Walls", "Walls").ok, false);
  assert.strictEqual(lm.deleteLayer(d, "Ghost", "0").ok, false);
  assert.strictEqual(d.layers.length, 4);
  assert.strictEqual(d.entities.length, 4);
});
t("deleteGuard: same refusals without deleting, null when deletable", () => {
  const d = doc();
  assert.ok(lm.deleteGuard(d, "0", "Walls"));
  assert.ok(lm.deleteGuard(d, "Walls", "Walls"));
  assert.ok(lm.deleteGuard(d, "Ghost", "0"));
  assert.strictEqual(lm.deleteGuard(d, "Doors", "Walls"), null);
  assert.strictEqual(d.layers.length, 4);
});

// ---- Layer states ----
t("capture/apply: full property set round-trips, current restored", () => {
  const d = doc();
  const snap = lm.captureLayerState(d, "Walls");
  assert.strictEqual(snap.layers.Hidden.off, true);
  assert.strictEqual(snap.layers.Hidden.locked, true);
  assert.strictEqual(snap.layers.Hidden.transparency, 40);
  assert.strictEqual(snap.layers.Hidden.plot, false);
  assert.strictEqual(snap.layers.Doors.frozen, true);
  // Mutate everything, then restore.
  d.layers[1].color = 9; d.layers[1].off = true; d.layers[1].lineweight = 2;
  d.layers[3].off = false; d.layers[3].locked = false; d.layers[3].transparency = 10; d.layers[3].plot = true;
  const r = lm.applyLayerState(d, snap);
  assert.deepStrictEqual(r.missing, []);
  assert.strictEqual(r.current, "Walls");
  assert.strictEqual(d.layers[1].color, 1);
  assert.strictEqual(d.layers[1].off, false);
  assert.strictEqual(d.layers[1].lineweight, 0.5);
  assert.strictEqual(d.layers[3].off, true);
  assert.strictEqual(d.layers[3].locked, true);
  assert.strictEqual(d.layers[3].transparency, 40);
  assert.strictEqual(d.layers[3].plot, false);
  assert.ok(r.off.includes("Hidden") && r.frozen.includes("Doors"));
});
t("apply: missing layers reported, not recreated; unknown current ignored", () => {
  const d = doc();
  const snap = lm.captureLayerState(d, "Walls");
  snap.layers.Ghost = { off: true, frozen: false, locked: false, color: 5 };
  snap.current = "Ghost";
  const r = lm.applyLayerState(d, snap);
  assert.deepStrictEqual(r.missing, ["Ghost"]);
  assert.strictEqual(d.layers.some((l) => l.name === "Ghost"), false);
  assert.strictEqual(r.current, "");
});
t("apply: clears properties the snapshot does not carry", () => {
  const d = doc();
  d.layers[1].rgb = 0xff0000;
  const snap = lm.captureLayerState(d, "0");
  delete snap.layers.Walls.rgb;
  d.layers[1].rgb = 0x00ff00;
  lm.applyLayerState(d, snap);
  assert.strictEqual("rgb" in d.layers[1], false);
});

// ---- Persistence validation ----
t("serialize/sanitize: valid states survive, malformed ones are dropped", () => {
  const d = doc();
  const states = new Map([
    ["A", { ...lm.captureLayerState(d, "Walls"), name: "A" }],
    ["B", { ...lm.captureLayerState(d, "Doors"), name: "B" }],
  ]);
  const raw = lm.serializeLayerStates(states);
  raw.C = { current: "Walls", layers: { Walls: { off: "yes", frozen: false, locked: false, color: 1 } } };
  raw.D = { current: "Walls", layers: { Walls: { off: false, frozen: false, locked: false, color: 1, transparency: 99 } } };
  raw.E = "not an object";
  raw.F = { current: 42, layers: {} };
  const clean = lm.sanitizeLayerStates(raw);
  assert.deepStrictEqual(Object.keys(clean).sort(), ["A", "B"]);
  assert.strictEqual(clean.A.layers.Walls.color, 1);
  assert.deepStrictEqual(lm.sanitizeLayerStates(null), {});
  assert.deepStrictEqual(lm.sanitizeLayerStates("junk"), {});
  assert.deepStrictEqual(lm.sanitizeLayerStates([]), {});
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
