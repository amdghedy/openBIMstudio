/**
 * IFC link size limits suite.
 *
 * Pins the "link IFC up to 900 MB" contract: the in-browser conversion
 * ceiling (browserSafeMaxMB) defaults to 900 MB, the hard skip limit
 * (maxSizeMB) stays far above it, existing installs migrate off the old
 * 350/550 MB defaults, and every user-facing copy states the real number.
 * importer.ts pulls THREE/ctx into its import graph, so it cannot be
 * compiled standalone — wiring is pinned at source level (house pattern
 * from clash-scenarios / schedule-classification suites).
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const importer = read("src/features/importer.ts");
const pkg = JSON.parse(read("package.json"));
const ci = read("scripts/ci-unit-tests.mjs");

console.log("\nA. default limits — link IFC up to 900 MB in-browser");
test("A1 browserSafeMaxMB default is 900", () => {
  assert.ok(
    /maxSizeMB: 4000, browserSafeMaxMB: 900, allowUnsafeLargeIfc: true/.test(importer),
    "defaultIfcSettings carries browserSafeMaxMB: 900",
  );
});
test("A2 hard skip limit stays above the browser-safe ceiling", () => {
  const m = importer.match(/maxSizeMB: (\d+), browserSafeMaxMB: (\d+)/);
  assert.ok(m, "defaults line found");
  assert.ok(Number(m[1]) >= Number(m[2]), `hard limit ${m[1]} MB >= safe ceiling ${m[2]} MB`);
  assert.ok(Number(m[2]) >= 900, "safe ceiling covers 900 MB");
});
test("A3 docstring states the OOM caveat for the ceiling", () => {
  assert.ok(/Multi-hundred-MB IFCs may still OOM/.test(importer), "rationale documented");
});

console.log("\nB. migrations — existing installs inherit the raised ceiling");
test("B1 non-finite stored value → 900", () => {
  assert.ok(
    importer.includes("if (!Number.isFinite(ifcSettings.browserSafeMaxMB)) ifcSettings.browserSafeMaxMB = 900;"),
  );
});
test("B2 legacy ≤ 120 MB default migrates straight to 900", () => {
  const m = importer.match(
    /if \(ifcSettings\.browserSafeMaxMB > 0 && ifcSettings\.browserSafeMaxMB <= 120\) \{\s*\n\s*ifcSettings\.browserSafeMaxMB = 900;/,
  );
  assert.ok(m, "old-old default migrates to 900, not 350");
});
test("B3 old 350/550 MB defaults migrate to 900 (never-personalized fingerprints)", () => {
  assert.ok(
    importer.includes("if (ifcSettings.browserSafeMaxMB === 350 || ifcSettings.browserSafeMaxMB === 550) {") &&
      importer.includes("ifcSettings.browserSafeMaxMB = 900;"),
    "350/550 fingerprint migration present",
  );
});

console.log("\nC. user-facing copy and settings fallbacks state the real number");
test("C1 settings hint names 900 MB and the link capability", () => {
  assert.ok(importer.includes("Default 900 MB. Very large models may still need IFC→FRAG"), "hint text");
});
test("C2 settings render and input fallbacks use 900", () => {
  assert.ok(importer.includes('String(ifcSettings.browserSafeMaxMB ?? 900)'), "render fallback");
  assert.ok(importer.includes("Number(el.value) || 900"), "input fallback");
});

console.log("\nD. gates flow from settings — no hardcoded skip at 550");
test("D1 enqueueIfc hard gate reads ifcSettings.maxSizeMB", () => {
  assert.ok(importer.includes("if (sizeMB > ifcSettings.maxSizeMB) {"), "hard gate");
  assert.ok(importer.includes("if (sizeMB > ifcSettings.browserSafeMaxMB && !ifcSettings.allowUnsafeLargeIfc) {"), "safe gate");
});
test("D2 conversion budget scales and is bounded (900 MB gets a real budget)", () => {
  assert.ok(/30 min ceiling/.test(importer), "auto-scale ceiling documented");
  assert.ok(fs.existsSync(path.join(ROOT, "tests/import-timeout.test.cjs")), "timeout suite guards the bounds");
});

console.log("\nE. CI registration");
test("E1 suite registered in package.json and battery", () => {
  assert.ok(pkg.scripts["test:ifc-link-limits"] === "node tests/ifc-link-limits.test.cjs", "package.json script");
  assert.ok(ci.includes('"test:ifc-link-limits"'), "battery entry");
});

console.log(`\n all ${passed} assertions passed`);
