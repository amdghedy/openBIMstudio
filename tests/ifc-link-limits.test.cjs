/**
 * IFC link size limits suite.
 *
 * Pins the "link IFC up to 2.3 GB / IFCZIP up to 700 MB" contract: the
 * in-browser conversion ceiling (browserSafeMaxMB) defaults to 2300 MB, the
 * hard acceptance bound (maxSizeMB 4000 MB) and the file-guard ceilings
 * (4096 MiB) sit above it so the guard is never the layer that rejects what
 * the importer queues, the ZIP audit accepts a ~2.3 GB entry expanded from a
 * 700 MB IFCZIP, the conversion total-timeout cap (120 min) outlives a
 * legitimate 2.3 GB conversion at the measured rate (~38 min), and existing
 * installs migrate off every previous default (120 / 350 / 550 / 900 MB safe).
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
const guard = read("src/core/file-guard.ts");
const pkg = JSON.parse(read("package.json"));
const ci = read("scripts/ci-unit-tests.mjs");

console.log("\nA. default limits — link IFC up to 2.3 GB / IFCZIP up to 700 MB in-browser");
test("A1 browserSafeMaxMB default is 2300 (acceptance bound stays 4000)", () => {
  assert.ok(
    /maxSizeMB: 4000, browserSafeMaxMB: 2300, allowUnsafeLargeIfc: true/.test(importer),
    "defaultIfcSettings carries browserSafeMaxMB: 2300 / maxSizeMB: 4000",
  );
});
test("A2 hard acceptance bound stays above the browser-safe ceiling, which covers 2.3 GB", () => {
  const m = importer.match(/maxSizeMB: (\d+), browserSafeMaxMB: (\d+)/);
  assert.ok(m, "defaults line found");
  assert.ok(Number(m[1]) >= Number(m[2]), `hard limit ${m[1]} MB >= safe ceiling ${m[2]} MB`);
  assert.ok(Number(m[2]) >= 2300, "safe ceiling covers 2.3 GB");
});
test("A3 docstring states the contract and the honest attempt-bound caveat", () => {
  assert.ok(/link IFC up to 2\.3 GB \/ IFCZIP up to 700 MB/.test(importer), "2.3 GB contract documented");
  assert.ok(/Multi-hundred-MB IFCs may still OOM/.test(importer), "OOM caveat documented");
  assert.ok(/the ceiling is the attempt bound, not a success promise/.test(importer), "honest framing documented");
});

console.log("\nB. migrations — existing installs inherit the raised ceiling");
test("B1 non-finite stored value → 2300", () => {
  assert.ok(
    importer.includes("if (!Number.isFinite(ifcSettings.browserSafeMaxMB)) ifcSettings.browserSafeMaxMB = 2300;"),
  );
});
test("B2 legacy ≤ 120 MB default migrates to 2300", () => {
  const m = importer.match(
    /if \(ifcSettings\.browserSafeMaxMB > 0 && ifcSettings\.browserSafeMaxMB <= 120\) \{\s*\n\s*ifcSettings\.browserSafeMaxMB = 2300;/,
  );
  assert.ok(m, "old-old default migrates straight to 2300");
});
test("B3 old 350/550 MB defaults migrate to 2300 (never-personalized fingerprints)", () => {
  const m = importer.match(
    /if \(ifcSettings\.browserSafeMaxMB === 350 \|\| ifcSettings\.browserSafeMaxMB === 550\) \{\s*\n\s*ifcSettings\.browserSafeMaxMB = 2300;/,
  );
  assert.ok(m, "350/550 fingerprint migration present");
});
test("B4 previous 900 MB default migrates to 2300 (never-personalized fingerprint)", () => {
  const m = importer.match(
    /if \(ifcSettings\.browserSafeMaxMB === 900\) \{\s*\n\s*ifcSettings\.browserSafeMaxMB = 2300;/,
  );
  assert.ok(m, "900 fingerprint migration present");
});
test("B5 conservative hard bounds migrate up to the 4000 MB acceptance bound", () => {
  assert.ok(
    importer.includes("if (!Number.isFinite(ifcSettings.maxSizeMB) || ifcSettings.maxSizeMB < 1500) {") &&
      importer.includes("ifcSettings.maxSizeMB = 4000;"),
    "old hard bounds follow the raised acceptance bound",
  );
});

console.log("\nC. user-facing copy and settings fallbacks state the real numbers");
test("C1 settings hint names 2.3 GB IFC, 700 MB IFCZIP and the honest OOM caveat", () => {
  assert.ok(importer.includes("Default 2300 MB — linking IFC up to 2.3 GB and IFCZIP up to 700 MB converts in-browser"), "hint text");
  assert.ok(importer.includes("conversion above ~700 MB risks running out of memory (tab crash)"), "honest caveat in copy");
});
test("C2 settings render and input fallbacks use the new defaults", () => {
  assert.ok(importer.includes('String(ifcSettings.browserSafeMaxMB ?? 2300)'), "render fallback");
  assert.ok(importer.includes("Number(el.value) || 2300"), "safe input fallback");
  assert.ok(importer.includes("Number(el.value) || 4000"), "hard input fallback");
});

console.log("\nD. gates, guards and timeout all carry the raised numbers");
test("D1 enqueueIfc hard gate reads ifcSettings.maxSizeMB", () => {
  assert.ok(importer.includes("if (sizeMB > ifcSettings.maxSizeMB) {"), "hard gate");
  assert.ok(importer.includes("if (sizeMB > ifcSettings.browserSafeMaxMB && !ifcSettings.allowUnsafeLargeIfc) {"), "safe gate");
});
test("D2 >200 MB high-risk warning fires on the default path (no allowUnsafe dependency)", () => {
  assert.ok(
    importer.includes("if (!fragBytes && t.sizeMB > 200) {"),
    "large conversions are honestly flagged without requiring the unsafe flag",
  );
  assert.ok(
    !/t\.sizeMB > 200 && ifcSettings\.allowUnsafeLargeIfc/.test(importer),
    "old flag-gated warning removed",
  );
});
test("D3 conversion budget survives a legitimate 2.3 GB conversion", () => {
  const timeout = read("src/modules/ifc-semantics/import-timeout.ts");
  assert.ok(timeout.includes("export const IFC_IMPORT_TOTAL_CAP_MS_DEFAULT = 7_200_000;"), "120 min cap");
  assert.ok(/120 min ceiling/.test(importer), "auto-scale ceiling documented in the importer");
  assert.ok(fs.existsSync(path.join(ROOT, "tests/import-timeout.test.cjs")), "timeout suite guards the bounds");
});
test("D4 file-guard ceilings raised so the guard never blocks the link contract", () => {
  for (const kind of ["ifc", "frag", "obsproj"]) {
    const m = guard.match(new RegExp(`${kind}: (\\d+) \\* MiB`));
    assert.ok(m, `${kind} limit found`);
    assert.ok(Number(m[1]) >= 2300, `${kind} guard ${m[1]} MiB >= 2300 MiB`);
  }
  assert.ok(/maxEntryBytes: 4095 \* MiB/.test(guard), "ZIP audit accepts a ~2.3 GB expanded IFCZIP entry (bound stays enforceable under the ZIP32 field ceiling)");
  assert.ok(/maxTotalBytes: 4096 \* MiB/.test(guard), "ZIP total bound matches the per-entry bound");
});
test("D5 IFCZIP expanded-payload gate reads browserSafeMaxMB", () => {
  assert.ok(importer.includes("if (totalMb > ifcSettings.browserSafeMaxMB) {"), "zip payload gate");
});

console.log("\nE. CI registration");
test("E1 suite registered in package.json and battery", () => {
  assert.ok(pkg.scripts["test:ifc-link-limits"] === "node tests/ifc-link-limits.test.cjs", "package.json script");
  assert.ok(ci.includes('"test:ifc-link-limits"'), "battery entry");
});

console.log(`\n all ${passed} assertions passed`);
