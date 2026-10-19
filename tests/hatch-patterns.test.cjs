/**
 * tests/hatch-patterns.test.cjs
 *
 * Unit tests for the hatch pattern library + line/dot generation.
 *
 * Compile strategy: write a minimal tsconfig that includes only the pure
 * hatch-patterns.ts file (no DOM/three.js deps).
 *
 * Run: `node tests/hatch-patterns.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let pass = 0;
let fail = 0;

function t(name, fn) {
  try {
    fn();
    console.log(`  PASS ${name}`);
    pass++;
  } catch (e) {
    console.error(`  FAIL ${name}`);
    console.error(`    ${e.message}`);
    fail++;
  }
}

function near(a, b, tol = 0.001) {
  if (Math.abs(a - b) > tol) {
    throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

const repoRoot = path.resolve(__dirname, "..");
const tmpOut = path.join(os.tmpdir(), "obs-hatch-test-" + Date.now());

try {
  fs.mkdirSync(tmpOut, { recursive: true });

  const tsconfigPath = path.join(tmpOut, "tsconfig-hatch.json");
  fs.writeFileSync(tsconfigPath, JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "commonjs",
      moduleResolution: "node",
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      outDir: tmpOut,
      rootDir: path.join(repoRoot, "src"),
    },
    include: [
      path.join(repoRoot, "src/modules/views/hatch-patterns.ts"),
    ],
  }, null, 2));

  execSync(`npx tsc -p "${tsconfigPath}"`, { cwd: repoRoot, stdio: "pipe" });

  const hatch = require(path.join(tmpOut, "modules/views/hatch-patterns.js"));

  console.log("\n=== Hatch Patterns tests ===\n");

  // ─── Pattern library ──────────────────────────────────────────────────

  console.log("Pattern library:");

  t("library exposes 9 named patterns", () => {
    const ids = hatch.listPatterns();
    assert(ids.length === 9, `expected 9 patterns, got ${ids.length}: ${ids.join(", ")}`);
    assert(ids.includes("concrete"), "expected 'concrete' in library");
    assert(ids.includes("brick"), "expected 'brick' in library");
    assert(ids.includes("earth"), "expected 'earth' in library");
    assert(ids.includes("steel"), "expected 'steel' in library");
    assert(ids.includes("wood"), "expected 'wood' in library");
    assert(ids.includes("insulation"), "expected 'insulation' in library");
    assert(ids.includes("sand"), "expected 'sand' in library");
    assert(ids.includes("glass"), "expected 'glass' in library");
    assert(ids.includes("poche"), "expected 'poche' in library");
  });

  t("getPattern returns definition for known patterns", () => {
    const p = hatch.getPattern("concrete");
    assert(p !== null, "expected non-null pattern");
    assert(p.id === "concrete", "expected id=concrete");
    assert(p.name === "Concrete", "expected name=Concrete");
    assert(Array.isArray(p.tile), "expected tile array");
    assert(p.tile.length === 2, "expected tile to be [w, h]");
    assert(p.segments.length > 0, "expected non-empty segments");
    assert(typeof p.strokeWidth === "number", "expected numeric strokeWidth");
  });

  t("getPattern returns null for unknown pattern", () => {
    assert(hatch.getPattern("nonexistent") === null, "expected null for unknown pattern");
  });

  t("poche pattern has empty segments (solid fill)", () => {
    const p = hatch.getPattern("poche");
    assert(p.segments.length === 0, "expected empty segments for poche");
    assert(!p.dots, "expected no dots for poche");
  });

  t("concrete pattern has cross-hatch (two diagonals)", () => {
    const p = hatch.getPattern("concrete");
    assert(p.segments.length === 2, `expected 2 segments, got ${p.segments.length}`);
    // First segment should go from (0,0) to (8,8) - 45 deg
    // Second segment should go from (0,8) to (8,0) - -45 deg
    assert(p.segments[0][0] === 0 && p.segments[0][3] === 8, "expected first diagonal");
    assert(p.segments[1][1] === 8 && p.segments[1][2] === 8, "expected second diagonal");
  });

  t("sand pattern has dots but no segments", () => {
    const p = hatch.getPattern("sand");
    assert(p.segments.length === 0, "expected empty segments for sand");
    assert(p.dots && p.dots.length > 0, "expected dots for sand");
  });

  // ─── Line generation ──────────────────────────────────────────────────

  console.log("\nLine generation:");

  t("generateHatchLines returns empty for unknown pattern", () => {
    const lines = hatch.generateHatchLines("nonexistent", [[0, 0], [10, 0], [10, 10], [0, 10]], 100);
    assert(lines.length === 0, "expected 0 lines for unknown pattern");
  });

  t("generateHatchLines returns empty for poche pattern (no segments)", () => {
    const lines = hatch.generateHatchLines("poche", [[0, 0], [10, 0], [10, 10], [0, 10]], 100);
    assert(lines.length === 0, "expected 0 lines for poche (solid fill)");
  });

  t("generateHatchLines produces lines within (or near) the bounding box", () => {
    // Square polygon 10x10 m, concrete pattern (8mm tile), scale 1:100
    // -> tile is 8mm * 0.001 * 100 = 0.8 m
    const polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const lines = hatch.generateHatchLines("concrete", polygon, 100);
    assert(lines.length > 0, "expected non-zero lines");
    // Each line should fit within the polygon bounding box + one tile of slack
    // (because we tile the bbox, not the polygon itself - the renderer clips per-polygon).
    const slack = 2.0; // 2 m slack = up to 2.5 tiles of overshoot (tile is 0.8 m at scale 100)
    for (const l of lines) {
      assert(l.x0 >= 0 - slack && l.x0 <= 10 + slack, `x0=${l.x0} out of bounds`);
      assert(l.x1 >= 0 - slack && l.x1 <= 10 + slack, `x1=${l.x1} out of bounds`);
      assert(l.y0 >= 0 - slack && l.y0 <= 10 + slack, `y0=${l.y0} out of bounds`);
      assert(l.y1 >= 0 - slack && l.y1 <= 10 + slack, `y1=${l.y1} out of bounds`);
    }
  });

  t("generateHatchLines scales tile with scale factor", () => {
    const polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const lines100 = hatch.generateHatchLines("concrete", polygon, 100);
    const lines200 = hatch.generateHatchLines("concrete", polygon, 200);
    // At scale 200 (1:200), tile is 2x larger (1.6 m), so fewer tiles fit
    // -> fewer lines.
    assert(lines100.length > lines200.length, `expected more lines at scale 100 (${lines100.length}) than 200 (${lines200.length})`);
  });

  // ─── Dot generation ───────────────────────────────────────────────────

  console.log("\nDot generation:");

  t("generateHatchDots returns empty for patterns without dots", () => {
    const polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const dots = hatch.generateHatchDots("concrete", polygon, 100);
    assert(dots.length === 0, "expected 0 dots for concrete pattern");
  });

  t("generateHatchDots produces dots for sand pattern", () => {
    const polygon = [[0, 0], [10, 0], [10, 10], [0, 10]];
    const dots = hatch.generateHatchDots("sand", polygon, 100);
    assert(dots.length > 0, "expected non-zero dots for sand");
    for (const d of dots) {
      assert(typeof d.x === "number", "expected numeric x");
      assert(typeof d.y === "number", "expected numeric y");
      assert(typeof d.radius === "number", "expected numeric radius");
      assert(d.radius > 0, "expected positive radius");
    }
  });

  // ─── Element-to-pattern mapping ──────────────────────────────────────

  console.log("\nElement-to-pattern mapping:");

  t("defaultPatternForElementType returns expected patterns", () => {
    assert(hatch.defaultPatternForElementType("wall") === "poche", "expected poche for wall");
    assert(hatch.defaultPatternForElementType("column") === "concrete", "expected concrete for column");
    assert(hatch.defaultPatternForElementType("beam") === "steel", "expected steel for beam");
    assert(hatch.defaultPatternForElementType("curtain-wall") === "glass", "expected glass for curtain-wall");
  });

  t("defaultPatternForElementType falls back to poche for unknown types", () => {
    assert(hatch.defaultPatternForElementType("nonexistent") === "poche", "expected poche fallback");
  });

  console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
  process.exitCode = fail > 0 ? 1 : 0;

} catch (e) {
  console.error("Test setup failed:", e.message);
  console.error(e.stack);
  process.exitCode = 2;
} finally {
  try {
    fs.rmSync(tmpOut, { recursive: true, force: true });
  } catch { /* */ }
}
