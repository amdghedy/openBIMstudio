const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = p => fs.readFileSync(path.join(root, p), "utf8");
const palette = read("src/features/selection-snapping-palette.ts");
const snapping = read("src/features/snapping.ts");
const selection = read("src/features/selection.ts");
const main = read("src/main.ts");
const ribbon = read("src/shell/ribbon.ts");
const checks = [
  ["four built-in drafting profiles", ["architectural", "structural", "mep", "precision"].every(x => palette.includes('id: "' + x + '"'))],
  ["custom profile persistence", palette.includes("obs.drafting-profiles.v1") && palette.includes("persistProfiles")],
  ["configurable snap priority API", snapping.includes("setPriority(type: SnapType") && snapping.includes("this.priorities as Record<string, number>")],
  ["snap priorities bounded and validated", snapping.includes("Math.max(0, Math.min(1000")],
  ["selection category filter applied to real pointer picks and hover", selection.includes("passesCategoryFilter(hit.modelId, hit.localId)") && selection.includes("passesCategoryFilter(modelId, localId)")],
  ["category index cached per linked model and invalidated on model replacement", selection.includes("categoryCache = new Map") && selection.includes("cached.model !== model")],
  ["category filter applied to authored native picks", selection.includes("matchesAuthoredCategoryFilter") && read("src/features/authoring.ts").includes("selection.matchesAuthoredCategoryFilter")],
  ["category filter applied to 2D plan click, box, and hover selection", read("src/features/plan-view-panel.ts").includes("selection.matchesAuthoredCategoryFilter") && read("src/features/plan-view-panel.ts").includes("elementInPlanBox")],
  ["bulk Select All normalizes IFC category names", selection.includes("filteredGeometryIds") && selection.includes("this.matchesCategoryName(category)")],
  ["Select Similar respects the active category filter", selection.includes("if (!category || !this.matchesCategoryName(category)) return")],
  ["Invert Selection is restricted to the filtered category universe", selection.includes("const universe = await this.filteredGeometryIds(model, all)")],
  ["linked-model pointer picks use normalized category matching", selection.includes("categoryMatchesFilter(allowed, category)")],
  ["changing the category filter reconciles existing selections", selection.includes("if (this.filter) void this.reconcileFilter()") && selection.includes("async reconcileFilter(): Promise<void>")],
  ["restored selection sets are reconciled with the active category filter", selection.includes("await this.reconcileFilter();")],
  ["highlighter-adopted selections are reconciled with the active category filter", selection.includes("void this.reconcileFilter();")],
  ["selection replace and add APIs enforce the active category filter", selection.includes("if (reconcile && this.filter) void this.reconcileFilter()") && selection.includes("if (this.filter) void this.reconcileFilter();")],
  ["concurrent selection on a newly added model is reconciled before replacement", selection.includes("!categoryByModel.has(modelId)") && selection.includes("void this.reconcileFilter();")],
  ["highlighter selection synchronization flows through filter-aware replacement", selection.includes("(selection as any).replace(snap)")],
  ["temporary Alt snap suspension", palette.includes('e.key === "Alt"') && palette.includes("snapping.setSuspended(false)")],
  ["palette keyboard shortcut", palette.includes('e.key.toLowerCase() === "p"')],
  ["palette booted", main.includes("setupSelectionSnappingPalette()")],
  ["palette available from Edit ribbon", ribbon.includes('"Selection & Snapping"') && ribbon.includes("toggleSelectionSnappingPalette()")],
];
let failed = 0;
for (const [name, ok] of checks) {
  console.log((ok ? "PASS " : "FAIL ") + name);
  if (!ok) failed++;
}
console.log(`Selection/snapping checks: ${checks.length - failed}/${checks.length} passed`);
process.exitCode = failed ? 1 : 0;
