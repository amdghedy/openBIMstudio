/**
 * tests/revit-g9-view-controls.test.cjs
 *
 * G9 — View controls (REVIT_2D_ENVIRONMENT.md §2 G9):
 *   - full Revit-style plan scale list, each scale mapping to a real render scale
 *   - crop follows the active view (no hardcoded view id at the call site)
 *   - Underlay "Below" renders the level underneath, greyed
 *
 * Pure-model tests: compile src/modules/views/plan-view-controls.ts with
 * tsc and require it (house pattern), plus source-wiring assertions that
 * the panel / ribbon / bridge actually use the model.
 *
 * Run: `node tests/revit-g9-view-controls.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}: ${e.message}`);
  }
}

const repoRoot = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "g9-view-controls-"));
// The module imports plan-types, which (since rank 8) imports
// projects/types, so the tsc program's common root is src/ and the
// emitted file lands at out/modules/views/plan-view-controls.js. Pin
// --rootDir src so the layout is deterministic instead of depending on
// the import graph, and require the module from that path.
execSync(
  `npx tsc src/modules/views/plan-view-controls.ts --outDir ${out} --rootDir src --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,
  { stdio: "inherit" },
);
const m = require(path.join(out, "modules", "views", "plan-view-controls.js"));

const readSrc = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
const panelSrc = readSrc("src/features/plan-view-panel.ts");
const ribbonSrc = readSrc("src/shell/ribbon.ts");
const globalsSrc = readSrc("src/modules/module-globals.ts");

// ── Scale list ───────────────────────────────────────────────────────────
const EXPECTED_SCALES = [5, 10, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 400, 500, 1000];

t("scale list is the full Revit-style set (1:5–1:1000, with intermediates)", () => {
  assert.deepStrictEqual([...m.PLAN_VIEW_SCALES], EXPECTED_SCALES);
});

t("scale list is sorted ascending with no duplicates", () => {
  const s = [...m.PLAN_VIEW_SCALES];
  assert.strictEqual(new Set(s).size, s.length, "duplicate scale");
  for (let i = 1; i < s.length; i++) assert.ok(s[i] > s[i - 1], "not sorted");
});

t("scale options carry the 1 : N label for every listed scale", () => {
  assert.strictEqual(m.PLAN_VIEW_SCALE_OPTIONS.length, EXPECTED_SCALES.length);
  for (const [value, label] of m.PLAN_VIEW_SCALE_OPTIONS) {
    assert.strictEqual(label, `1 : ${value}`);
  }
});

t("every listed scale maps to a distinct, real render factor", () => {
  // The renderer honours a scale through paperMmToWorld: a 2.5 mm text at
  // 1:N is 2.5*N/1000 m in model space. The factor must be exact and
  // strictly increasing, so no listed scale is a no-op.
  let prev = -Infinity;
  for (const s of EXPECTED_SCALES) {
    const w = m.paperMmToWorldForScale(2.5, s);
    assert.ok(Math.abs(w - (2.5 * s) / 1000) < 1e-12, `1:${s} factor ${w}`);
    assert.ok(w > prev, `1:${s} does not render larger than the previous scale`);
    prev = w;
  }
});

t("normalizePlanScale accepts listed scales and falls back otherwise", () => {
  assert.strictEqual(m.normalizePlanScale(5), 5);
  assert.strictEqual(m.normalizePlanScale(1000), 1000);
  assert.strictEqual(m.normalizePlanScale(100), 100);
  assert.strictEqual(m.normalizePlanScale(60), 100, "unlisted 1:60 must fall back");
  assert.strictEqual(m.normalizePlanScale(0), 100);
  assert.strictEqual(m.normalizePlanScale(-50), 100);
  assert.strictEqual(m.normalizePlanScale(NaN), 100);
  assert.strictEqual(m.normalizePlanScale("abc"), 100);
  assert.strictEqual(m.normalizePlanScale("200"), 200, "stored string value is accepted");
  assert.strictEqual(m.normalizePlanScale(60, 50), 50, "explicit fallback is honoured");
});

t("isListedPlanScale rejects the old 4-only assumption", () => {
  assert.strictEqual(m.isListedPlanScale(20), true);
  assert.strictEqual(m.isListedPlanScale(75), true);
  assert.strictEqual(m.isListedPlanScale(60), false);
});

// ── Underlay "Below" ─────────────────────────────────────────────────────
const LEVELS = [
  { name: "Level 0", elevation: 0 },
  { name: "Level 1", elevation: 3 },
  { name: "Level 2", elevation: 6 },
];

t("resolveUnderlayLevel returns the level directly below", () => {
  assert.deepStrictEqual(m.resolveUnderlayLevel(LEVELS, 2), LEVELS[1]);
  assert.deepStrictEqual(m.resolveUnderlayLevel(LEVELS, 1), LEVELS[0]);
});

t("resolveUnderlayLevel returns null on the lowest / only level", () => {
  assert.strictEqual(m.resolveUnderlayLevel(LEVELS, 0), null);
  assert.strictEqual(m.resolveUnderlayLevel([LEVELS[0]], 0), null);
  assert.strictEqual(m.resolveUnderlayLevel([], 0), null);
  assert.strictEqual(m.resolveUnderlayLevel(LEVELS, 3), null, "out-of-range index");
  assert.strictEqual(m.resolveUnderlayLevel(LEVELS, -1), null);
});

t("greyUnderlaySegments keeps geometry, greys the presentation", () => {
  const segs = [
    { x1: 0, z1: 0, x2: 4, z2: 0, kind: "cut", source: "wall-1" },
    { x1: 4, z1: 0, x2: 4, z2: 3, kind: "below" },
  ];
  const greyed = m.greyUnderlaySegments(segs);
  assert.strictEqual(greyed.length, 2);
  assert.deepStrictEqual(
    greyed.map(({ x1, z1, x2, z2, kind }) => ({ x1, z1, x2, z2, kind })),
    segs.map(({ x1, z1, x2, z2, kind }) => ({ x1, z1, x2, z2, kind })),
  );
  assert.strictEqual(greyed[0].source, "wall-1");
  assert.strictEqual(greyed[1].source, undefined);
  for (const g of greyed) {
    assert.strictEqual(g.stroke, "#9ca3af");
    assert.strictEqual(g.opacity, 0.55);
    assert.strictEqual(g.pointerEvents, "none");
    assert.ok(g.strokeWidth > 0 && g.strokeWidth <= 1);
  }
  // Input is not mutated.
  assert.strictEqual(segs[0].stroke, undefined);
});

t("underlay style constants are the grey Revit-underlay values", () => {
  assert.strictEqual(m.UNDERLAY_STROKE, "#9ca3af");
  assert.strictEqual(m.UNDERLAY_OPACITY, 0.55);
});

// ── Crop follows the active view ─────────────────────────────────────────
t("resolveCropViewId follows the active view id", () => {
  assert.strictEqual(m.resolveCropViewId("plan-view-2"), "plan-view-2");
  assert.strictEqual(m.resolveCropViewId("section-view-1"), "section-view-1");
});

t("resolveCropViewId falls back only when nothing is active", () => {
  assert.strictEqual(m.resolveCropViewId(null), "plan-view-1");
  assert.strictEqual(m.resolveCropViewId(undefined), "plan-view-1");
  assert.strictEqual(m.resolveCropViewId(""), "plan-view-1");
  assert.strictEqual(m.resolveCropViewId(null, "plan-view-9"), "plan-view-9");
});

// ── Source wiring (the model must actually be used) ─────────────────────
t("plan header scale select is built from the full scale list", () => {
  assert.ok(panelSrc.includes("PLAN_VIEW_SCALE_OPTIONS"), "panel never references the scale list");
  assert.ok(
    panelSrc.includes("compactSelect([...PLAN_VIEW_SCALE_OPTIONS]"),
    "header scaleSelect is not built from PLAN_VIEW_SCALE_OPTIONS",
  );
  assert.ok(
    !panelSrc.includes('[["50", "1 : 50"], ["100", "1 : 100"], ["200", "1 : 200"], ["500", "1 : 500"]]'),
    "old 4-only scale list is still present",
  );
});

t("plan scale loader only accepts a listed scale", () => {
  assert.ok(panelSrc.includes("normalizePlanScale(Number(localStorage.getItem(PLAN_SCALE_KEY))"),
    "persisted scale is not normalised through the scale list");
});

t("View Properties View Scale row uses the full list", () => {
  assert.ok(panelSrc.includes("select([...PLAN_VIEW_SCALE_OPTIONS]"),
    "View Properties scale row is not built from PLAN_VIEW_SCALE_OPTIONS");
});

t("Underlay select has no dead option and actually re-renders", () => {
  assert.ok(!panelSrc.includes('[["None","None"],["Below","Below"],["Link drawing"'),
    "dead 'Link drawing' underlay option is still in the select");
  assert.ok(panelSrc.includes('refreshUnderlayAndRender'),
    "Underlay change does not refresh the underlay + render");
  assert.ok(panelSrc.includes('let planUnderlay: "None" | "Below"'),
    "planUnderlay is not typed to the two live options");
});

t("regenerate() generates the underlay for the level below", () => {
  assert.ok(panelSrc.includes("await refreshUnderlayPlan();"),
    "regenerateNow does not refresh the underlay plan");
  assert.ok(panelSrc.includes("resolveUnderlayLevel(levels, currentIndex)"),
    "underlay level is not resolved from the level below");
});

t("renderPlan draws the greyed underlay beneath the live geometry", () => {
  assert.ok(panelSrc.includes('data-obs-underlay'), "no underlay group marker in renderPlan");
  assert.ok(panelSrc.includes("greyUnderlaySegments(underlayPlan.segments)"),
    "underlay segments are not drawn through greyUnderlaySegments");
  assert.ok(panelSrc.includes("svg.insertBefore(ug, g)"),
    "underlay group is not inserted beneath the live geometry group");
});

t("plan marks itself the active crop view when it opens", () => {
  // togglePlanView (not just the Crop View checkbox row) must mark the
  // plan active, so the ribbon follows it from the moment the plan opens.
  const body = panelSrc.match(/export function togglePlanView\(\) \{[\s\S]*?\n\}/);
  assert.ok(body, "togglePlanView not found");
  assert.ok(body[0].includes("setCropActiveView(PLAN_CROP_ID)"),
    "togglePlanView does not mark the plan as the active crop view");
});

t("ribbon Crop View group has no hardcoded view id", () => {
  assert.ok(!ribbonSrc.includes('"plan-view-1"'),
    "ribbon still hardcodes \"plan-view-1\"");
  assert.ok(ribbonSrc.includes("resolveCropViewId((ctx.features as any).cropRegion?.getActive?.())"),
    "ribbon crop buttons do not resolve the active view id");
  assert.ok(ribbonSrc.includes('import { resolveCropViewId } from "../modules/views/plan-view-controls"'),
    "ribbon does not import the crop-view resolver");
});

t("crop bridge exposes the active view", () => {
  assert.ok(globalsSrc.includes("getActive: getActiveCropView"),
    "__obsCropRegion has no getActive");
  assert.ok(globalsSrc.includes("getActiveCropView"),
    "module-globals does not import getActiveCropView");
});

console.log(`\nrevit-g9-view-controls: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
