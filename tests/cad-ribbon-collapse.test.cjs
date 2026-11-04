// CAD editor: double-click a ribbon tab collapses the ribbon; full screen hides the command bars.
// The gesture decision itself is shared with the main shell (tests/ribbon-collapse.test.cjs).
const assert = require("assert");
const fs = require("fs");
const src = fs.readFileSync("src/features/cad-viewer.ts", "utf8");
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

t("tab row handles dblclick through the shared resolveDblClick logic", () => {
  assert.ok(/from "..\/shell\/ribbon-collapse"/.test(src));
  assert.ok(/ribbonTabsRow\.addEventListener\("dblclick"/.test(src));
  assert.ok(/resolveDblClick\(\{ minimized: ribbonMinimized/.test(src));
});
t("only a tab or the empty tab row collapses (not the A menu / quick access buttons)", () => {
  assert.ok(/if \(!onTab && target !== ribbonTabsRow\) return;/.test(src));
});
t("single click on a tab while collapsed re-opens the ribbon and starts the grace window", () => {
  assert.ok(/if \(ribbonMinimized\) \{[\s\S]{0,200}ribbonLastAutoExpandAt = Date\.now\(\);[\s\S]{0,60}applyCadRibbonMinimized\(false\)/.test(src));
});
t("collapsed state is persisted and the canvas is told to refit", () => {
  assert.ok(/obs\.cad\.ribbon\.min/.test(src));
  assert.ok(/applyCadRibbonMinimized[\s\S]{0,300}dispatchEvent\(new Event\("resize"\)\)/.test(src));
});
t("CSS hides the strip when minimized", () => {
  assert.ok(/\.obs-cad-shell\.cad-ribbon--min \.cadrb-strip\{display:none\}/.test(src));
});
t("full screen hides side panel, command line, status bar and layout tabs, with a show/hide chip", () => {
  for (const sel of [".side", ".obs-cad-cmd-container", "[data-r=status]", "[data-r=tabs]"]) assert.ok(src.includes(`.obs-cad-viewer.obs-cad-fs:not(.obs-cad-fs--peek) ${sel}`), sel);
  assert.ok(/fullscreenchange/.test(src) && /obs-cad-fs-chip/.test(src));
});
t("main app full screen also hides the options bar", () => {
  assert.ok(/body\.obs-fullscreen #obs-options-bar/.test(fs.readFileSync("src/style.css", "utf8")));
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
