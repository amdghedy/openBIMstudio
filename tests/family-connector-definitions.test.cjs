const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-family-connector-defs-"));
try {
  const source = path.join(root, "src/modules/families/connector-definitions.ts");
  execSync("npx tsc \"" + source + "\" --outDir \"" + out + "\" --module commonjs --target es2020 --strict --skipLibCheck",
    { cwd: root, stdio: "pipe" });
  const compiled = path.join(out, "connector-definitions.js");
  assert.ok(fs.existsSync(compiled), "compiled connector definition module not found");
  const { validateFamilyConnectorDefinitions, cloneFamilyConnectorDefinitions } = require(compiled);
  let pass = 0, fail = 0;
  const test = (name, fn) => {
    try { fn(); pass++; console.log("  PASS " + name); }
    catch (e) { fail++; console.error("  FAIL " + name + ": " + e.message); }
  };
  const definition = (overrides = {}) => ({
    name: "Supply",
    origin: [0, 0, 0],
    direction: [1, 0, 0],
    domain: "pipe",
    shape: "round",
    size: 0.05,
    flowDirection: "out",
    systemClassification: "chilled-water",
    ...overrides,
  });

  test("accepts an empty list and a valid round port", () => {
    assert.deepEqual(validateFamilyConnectorDefinitions([]), []);
    assert.deepEqual(validateFamilyConnectorDefinitions([definition()]), []);
  });
  test("accepts rectangular ports with two positive dimensions", () => {
    assert.deepEqual(validateFamilyConnectorDefinitions([
      definition({ shape: "rectangular", domain: "duct", size: [0.4, 0.25] }),
    ]), []);
  });
  test("rejects blank and case-insensitive duplicate names", () => {
    const errors = validateFamilyConnectorDefinitions([
      definition({ name: "Supply" }),
      definition({ name: " supply " }),
      definition({ name: "   " }),
    ]);
    assert.ok(errors.some(x => /case-insensitive/.test(x)));
    assert.ok(errors.some(x => /name is required/.test(x)));
  });
  test("rejects invalid vectors, zero axes and missing classifications", () => {
    const errors = validateFamilyConnectorDefinitions([
      definition({ origin: [0, Number.NaN, 0], direction: [0, 0, 0], systemClassification: " " }),
    ]);
    assert.ok(errors.some(x => /finite coordinates/.test(x)));
    assert.ok(errors.some(x => /non-zero/.test(x)));
    assert.ok(errors.some(x => /classification is required/.test(x)));
  });
  test("rejects sizes that do not match connector shape", () => {
    assert.ok(validateFamilyConnectorDefinitions([
      definition({ shape: "round", size: [0.1, 0.1] }),
    ]).some(x => /round connectors require/.test(x)));
    assert.ok(validateFamilyConnectorDefinitions([
      definition({ shape: "rectangular", size: 0.1 }),
    ]).some(x => /size is invalid/.test(x)));
    assert.ok(validateFamilyConnectorDefinitions([
      definition({ size: [0.1, 0] }),
    ]).some(x => /positive finite/.test(x)));
  });
  test("deep clone isolates local vectors and size dimensions", () => {
    const source = [definition({ shape: "rectangular", size: [0.4, 0.2] })];
    const cloned = cloneFamilyConnectorDefinitions(source);
    cloned[0].origin[0] = 42;
    cloned[0].direction[0] = 42;
    cloned[0].size[0] = 42;
    assert.deepEqual(source[0].origin, [0, 0, 0]);
    assert.deepEqual(source[0].direction, [1, 0, 0]);
    assert.deepEqual(source[0].size, [0.4, 0.2]);
  });

  console.log("=== Family connector definition tests: " + pass + " passed, " + fail + " failed ===");
  process.exitCode = fail ? 1 : 0;
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
