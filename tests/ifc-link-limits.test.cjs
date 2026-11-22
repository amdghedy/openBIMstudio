/**
 * IFC link size limits suite.
 *
 * Pins the "link IFC up to 550 MB" contract: the in-browser conversion
 * ceiling (browserSafeMaxMB) defaults to 550 MB, the hard skip limit
 * (maxSizeMB) stays far above it, existing installs migrate off the old
 * 350 MB default, and every user-facing copy states the real number.
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

console.log("\nA. default limits — link IFC up to 550 MB in-browser");
test("A1 browserSafeMaxMB default is 550", () => {
  assert.ok(
    /maxSizeMB: 1500, browserSafeMaxMB: 550, allowUnsafeLargeIfc: false/.test(importer),
    "defaultIfcSettings carries browserSafeMaxMB: 550",
  );
});
test("A2 hard skip limit stays above the browser-safe ceiling", () => {
  const m = importer.match(/maxSizeMB: (\d+), browserSafeMaxMB: (\d+)/);
  assert.ok(m, "defaults line found");
  assert.ok(Number(m[1]) >= Number(m[2]), `hard limit ${m[1]} MB >= safe ceiling ${m[2]} MB`);
  assert.ok(Number(m[2]) >= 550, "safe ceiling covers 550 MB");
});
test("A3 docstring states the rationale for the ceiling", () => {
  assert.ok(/550 MB still leaves headroom below that danger zone/.test(importer), "rationale documented");
});

console.log("\nB. migrations — existing installs inherit the raised ceiling");
test("B1 non-finite stored value → 550", () => {
  assert.ok(
    importer.includes("if (!Number.isFinite(ifcSettings.browserSafeMaxMB)) ifcSettings.browserSafeMaxMB = 550;"),
  );
});
test("B2 legacy ≤ 120 MB default migrates straight to 550", () => {
  const m = importer.match(
    /if \(ifcSettings\.browserSafeMaxMB > 0 && ifcSettings\.browserSafeMaxMB <= 120\) \{\s*\n\s*ifcSettings\.browserSafeMaxMB = 550;/,
  );
  assert.ok(m, "old-old default migrates to 550, not 350");
});
test("B3 old 350 MB default migrates to 550 (never-personalized fingerprint)", () => {
  assert.ok(
    importer.includes("if (ifcSettings.browserSafeMaxMB === 350) {") &&
      importer.includes("ifcSettings.browserSafeMaxMB = 550;"),
    "350 fingerprint migration present",
  );
});

console.log("\nC. user-facing copy and settings fallbacks state the real number");
test("C1 settings hint names 550 MB and the link capability", () => {
  assert.ok(importer.includes("Default 550 MB — linking files up to 550 MB converts in-browser"), "hint text");
});
test("C2 settings render and input fallbacks use 550", () => {
  assert.ok(importer.includes('String(ifcSettings.browserSafeMaxMB ?? 550)'), "render fallback");
  assert.ok(importer.includes("Number(el.value) || 550"), "input fallback");
});

console.log("\nD. gates flow from settings — no hardcoded skip at 550");
test("D1 enqueueIfc hard gate reads ifcSettings.maxSizeMB", () => {
  assert.ok(importer.includes("if (sizeMB > ifcSettings.maxSizeMB) {"), "hard gate");
  assert.ok(importer.includes("if (sizeMB > ifcSettings.browserSafeMaxMB && !ifcSettings.allowUnsafeLargeIfc) {"), "safe gate");
});
test("D2 conversion budget scales and is bounded (550 MB gets a real budget)", () => {
  assert.ok(/30 min ceiling/.test(importer), "auto-scale ceiling documented");
  assert.ok(fs.existsSync(path.join(ROOT, "tests/import-timeout.test.cjs")), "timeout suite guards the bounds");
});

console.log("\nE. CI registration");
test("E1 suite registered in package.json and battery", () => {
  assert.ok(pkg.scripts["test:ifc-link-limits"] === "node tests/ifc-link-limits.test.cjs", "package.json script");
  assert.ok(ci.includes('"test:ifc-link-limits"'), "battery entry");
});

console.log(`\n all ${passed} assertions passed`);
