const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-kb-bim-csd-"));
try {
  const source = path.join(root, "src/modules/mep/csd-packing.ts");
  execSync("npx tsc \"" + source + "\" --outDir \"" + out + "\" --module commonjs --target es2020 --strict --skipLibCheck", { cwd: root, stdio: "pipe" });
  const { optimizeCsdPacking } = require(path.join(out, "csd-packing.js"));
  let pass = 0;
  const test = (name, fn) => { fn(); pass++; console.log("PASS " + name); };

  test("generates and ranks deterministic candidate placements", () => {
    const request = { boundary: { width: 1, height: 1 }, items: [
      { id: "duct-main", system: "supply-air", width: 0.2, height: 0.2, preferred: { x: 0.4, y: 0.4 } },
    ], options: { gridSize: 0.4, maxNodes: 100, maxCandidatesPerItem: 100, maxSolutions: 5 } };
    const a = optimizeCsdPacking(request), b = optimizeCsdPacking(request);
    assert.ok(a.candidates.length > 1);
    assert.equal(a.status, "solved");
    assert.deepEqual(a.candidates, b.candidates);
    assert.ok(a.candidates.every(c => c.compliant && c.placements.length === 1));
    assert.ok(a.candidates.every((c, i, all) => i === 0 || all[i - 1].metrics.score <= c.metrics.score));
    assert.equal(a.candidates[0].placements[0].x, 0.4);
    assert.equal(a.candidates[0].placements[0].y, 0.4);
  });

  test("enforces pair and section-edge clearances", () => {
    const r = optimizeCsdPacking({ boundary: { width: 2, height: 1 }, items: [
      { id: "a", system: "duct", width: 0.5, height: 0.5, clearance: 0.2, edgeClearance: 0.1, fixed: { x: 0.1, y: 0.1 } },
      { id: "b", system: "pipe", width: 0.5, height: 0.5, clearance: 0.2, edgeClearance: 0.1, fixed: { x: 0.8, y: 0.1 } },
    ] });
    assert.equal(r.status, "solved");
  });

  test("rejects fixed arrangements that violate clearance", () => {
    const r = optimizeCsdPacking({ boundary: { width: 2, height: 1 }, items: [
      { id: "a", system: "duct", width: 0.5, height: 0.5, clearance: 0.2, fixed: { x: 0, y: 0 } },
      { id: "b", system: "pipe", width: 0.5, height: 0.5, clearance: 0.2, fixed: { x: 0.55, y: 0 } },
    ] });
    assert.equal(r.status, "infeasible");
    assert.equal(r.candidates.length, 0);
  });

  test("enforces above/below engineering relationships", () => {
    const r = optimizeCsdPacking({ boundary: { width: 3, height: 2 }, items: [
      { id: "duct", system: "supply-air", width: 1, height: 0.4, preferred: { x: 0, y: 0 } },
      { id: "pipe", system: "chilled-water", width: 0.3, height: 0.2, preferred: { x: 0, y: 0 } },
    ], relationships: [{ kind: "above", fromId: "duct", toId: "pipe", gap: 0.15 }],
    options: { gridSize: 0.25, maxNodes: 10000, maxCandidatesPerItem: 500 } });
    assert.ok(r.candidates.length > 0);
    const m = new Map(r.candidates[0].placements.map(p => [p.id, p]));
    assert.ok(m.get("duct").y >= m.get("pipe").y + m.get("pipe").height + 0.15 - 1e-9);
  });

  test("rotates only explicitly rotatable services", () => {
    const r = optimizeCsdPacking({ boundary: { width: 1, height: 2 },
      items: [{ id: "tray", system: "cable-tray", width: 1.5, height: 0.5, rotatable: true }],
      options: { allowRotation: true } });
    assert.ok(r.candidates.length > 0);
    assert.equal(r.candidates[0].placements[0].rotated, true);
    const no = optimizeCsdPacking({ boundary: { width: 1, height: 2 },
      items: [{ id: "tray", system: "cable-tray", width: 1.5, height: 0.5, rotatable: false }] });
    assert.equal(no.status, "infeasible");
  });

  test("reports bounded search honestly as partial", () => {
    const r = optimizeCsdPacking({ boundary: { width: 8, height: 4 },
      items: Array.from({ length: 5 }, (_, i) => ({ id: "i" + i, system: "pipe", width: 0.5, height: 0.25 })),
      options: { gridSize: 0.05, maxNodes: 2, maxCandidatesPerItem: 1000 } });
    assert.equal(r.status, "partial");
    assert.equal(r.searchComplete, false);
    assert.ok(r.diagnostics.some(x => /node limit/.test(x)));
  });

  test("validates duplicate IDs and missing relationship references", () => {
    const duplicate = optimizeCsdPacking({ boundary: { width: 2, height: 2 }, items: [
      { id: "same", system: "pipe", width: 0.2, height: 0.2 },
      { id: "same", system: "duct", width: 0.2, height: 0.2 },
    ] });
    assert.equal(duplicate.status, "invalid-input");
    const missing = optimizeCsdPacking({ boundary: { width: 2, height: 2 },
      items: [{ id: "a", system: "pipe", width: 0.2, height: 0.2 }],
      relationships: [{ kind: "above", fromId: "a", toId: "missing" }] });
    assert.equal(missing.status, "invalid-input");
  });

  test("honours non-grid edge clearances", () => {
    const r = optimizeCsdPacking({ boundary: { width: 1, height: 1 },
      items: [{ id: "edge-item", system: "pipe", width: 0.5, height: 0.5, edgeClearance: 0.13 }],
      options: { gridSize: 0.2, maxNodes: 1000, maxCandidatesPerItem: 100 } });
    assert.ok(r.candidates.length > 0);
    const p = r.candidates[0].placements[0];
    assert.ok(p.x >= 0.13 - 1e-9 && p.y >= 0.13 - 1e-9);
    assert.ok(p.x + p.width <= 0.87 + 1e-9 && p.y + p.height <= 0.87 + 1e-9);
  });

  test("returns an explicit empty solution for empty sections", () => {
    const r = optimizeCsdPacking({ boundary: { width: 2, height: 2 }, items: [] });
    assert.equal(r.status, "solved");
    assert.equal(r.candidates[0].placements.length, 0);
  });
  console.log("KB-BIM CSD packing: " + pass + " tests passed");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
