const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "modify-registry-"));
execFileSync("npx", ["tsc", "src/modules/modify/registry.ts", "--outDir", out, "--module", "commonjs", "--target", "es2020", "--skipLibCheck"], { stdio: "inherit" });
const registry = require(path.join(out, "registry.js"));
let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log("  PASS " + name); } catch (error) { fail++; console.error("  FAIL " + name + ": " + error.message); } };

test("built-in command IDs are unique and stable", () => {
  const defs = registry.listModifyCommandDefinitions();
  const ids = defs.map((item) => item.id);
  assert.strictEqual(ids.length, 18);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.strictEqual(registry.getModifyCommandDefinition("move").label, "Move");
});

test("selection cardinality is resolved centrally", () => {
  assert.strictEqual(registry.resolveModifyCapability("move", { selectedCount: 0 }).enabled, false);
  assert.match(registry.resolveModifyCapability("move", { selectedCount: 0 }).reason, /at least one/);
  assert.strictEqual(registry.resolveModifyCapability("align-x", { selectedCount: 1 }).enabled, false);
  assert.strictEqual(registry.resolveModifyCapability("align-x", { selectedCount: 2 }).enabled, true);
});

test("clipboard commands depend on clipboard content, not selection count", () => {
  assert.strictEqual(registry.resolveModifyCapability("paste", { selectedCount: 0, clipboardCount: 0 }).enabled, false);
  assert.strictEqual(registry.resolveModifyCapability("paste", { selectedCount: 0, clipboardCount: 2 }).enabled, true);
});

test("read-only, locked, pinned and linked selections are rejected with explicit reasons", () => {
  for (const element of [
    { id: "linked", sourceKind: "linked" },
    { id: "readonly", editable: false },
    { id: "locked", locked: true },
    { id: "pinned", pinned: true },
  ]) {
    const result = registry.resolveModifyCapability("move", { selectedCount: 1, selectedElements: [element] });
    assert.strictEqual(result.enabled, false, element.id);
    assert.ok(result.reason, element.id + " reason missing");
    assert.deepStrictEqual(result.rejectedElementIds, [element.id]);
  }
  assert.strictEqual(registry.resolveModifyCapability("unpin", { selectedCount: 1, selectedElements: [{ id: "pinned", pinned: true }] }).enabled, true);
});

test("mixed selection is all-or-nothing and never silently edits an eligible subset", () => {
  const result = registry.resolveModifyCapability("move", {
    selectedCount: 2,
    selectedElements: [{ id: "native", sourceKind: "native" }, { id: "ifc-link", sourceKind: "linked" }],
  });
  assert.strictEqual(result.enabled, false);
  assert.deepStrictEqual(result.eligibleElementIds, ["native"]);
  assert.deepStrictEqual(result.rejectedElementIds, ["ifc-link"]);
});

test("edit mode and unknown command restrictions are explicit", () => {
  assert.strictEqual(registry.resolveModifyCapability("move", { selectedCount: 1, editMode: "sketch" }).enabled, false);
  assert.match(registry.resolveModifyCapability("move", { selectedCount: 1, editMode: "sketch" }).reason, /sketch/);
  assert.strictEqual(registry.resolveModifyCapability("not-a-command", { selectedCount: 1 }).enabled, false);
});

test("registration rejects duplicate IDs and built-ins cannot be unregistered", () => {
  const move = registry.getModifyCommandDefinition("move");
  assert.throws(() => registry.registerModifyCommand(move), /already registered/);
  assert.strictEqual(registry.unregisterModifyCommand("move"), false);
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
