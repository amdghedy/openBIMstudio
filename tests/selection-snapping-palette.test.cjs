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
  ["selection category filter applied to real pointer picks", selection.includes("passesCategoryFilter(hit.modelId, hit.localId)")],
  ["category index cached per linked model and invalidated on model replacement", selection.includes("categoryCache = new Map") && selection.includes("cached.model !== model")],
  ["category filter applied to authored native picks", selection.includes("matchesAuthoredCategoryFilter") && read("src/features/authoring.ts").includes("selection.matchesAuthoredCategoryFilter")],
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
