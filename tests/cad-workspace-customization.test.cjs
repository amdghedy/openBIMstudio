/** CAD professional workspace — Quick Access Toolbar customization guards. */
const fs = require("fs"); const path = require("path"); const assert = require("assert");
const src = fs.readFileSync(path.join(__dirname, "../src/features/cad-viewer.ts"), "utf8");
let pass = 0, fail = 0;
function test(name, fn) { try { fn(); pass++; console.log("  PASS " + name); } catch (error) { fail++; console.error("  FAIL " + name + ": " + error.message); } }
test("versioned preference key", () => assert.ok(src.includes('const CAD_QAT_PREF_KEY = "obs.cad.qat.hidden.v1";')));
for (const a of ["open", "save-dxf", "plot", "undo", "redo", "ext", "ai"]) assert.ok(src.includes(a + ":") || src.includes('"' + a + '":'), "missing action " + a);
test("visibility restored on shell creation", () => { assert.ok(src.includes("function applyCadQatPreferences(): void")); assert.ok(src.includes("button.hidden = hidden.has(button.dataset.qat ?? \"\" )") || src.includes('button.hidden = hidden.has(button.dataset.qat ?? "")')); assert.ok(src.includes("applyCadQatPreferences();")); });
test("right-click customization menu", () => { assert.ok(src.includes('qat?.addEventListener("contextmenu"')); assert.ok(src.includes('menu.setAttribute("role", "menu")')); assert.ok(src.includes('heading.textContent = "Quick Access Toolbar"')); });
test("preferences persist and defaults can be restored", () => { assert.ok(src.includes("localStorage.setItem(CAD_QAT_PREF_KEY")); assert.ok(src.includes('reset.textContent = "Restore default toolbar"')); assert.ok(src.includes("localStorage.removeItem(CAD_QAT_PREF_KEY)")); });
console.log("\nCAD workspace customization: " + pass + " passed, " + fail + " failed."); if (fail) process.exit(1);