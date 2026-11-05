// Source-level guard: door/window tools get an options bar and the placement code honours it.
const fs = require("fs"), assert = require("assert");
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const po = fs.readFileSync("src/features/place-options.ts", "utf8");
const au = fs.readFileSync("src/features/authoring.ts", "utf8");
t("door and window are Place tools", () => assert.ok(/PLACE_TOOLS = new Set\([^)]*"door", "window"\]/.test(po)));
t("options bar edits width, height and sill height", () => { for (const k of ['dim("width"', 'dim("height"', 'dim("sillHeight"']) assert.ok(po.includes(k), k); });
t("placement and preview read the type defaults", () => assert.strictEqual((au.match(/\.\.\.getTypeDefaults\(activeTool\)\.params/g) || []).length, 2));
t("sill height comes from the options, with the old defaults as fallback", () => assert.strictEqual((au.match(/sillHeight: d\.sillHeight \?\? \(activeTool === "window" \? 0\.9 : 0\)/g) || []).length, 2));
console.log(`=== Result: ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
