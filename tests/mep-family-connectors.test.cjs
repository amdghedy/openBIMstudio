const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const THREE = require("three");
const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-mep-family-connectors-"));
try {
  const source = path.join(root, "src/modules/mep/family-connectors.ts");
  execSync("npx tsc \"" + source + "\" --outDir \"" + out + "\" --module commonjs --target es2020 --strict --skipLibCheck",
    { cwd: root, stdio: "pipe" });
  const findCompiled = (dir, file) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = findCompiled(full, file); if (found) return found; }
      else if (entry.isFile() && entry.name === file) return full;
    }
    return null;
  };
  const compiled = findCompiled(out, "family-connectors.js");
  assert.ok(compiled, "TypeScript compiler output not found");
  const { deriveFamilyInstanceConnectors } = require(compiled);
  let pass = 0, fail = 0;
  const test = (name, fn) => {
    try { fn(); pass++; console.log("  PASS " + name); }
    catch (e) { fail++; console.error("  FAIL " + name + ": " + e.message); }
  };
  const close = (actual, expected, epsilon = 1e-9) => {
    assert.equal(actual.length, expected.length);
    actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) <= epsilon,
      "index " + i + ": expected " + expected[i] + ", got " + value));
  };
  const connector = (name, origin, direction, size = 0.05) => ({
    name, origin, direction, domain: "pipe", shape: "round", size,
    flowDirection: "inout", systemClassification: "chilled-water",
  });

  test("uses the rendered instance translation, rotation and scale", () => {
    const instance = new THREE.Group();
    instance.position.set(5, 2, 8);
    instance.rotation.y = Math.PI / 2;
    instance.scale.set(2, 1, 1);
    const result = deriveFamilyInstanceConnectors("EQ-1", [
      connector("supply", [1, 0, 0], [1, 0, 0]),
    ], instance);
    close(result[0].worldOrigin, [5, 2, 6]);
    close(result[0].worldDirection, [0, 0, -1]);
    assert.equal(result[0].ownerElementId, "EQ-1");
    assert.equal(result[0].engaged, false);
    assert.equal(result[0].connectedTo, null);
  });

  test("includes parent transforms and preserves local definition coordinates", () => {
    const parent = new THREE.Group();
    parent.position.set(10, 3, -4);
    parent.rotation.y = Math.PI / 2;
    const instance = new THREE.Group();
    instance.position.set(1, 2, 3);
    instance.scale.set(2, 1, 1);
    parent.add(instance);
    const definition = connector("return", [1, 0, 0], [1, 0, 0], [0.2, 0.1]);
    const result = deriveFamilyInstanceConnectors("EQ-2", [definition], instance);
    close(result[0].worldOrigin, [13, 5, -7]);
    close(result[0].worldDirection, [0, 0, -1]);
    assert.deepEqual(result[0].def.origin, [1, 0, 0]);
    assert.deepEqual(result[0].def.size, [0.2, 0.1]);
  });

  test("deep-copies connector definitions and size arrays", () => {
    const definition = connector("port", [0, 1, 0], [0, 1, 0], [0.3, 0.2]);
    const result = deriveFamilyInstanceConnectors("EQ-3", [definition], new THREE.Group());
    result[0].def.origin[0] = 99;
    result[0].def.direction[1] = 99;
    result[0].def.size[0] = 99;
    assert.deepEqual(definition.origin, [0, 1, 0]);
    assert.deepEqual(definition.direction, [0, 1, 0]);
    assert.deepEqual(definition.size, [0.3, 0.2]);
  });

  test("rejects invalid coordinates and zero-length connector axes", () => {
    const instance = new THREE.Group();
    assert.throws(() => deriveFamilyInstanceConnectors("EQ-4", [
      connector("bad", [Number.NaN, 0, 0], [1, 0, 0]),
    ], instance), /finite 3D vectors/);
    assert.throws(() => deriveFamilyInstanceConnectors("EQ-4", [
      connector("zero", [0, 0, 0], [0, 0, 0]),
    ], instance), /must be non-zero/);
  });

  console.log("=== MEP family connector tests: " + pass + " passed, " + fail + " failed ===");
  process.exitCode = fail ? 1 : 0;
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
