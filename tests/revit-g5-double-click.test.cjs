/**
 * Revit 2D double-click — audit gap G5.
 *
 * Double-click a model element must open Type Properties for that element
 * (3D viewport and plan view); double-click an annotation must still edit
 * its text; double-click a dimension must still edit its text; empty space
 * keeps its current behaviour (plan: fit view, 3D: nothing).
 *
 * This test pins the fix two ways:
 *   (1) runtime: compile the pure dispatch module and assert the full
 *       decision table plus the performer (select-before-open ordering
 *       included — Type Properties reads the type from the selection);
 *   (2) source: assert the live wiring in the 3D handler and the plan
 *       double-click handler, and that `modify.typeProperties` is still
 *       the command both paths run.
 *
 * Deliberately NOT asserted here: a Family Editor on double-click. No
 * per-element family edit session exists (see the dispatch module docs);
 * claiming one would be a lie.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");

const ROOT = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ── (1) runtime: the pure dispatch module ────────────────────────────
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "g5-"));
execSync(`npx tsc src/modules/double-click/double-click-dispatch.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
const g5 = require(path.join(out, "double-click-dispatch.js"));

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// Full decision table: [target, view, shiftKey] -> action kind.
const table = [
  [{ kind: "authored-element", elementId: "wall-1" }, "3d", false, "open-type-properties"],
  [{ kind: "authored-element", elementId: "wall-1" }, "plan", false, "open-type-properties"],
  [{ kind: "authored-element", elementId: "wall-1" }, "3d", true, "fit-element"],
  [{ kind: "authored-element", elementId: "wall-1" }, "plan", true, "fit-element"],
  [{ kind: "fragment-element", modelId: "m1", localId: 7 }, "3d", false, "fit-element"],
  [{ kind: "fragment-element", modelId: "m1", localId: 7 }, "3d", true, "fit-element"],
  [{ kind: "fragment-element", modelId: "m1", localId: 7 }, "plan", false, "fit-element"],
  [{ kind: "annotation" }, "3d", false, "edit-annotation-text"],
  [{ kind: "annotation" }, "plan", false, "edit-annotation-text"],
  [{ kind: "annotation" }, "plan", true, "edit-annotation-text"],
  [{ kind: "dimension" }, "plan", false, "edit-dimension-text"],
  [{ kind: "dimension" }, "plan", true, "edit-dimension-text"],
  [{ kind: "empty" }, "plan", false, "fit-view"],
  [{ kind: "empty" }, "plan", true, "fit-view"],
  [{ kind: "empty" }, "3d", false, "none"],
  [{ kind: "empty" }, "3d", true, "none"],
];
for (const [target, view, shiftKey, want] of table) {
  const a = g5.resolveDoubleClickAction(target, { view, shiftKey });
  ok(a.kind === want, `${target.kind} in ${view}${shiftKey ? " +Shift" : ""} -> ${want} (got ${a.kind})`);
}
const opened = g5.resolveDoubleClickAction(
  { kind: "authored-element", elementId: "wall-9" }, { view: "3d", shiftKey: false },
);
ok(opened.kind === "open-type-properties" && opened.elementId === "wall-9",
  "open-type-properties carries the clicked element id");

// Performer: each action calls exactly the right environment callback,
// and Type Properties opens only AFTER the element is selected.
function recordingEnv() {
  const calls = [];
  return {
    calls,
    env: {
      selectAuthoredElement: (id) => calls.push(["select", id]),
      openTypeProperties: () => calls.push(["open-type-properties"]),
      fitElement: () => calls.push(["fit-element"]),
      fitView: () => calls.push(["fit-view"]),
    },
  };
}
{
  const r = recordingEnv();
  g5.performDoubleClickAction({ kind: "open-type-properties", elementId: "wall-1" }, r.env);
  assert.deepStrictEqual(r.calls, [["select", "wall-1"], ["open-type-properties"]],
    "open-type-properties selects the element first, then opens the panel");
  n++;
}
for (const [action, want] of [
  [{ kind: "fit-element" }, ["fit-element"]],
  [{ kind: "fit-view" }, ["fit-view"]],
]) {
  const r = recordingEnv();
  g5.performDoubleClickAction(action, r.env);
  assert.deepStrictEqual(r.calls, [want], `${action.kind} calls only ${want[0]}`);
  n++;
}
for (const action of [{ kind: "none" }, { kind: "edit-annotation-text" }, { kind: "edit-dimension-text" }]) {
  const r = recordingEnv();
  g5.performDoubleClickAction(action, r.env);
  ok(r.calls.length === 0, `${action.kind} is a performer no-op (caller-owned / intentional)`);
}

// ── (2) source: the live wiring ──────────────────────────────────────
const dbl = read("src/features/dblclick-fit.ts");
const plan = read("src/features/plan-view-panel.ts");
const bim = read("src/features/bim-experience.ts");

// 3D: the input-router dblclick path resolves through the dispatch module,
// opens Type Properties for authored elements, and keeps fit for Shift and
// for fragments; empty space stays a no-op.
ok(dbl.includes("resolveDoubleClickAction"), "dblclick-fit: resolves through the G5 dispatch module");
ok(dbl.includes("open-type-properties"), "dblclick-fit: handles the open-type-properties action");
ok(dbl.includes('execute("modify.typeProperties")') || dbl.includes("executeBimCommand"), "dblclick-fit: runs modify.typeProperties");
ok(dbl.includes("setSelectedAuthored"), "dblclick-fit: selects the clicked element before opening Type Properties");
ok(dbl.includes("setOrbitPivot"), "dblclick-fit: still sets the orbit pivot on the element");
ok(dbl.includes("fitUnderCursor"), "dblclick-fit: the old fit path is kept (Shift+double-click)");
ok(/empty space -> no-op/.test(dbl), "dblclick-fit: empty-space no-op is still documented");
ok(dbl.includes('g.mods?.shift') || dbl.includes("mods.shift"), "dblclick-fit: Shift is read from the gesture mods");

// Plan: annotation first, then dimension, then the element branch; empty
// space still falls through to the fitPlanView listener.
ok(plan.includes("resolveDoubleClickAction"), "plan: resolves through the G5 dispatch module");
ok(plan.includes("nearestAuthoredAt(w)"), "plan: double-click hit-tests the model element");
ok(plan.includes("openTypePropertiesForPlan"), "plan: element double-click runs the Type Properties helper");
ok(plan.includes("setPlanSelectedElement(near.element"), "plan: selects the clicked element before opening Type Properties");
ok(plan.includes('(ctx.features as any).bimExperience'), "plan: reaches the command through the BIM experience handle");
ok(plan.includes('canvasWrap.addEventListener("dblclick", fitPlanView)'), "plan: empty-space fit-view listener is kept");
{
  const handler = plan.slice(plan.indexOf('canvasWrap.addEventListener("dblclick"'));
  const annoAt = handler.indexOf("hitAnnotation");
  const dimAt = handler.indexOf("hitDimension");
  const elAt = handler.indexOf("nearestAuthoredAt");
  ok(annoAt !== -1 && dimAt !== -1 && elAt !== -1, "plan: dblclick handler checks annotation, dimension, element");
  ok(annoAt < dimAt && dimAt < elAt, "plan: annotation and dimension keep priority over the element branch");
}

// The command itself is unchanged and reads the type from the selection.
ok(/id: "modify\.typeProperties"/.test(bim), "bim-experience: modify.typeProperties is still registered");
ok(bim.includes("const ids = getAuthoredSelection();") && bim.includes("openTypeProperties"),
  "bim-experience: Type Properties resolves the type from the current selection");
ok(bim.includes("export function executeBimCommand"), "bim-experience: executeBimCommand fallback still exported");

// No Family Editor is faked: nothing in either double-click path claims
// to open a family editor.
ok(dbl.includes("out of reach"), "dblclick-fit: the Family Editor limit is recorded in the header");
ok(!dbl.includes("openFamilyEditor"), "dblclick-fit: no family editor function is called");
ok(!plan.includes("openFamilyEditor"), "plan: no family editor is wired");

console.log(`revit-g5-double-click: ${n} checks OK`);
