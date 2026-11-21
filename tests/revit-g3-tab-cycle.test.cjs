/**
 * Revit 2D audit gap G3 — Tab-cycle through overlapping elements at hover.
 *
 * (1) runtime: compile the pure selection-cycle module and assert the
 *     cycling semantics — stable order, wrap-around, reset on mouse move /
 *     Esc, click selects the cycled candidate — plus the plan hit-stack
 *     geometry (same acceptance threshold as nearestAuthoredAt).
 * (2) source: assert the wiring exists in the live app — plan select-mode
 *     Tab handler, 3D hover-stack cycle in bim-experience, click override
 *     in authoring pickSelect and the fragment pointerup, status-bar
 *     readout, and that the existing Tab owners are untouched (plan dim
 *     snap cycling, MEP branch/network cycling, AccuDraw Tab).
 *
 * Run: `node tests/revit-g3-tab-cycle.test.cjs`
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── (1) runtime: the pure cycle module ──────────────────────────────────
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "g3-"));
execSync(
  `npx tsc src/modules/selection/selection-cycle.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`,
  { stdio: "pipe" },
);
const g3 = require(path.join(out, "selection-cycle.js"));

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// ── hit-stack order: nearest first, stable tie-break by key ─────────────
{
  const stack = g3.sortHitStack([
    { key: "b", label: "Wall · Wall B", kind: "authored", authoredId: "b", distance: 0.5 },
    { key: "a", label: "Wall · Wall A", kind: "authored", authoredId: "a", distance: 0.5 },
    { key: "c", label: "Wall · Wall C", kind: "authored", authoredId: "c", distance: 0.1 },
    { key: "b", label: "Wall · Wall B (far)", kind: "authored", authoredId: "b", distance: 0.9 },
  ]);
  assert.deepStrictEqual(stack.map((c) => c.key), ["c", "a", "b"],
    "nearest first, equal distances break by key, duplicate key keeps nearest");
  n++;
}

// ── cycle semantics: start at top, Tab advances, wraps, Shift+Tab reverses ──
{
  const cycle = g3.createSelectionCycle();
  const cands = [
    { key: "w1", label: "Wall · Wall 1", kind: "authored", authoredId: "w1", distance: 0.05 },
    { key: "w2", label: "Wall · Wall 2", kind: "authored", authoredId: "w2", distance: 0.2 },
    { key: "f1", label: "IFC element 41", kind: "fragment", modelId: "m", localId: 41, distance: 0.4 },
  ];
  cycle.setStack(cands);
  ok(cycle.count === 3, "stack holds 3 candidates");
  ok(cycle.current()?.key === "w1", "fresh cycle pre-highlights the top hit");
  ok(cycle.cycled === false, "fresh cycle is not cycled — a click still picks the top hit");
  ok(cycle.anchor === "w1", "anchor is the top-hit key");

  const first = cycle.advance(1);
  ok(first?.key === "w2", "first Tab moves to the second candidate");
  ok(cycle.cycled === true, "after Tab the cycle is active");
  ok(cycle.currentIndex === 1, "index tracks the pre-highlight");
  ok(g3.formatCycleLabel(cycle.current(), cycle.currentIndex, cycle.count) === "Wall · Wall 2 (2/3)",
    "readout shows label + position");
  ok(g3.formatCycleStatus(cycle.current(), cycle.currentIndex, cycle.count) ===
    "Tab 2/3: Wall · Wall 2 — click to select, Esc to cancel", "status readout format");

  cycle.advance(1);
  ok(cycle.current()?.key === "f1", "second Tab reaches the fragment candidate");
  const wrapped = cycle.advance(1);
  ok(wrapped?.key === "w1" && cycle.currentIndex === 0, "Tab wraps around to the top");
  const back = cycle.advance(-1);
  ok(back?.key === "f1", "Shift+Tab steps backwards with wrap");
  n++;
}

// ── a lone element cannot be cycled ─────────────────────────────────────
{
  const cycle = g3.createSelectionCycle();
  cycle.setStack([{ key: "only", label: "Wall · Wall 1", kind: "authored", authoredId: "only", distance: 0.1 }]);
  ok(cycle.advance(1) === null, "Tab on a single-candidate stack is a no-op");
  ok(cycle.cycled === false, "single candidate never counts as cycled");
  ok(cycle.current()?.key === "only", "current stays the lone element");
  const empty = g3.createSelectionCycle();
  ok(empty.advance(1) === null && empty.current() === null, "empty stack has no current");
  n++;
}

// ── reset on Esc / mouse move (anchor change) ───────────────────────────
{
  const cycle = g3.createSelectionCycle();
  cycle.setStack([
    { key: "w1", label: "Wall · Wall 1", kind: "authored", authoredId: "w1", distance: 0.05 },
    { key: "w2", label: "Wall · Wall 2", kind: "authored", authoredId: "w2", distance: 0.2 },
  ]);
  cycle.advance(1);
  ok(cycle.cycled === true, "cycled before reset");
  ok(cycle.anchorChanged("w1") === false, "same hover anchor keeps the cycle");
  ok(cycle.anchorChanged("w2") === true, "hover moving to another top hit invalidates the cycle");
  ok(cycle.anchorChanged(null) === true, "mouse leaving the hover spot invalidates the cycle");
  cycle.reset();
  ok(cycle.count === 0 && cycle.current() === null && cycle.cycled === false && cycle.anchor === null,
    "Esc reset clears stack, position, cycled flag and anchor");
  n++;
}

// ── click selects the cycled candidate, not the topmost hit ──────────────
// (The app click paths consult cycle.current() when cycle.cycled; the
//  decision itself is pinned here: the candidate a click must take.)
{
  const cycle = g3.createSelectionCycle();
  cycle.setStack([
    { key: "w1", label: "Wall · Wall 1", kind: "authored", authoredId: "w1", distance: 0.05 },
    { key: "w2", label: "Wall · Wall 2", kind: "authored", authoredId: "w2", distance: 0.2 },
  ]);
  const clickTarget = (c) => (c.cycled ? c.current() : null);
  ok(clickTarget(cycle) === null, "uncycled hover: click takes the top hit, not the cycle");
  cycle.advance(1);
  ok(clickTarget(cycle)?.authoredId === "w2", "cycled hover: click takes the Tab-selected candidate");
  cycle.reset();
  ok(clickTarget(cycle) === null, "after reset the click override is gone");
  n++;
}

// ── plan hit-stack geometry: two crossing walls overlap at the crossing ─
{
  const els = [
    { id: "w1", type: "wall", name: "Wall 1", params: { start: [-4, 0], end: [4, 0], thickness: 0.2 } },
    { id: "w2", type: "wall", name: "Wall 2", params: { start: [0, -3], end: [0, 3], thickness: 0.2 } },
    { id: "w3", type: "wall", name: "Wall 3", params: { start: [10, 10], end: [14, 10], thickness: 0.2 } },
  ];
  const atCrossing = g3.authoredElementsAt(els, { x: 0, z: 0 });
  assert.deepStrictEqual(atCrossing.map((h) => h.element.id), ["w1", "w2"],
    "both crossing walls overlap the cursor; the far wall does not");
  ok(atCrossing[0].distance < 0, "cursor inside the wall reads a negative distance");
  const away = g3.authoredElementsAt(els, { x: 0, z: 2 });
  assert.deepStrictEqual(away.map((h) => h.element.id), ["w2"],
    "2 m along the vertical wall only the vertical wall overlaps");
  const none = g3.authoredElementsAt(els, { x: 8, z: 8 });
  ok(none.length === 0, "empty spot has an empty stack");
  // Same acceptance threshold as nearestAuthoredAt (0.85 m): a wall whose
  // edge is 0.9 m away is out of reach for both click and Tab-cycle.
  const edge = g3.authoredElementsAt(
    [{ id: "w", type: "wall", name: "Wall", params: { start: [-4, 1], end: [4, 1], thickness: 0.2 } }],
    { x: 0, z: 0 },
  );
  ok(edge.length === 0, "wall 0.9 m away (minus half-thickness) is outside the 0.85 m threshold");
  // Point elements (columns) and polygon elements join the stack too.
  const mixed = g3.authoredElementsAt(
    [
      { id: "c1", type: "column", name: "Column 1", params: { point: [0.1, 0], width: 0.3 } },
      { id: "s1", type: "slab", name: "Slab 1", params: { polygon: [[-1, -1], [1, -1], [1, 1], [-1, 1]] } },
    ],
    { x: 0, z: 0 },
  );
  assert.deepStrictEqual(mixed.map((h) => h.element.id), ["c1", "s1"],
    "column (cursor inside, distance -0.065) sorts before the slab (centre distance 0)");
  const cands = g3.planHitsToCandidates(atCrossing);
  assert.deepStrictEqual(cands.map((c) => c.key), ["w1", "w2"], "plan hits convert to cycle candidates keyed by id");
  ok(cands[0].label === "wall · Wall 1", "candidate label carries type + name");
  ok(g3.planElementLabel({ id: "x", type: "duct" }) === "duct", "unnamed element labels by type");
  n++;
}

// ── (2) source: the wiring exists in the live app ───────────────────────
{
  const plan = read("src/features/plan-view-panel.ts");
  ok(plan.includes("selection-cycle"), "plan view imports the selection-cycle module");
  ok(plan.includes("planTabCycle") || plan.includes("planCycle"), "plan keeps a Tab-cycle instance");
  ok(/planMode === "select"[\s\S]{0,400}?e\.key === "Tab"/.test(plan) ||
     /e\.key === "Tab"[\s\S]{0,400}?planMode === "select"/.test(plan),
    "plan handles Tab in select mode (not only dim-mode snap cycling)");
  ok(plan.includes("Tab") && plan.includes("planMode === \"dim\"") && plan.includes("planSnapCycle"),
    "plan dim-mode snap Tab cycling is still present");
  ok(/cancelAllPlan[\s\S]{0,2000}?[Tt]ab.?[Cc]ycle/.test(plan) || plan.includes("resetPlanTabCycle"),
    "plan Esc (cancelAllPlan) resets the Tab cycle");

  const bim = read("src/features/bim-experience.ts");
  ok(bim.includes("selection-cycle"), "bim-experience imports the selection-cycle module");
  ok(bim.includes("hoverPreselectCycle") || bim.includes("preselectCycle"),
    "3D hover drives the shared preselect cycle");
  ok(bim.includes("pickAuthoredHitsAt"),
    "3D hover stack raycasts the authoring group (pickAuthoredHitsAt)");
  ok(!bim.includes("getObjectByName(obj.id)"),
    "old getObjectByName hover lookup is gone (meshes are never named by id)");
  ok(bim.includes("cycleMepSelection"), "MEP branch/network Tab cycling is still wired");
  ok(bim.includes("tab-cycle") && bim.includes("registerEscapeScope"),
    "3D Tab cycle registers an escape-all scope so Esc resets it");
  // The old global-order preselection cycle (Tab selected the NEXT authored
  // element in array order, regardless of what is under the cursor) must be
  // gone: Tab now pre-highlights within the hover hit-stack only.
  ok(!/authored\[\(idx \+ 1\) % authored\.length\]/.test(bim),
    "old Tab cycle through ALL authored elements in creation order is removed");

  const authoring = read("src/features/authoring.ts");
  ok(authoring.includes("hoverPreselectCycle") || authoring.includes("selection-cycle"),
    "authoring click-select consults the shared cycle");
  ok(authoring.includes("export function pickAuthoredHitsAt"),
    "authoring exports pickAuthoredHitsAt (all authored hits, nearest first)");
  const sel = read("src/features/selection.ts");
  ok(sel.includes("hoverPreselectCycle") || sel.includes("selection-cycle"),
    "fragment click path consults the shared cycle");
  const statusBar = read("src/shell/status-bar.ts");
  ok(statusBar.includes("tab-cycle") || statusBar.includes("TabCycle") || statusBar.includes("cycle"),
    "status bar carries the Tab-cycle readout");

  // Existing Tab owners untouched.
  const shortcuts = read("src/shell/default-shortcuts.ts");
  ok(shortcuts.includes("accu-noop-tab"), "AccuDraw Tab ownership is untouched");
  ok(read("src/features/authoring.ts").includes('e.key === "Tab"'),
    "authoring Tab handling (non-select tools) is untouched");
  n++;
}

console.log(`revit-g3-tab-cycle: ${n} checks passed`);
