// Source-level guards for the plan-view openings chain (walls → hosted
// doors/windows → schedules/quantities) and the Escape pipeline.
//
// The modules involved are browser-coupled (THREE scene, ctx.world), so these
// are structural guards: every regression below shipped as a silent break that
// only a real browser run caught.
const fs = require("fs"), assert = require("assert");
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const read = (p) => fs.readFileSync(p, "utf8");

const plan = read("src/features/plan-view-panel.ts");
const auth = read("src/features/authoring.ts");
const esc = read("src/core/escape-all.ts");
const qty = read("src/modules/cost/quantities.ts");
const sheets = read("src/features/sheets-2d-panel.ts");

t("plan door/window tools map to hosted types, not equipment", () => {
  assert.ok(/door: \{ type: "door" \}/.test(plan), "door must map to type door");
  assert.ok(/window: \{ type: "window" \}/.test(plan), "window must map to type window");
  assert.ok(!/door: \{ type: "equipment", preset: "door" \}/.test(plan), "old equipment mapping must stay dead");
});

t("plan point placement routes door/window through addHostedOpening", () => {
  assert.ok(/planPointType === "door" \|\| planPointType === "window"[\s\S]{0,200}addHostedOpening/.test(plan));
  assert.ok(/click on a wall to insert/.test(plan), "no-wall failure must tell the user to click on a wall");
});

t("authoring exports a hosted opening placement API", () => {
  assert.ok(/export async function addHostedOpening\(/.test(auth));
  assert.ok(/hostedWallAt\(/.test(auth), "host detection helper must exist");
  assert.ok(/doorPanel: kind === "door" \? "swing" : undefined/.test(auth), "doors must carry a panel type like the 3D path");
});

t("mistyped plan openings are repaired on project load", () => {
  assert.ok(/function repairMistypedOpenings\(\)/.test(auth));
  const setEl = auth.slice(auth.indexOf("export function setElements"), auth.indexOf("export function setElements") + 900);
  assert.ok(/repairMistypedOpenings\(\)/.test(setEl), "setElements must run the repair");
});

t("repair never creates hostless (invisible) doors", () => {
  const block = auth.slice(auth.indexOf("function repairMistypedOpenings"), auth.indexOf("const followPending"));
  assert.ok(/if \(!host\) continue;/.test(block), "no wall under the point → leave the element alone");
});

t("takeoff deducts hosted openings from wall quantities", () => {
  assert.ok(/op\.hostId !== el\.id \|\| \(op\.type !== "door" && op\.type !== "window"\)/.test(qty));
  assert.ok(/Math\.max\(0, \(gross - cutArea\) \* T\)/.test(qty), "wall volume must subtract punched openings");
});

t("escape-all CAD-query fallback requires a visible panel", () => {
  assert.ok(!/getElementById\("obs-cad-query-panel"\)\?\.style\.display !== "none"/.test(esc),
    "the null-element lie (undefined !== 'none') must not come back");
  assert.ok(/cqDomOpen = !!cqDom && \(cqDom\.offsetWidth > 0 \|\| cqDom\.offsetHeight > 0\)/.test(esc));
});

t("plan Escape consumes the key only when something was canceled", () => {
  const block = plan.slice(plan.indexOf("// Esc: cancel EVERY active order"), plan.indexOf("// drawing-style command entry"));
  assert.ok(/if \(cancelAllPlan\(\)\) \{/.test(block), "must gate consumption on cancelAllPlan()");
  assert.ok(!/footerStatus\("Nothing to cancel"\)/.test(block), "the swallow-and-lie branch must stay dead");
});

t("sheets panel registers the 'sheetsPanel' service key the palette uses", () => {
  assert.ok(/registerService\("sheetsPanel"/.test(sheets), "palette 'Toggle Sheets' resolves this key — unregistered = dead command");
  assert.ok(/\(ctx\.features as any\)\.sheetsPanel = /.test(sheets), "drafting-bridge reads ctx.features.sheetsPanel");
});

t("sheets panel stacks above the plan workspace overlay", () => {
  assert.ok(/"z-index:340"/.test(sheets), "plan overlay is z=200; the old z=36 opened the panel invisibly behind it");
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
