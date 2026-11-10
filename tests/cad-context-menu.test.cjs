/**
 * Regression coverage for the standalone 2D CAD context menu wiring.
 * Behaviour is exercised by the CAD engine; these checks prevent the viewport
 * from silently reverting to browser context menus or layer-only visibility.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const source = fs.readFileSync(path.join(__dirname, "../src/features/cad-viewer.ts"), "utf8");
const contextMenuSource = fs.readFileSync(path.join(__dirname, "../src/features/context-menu.ts"), "utf8");
const checks = [
  ["entity-level temporary visibility is tracked", /const hiddenEntities = new Set<DxfEntity>\(\)/],
  ["entity visibility participates in rendering and picking", /!hiddenEntities\.has\(e\)/],
  ["selection can be hidden", /function hideCadSelection\(isolate: boolean\)/],
  ["isolation hides non-selected entities", /if \(!keep\.has\(entity\)\) hiddenEntities\.add\(entity\)/],
  ["show all restores layer and entity visibility", /function showAllCadObjects\(\): void[\s\S]*?hidden\.clear\(\); hiddenEntities\.clear\(\)/],
  ["zoom selected is available", /addItem\("Zoom to Selected",zoomSelection/],
  ["selection and editing actions are available", /Select Similar \(Type \+ Layer\)[\s\S]*?Erase Selected/],
  ["right-click opens CAD menu when idle", /if \(tool === "select"\) \{ showCadContextMenu\(ev\); return; \}/],
  ["3D viewport menu defers right-clicks inside the CAD editor", /\.obs-cad-viewer, \.obs-cad-shell/, contextMenuSource],
  ["cross-drawing clipboard operations are exposed", /Copy to Clipboard[\s\S]*?Paste at Original Coordinates/],
  ["active placement and modify operations retain right-click confirm", /if \(pick\) \{ ev\.preventDefault\(\); confirmPickStep\(\); return; \}[\s\S]*?if \(mod\) \{ ev\.preventDefault\(\); confirmModStep\(\); return; \}/],
];
let failed = 0;
for (const [label, pattern] of checks) {
  try { assert.match(source, pattern); console.log("  PASS " + label); }
  catch (error) { failed++; console.error("  FAIL " + label + ": " + error.message); }
}
console.log(`=== CAD context menu: ${checks.length - failed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
