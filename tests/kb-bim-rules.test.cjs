const assert = require("node:assert/strict");
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-kb-bim-rules-"));
try {
  const files = ["csd-packing.ts", "kb-csd-rules.ts"].map(name => path.join(root, "src/modules/mep", name));
  execSync("npx tsc " + files.map(f => "\"" + f + "\"").join(" ") + " --outDir \"" + out + "\" --rootDir \"" + path.join(root, "src/modules/mep") + "\" --module commonjs --target es2020 --strict --skipLibCheck", { cwd: root, stdio: "pipe" });
  const { compileKbCsdRules, validateKbCsdRuleProfile } = require(path.join(out, "kb-csd-rules.js"));
  const { optimizeCsdPacking } = require(path.join(out, "csd-packing.js"));
  let pass = 0;
  const test = (name, fn) => { fn(); pass++; console.log("PASS " + name); };
  const approved = (id, extra = {}) => ({ id, title: id, approval: "approved", approvedBy: "BIM Lead", approvedAt: "2026-01-01",
    source: { kind: "project-specification", documentId: "MEP-STD-001", clause: "5.2", revision: "A" }, ...extra });
  const profile = rules => ({ schemaVersion: 1, id: "project-csd", name: "Project CSD Rules", revision: "03", jurisdiction: "project-defined", rules });
  const items = [
    { id: "duct-1", system: "supply-air", width: 0.8, height: 0.4 },
    { id: "pipe-1", system: "chilled-water", width: 0.15, height: 0.15 },
    { id: "tray-1", system: "cable-tray", width: 0.3, height: 0.1 },
  ];
  const compile = (rules, overrides = {}) => compileKbCsdRules({
    profile: profile(rules), context: { discipline: "MEP", effectiveDate: "2026-06-01" },
    boundary: { width: 5, height: 3 }, items: structuredClone(items), ...overrides
  });

  test("applies pair-specific clearances without inflating unrelated systems", () => {
    const r = compile([approved("pair-gap", { kind: "pair-clearance", systems: ["supply-air", "chilled-water"], value: 0.25 })]);
    assert.equal(r.valid, true);
    assert.equal(r.items[0].pairClearances["pipe-1"], 0.25);
    assert.equal(r.items[1].pairClearances["duct-1"], 0.25);
    assert.equal(r.items[0].clearance, undefined);
    assert.equal(r.items[2].pairClearances["duct-1"], undefined);
    assert.deepEqual(r.appliedRuleIds, ["pair-gap"]);
  });

  test("applies edge clearance, priority and preferred side", () => {
    const r = compile([
      approved("edge", { kind: "edge-clearance", system: "supply-air", value: 0.12 }),
      approved("priority", { kind: "system-priority", system: "supply-air", priority: 9 }),
      approved("side", { kind: "preferred-side", system: "supply-air", side: "top", strength: 1 }),
    ]);
    assert.equal(r.items[0].edgeClearance, 0.12);
    assert.equal(r.items[0].priority, 9);
    assert.equal(r.items[0].preferred.y, 3 - 0.12 - 0.4);
    assert.equal(r.items[1].edgeClearance, undefined);
  });

  test("compiles service order into hard solver relationships", () => {
    const r = compile([approved("order", { kind: "service-order", upperSystem: "supply-air", lowerSystem: "chilled-water", gap: 0.18 })]);
    assert.deepEqual(r.relationships, [{ kind: "above", fromId: "duct-1", toId: "pipe-1", gap: 0.18 }]);
  });

  test("blocks systems prohibited by the active discipline profile", () => {
    const r = compile([approved("discipline", { kind: "discipline-restriction", discipline: "MEP", allowedSystems: ["supply-air", "chilled-water"] })]);
    assert.deepEqual(r.blockedItemIds, ["tray-1"]);
    assert.equal(r.valid, true);
    assert.ok(r.diagnostics.some(d => d.code === "DISCIPLINE_SYSTEM_BLOCKED" && d.severity === "error"));
  });

  test("does not apply draft or not-yet-effective rules", () => {
    const r = compile([
      { id: "draft", title: "Draft", approval: "draft", source: { kind: "project-specification", documentId: "D", clause: "1" },
        kind: "edge-clearance", system: "supply-air", value: 0.4 },
      approved("future", { kind: "edge-clearance", system: "supply-air", value: 0.5, effectiveFrom: "2027-01-01" }),
    ]);
    assert.equal(r.items[0].edgeClearance, undefined);
    assert.deepEqual(r.appliedRuleIds, []);
    assert.ok(r.diagnostics.some(d => d.code === "RULE_DRAFT_IGNORED"));
    assert.ok(r.diagnostics.some(d => d.code === "RULE_OUT_OF_DATE"));
  });

  test("rejects missing provenance and incomplete approval audit", () => {
    const r = profile([{
      id: "bad", title: "Untraceable", approval: "approved", approvedBy: "", approvedAt: "yesterday",
      source: { kind: "project-specification", documentId: "", clause: "" },
      kind: "edge-clearance", system: "supply-air", value: 0.2
    }]);
    const errors = validateKbCsdRuleProfile(r);
    assert.equal(errors.some(d => d.code === "RULE_PROVENANCE_MISSING"), true);
    assert.equal(errors.some(d => d.code === "RULE_APPROVAL_AUDIT_MISSING"), true);
    assert.equal(compileKbCsdRules({ profile: r, context: { discipline: "MEP", effectiveDate: "2026-06-01" },
      boundary: { width: 5, height: 3 }, items }).valid, false);
  });

  test("uses the maximum of duplicate clearance requirements", () => {
    const r = compile([
      approved("gap-a", { kind: "pair-clearance", systems: ["supply-air", "chilled-water"], value: 0.15 }),
      approved("gap-b", { kind: "pair-clearance", systems: ["chilled-water", "supply-air"], value: 0.3 }),
    ]);
    assert.equal(r.items[0].pairClearances["pipe-1"], 0.3);
    assert.equal(r.items[1].pairClearances["duct-1"], 0.3);
    assert.deepEqual(r.appliedRuleIds, ["gap-a", "gap-b"]);
  });

  test("requires a valid context and rejects unsupported schema versions", () => {
    const base = { profile: profile([]), context: { discipline: "", effectiveDate: "2026-02-30" },
      boundary: { width: 5, height: 3 }, items };
    const r = compileKbCsdRules(base);
    assert.equal(r.valid, false);
    assert.ok(r.diagnostics.some(d => d.code === "COMPILATION_CONTEXT_INVALID"));
    assert.ok(validateKbCsdRuleProfile({ ...profile([]), schemaVersion: 2 }).some(d => d.code === "PROFILE_SCHEMA_UNSUPPORTED"));
  });

  test("fixed placements remain authoritative over preferences", () => {
    const fixedItems = [{ id: "duct-1", system: "supply-air", width: 0.8, height: 0.4, fixed: { x: 1, y: 1 } }];
    const r = compile([approved("side", { kind: "preferred-side", system: "supply-air", side: "top", strength: 1 })],
      { items: fixedItems });
    assert.deepEqual(r.items[0].fixed, { x: 1, y: 1 });
    assert.equal(r.items[0].preferred, undefined);
    assert.ok(r.diagnostics.some(d => d.code === "PREFERENCE_OVERRIDDEN_BY_FIXED_POSITION"));
  });

  test("pair-specific clearances are enforced by the CSD solver", () => {
    const compiled = compile([approved("pair-gap", { kind: "pair-clearance", systems: ["supply-air", "chilled-water"], value: 0.2 })],
      { items: [
        { id: "duct-1", system: "supply-air", width: 0.5, height: 0.5, fixed: { x: 0, y: 0 } },
        { id: "pipe-1", system: "chilled-water", width: 0.5, height: 0.5, fixed: { x: 0.6, y: 0 } },
      ] });
    const solved = optimizeCsdPacking({ boundary: { width: 2, height: 1 }, items: compiled.items });
    assert.equal(solved.status, "infeasible");
  });

  test("resolves preferred-side conflicts by strength and supports negative priority", () => {
    const r = compile([
      approved("side-low", { kind: "preferred-side", system: "supply-air", side: "bottom", strength: 1 }),
      approved("side-high", { kind: "preferred-side", system: "supply-air", side: "top", strength: 10 }),
      approved("priority-low", { kind: "system-priority", system: "supply-air", priority: -2 }),
    ]);
    assert.equal(r.items[0].preferred.y, 3 - 0.4);
    assert.equal(r.items[0].priority, -2);
    assert.ok(r.diagnostics.some(d => d.code === "PREFERRED_SIDE_CONFLICT"));
  });

  console.log("KB-BIM rule engine: " + pass + " tests passed");
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
