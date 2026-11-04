const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const THREE = require("three");
const root = path.resolve(__dirname, "..");
process.env.NODE_PATH = [path.join(root, "node_modules"), process.env.NODE_PATH || ""]
  .filter(Boolean).join(path.delimiter);
require("node:module").Module._initPaths();
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-family-connector-preview-"));

try {
  const source = path.join(root, "src/modules/families/connector-preview.ts");
  execSync("npx tsc \"" + source + "\" --outDir \"" + out +
    "\" --module commonjs --target es2020 --strict --skipLibCheck",
    { cwd: root, stdio: "pipe" });
  const findCompiled = (dir, file) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findCompiled(full, file);
        if (found) return found;
      } else if (entry.isFile() && entry.name === file) return full;
    }
    return null;
  };
  const compiled = findCompiled(out, "connector-preview.js");
  assert.ok(compiled, "compiled connector preview module not found");
  const { buildFamilyConnectorPreviewLayout } = require(compiled);
  let pass = 0, fail = 0;
  const test = (name, fn) => {
    try { fn(); pass++; console.log("  PASS " + name); }
    catch (error) { fail++; console.error("  FAIL " + name + ": " + error.message); }
  };
  const connector = (overrides = {}) => ({
    name: "Supply",
    origin: [1, 0, 0],
    direction: [1, 0, 0],
    domain: "pipe",
    shape: "round",
    size: 0.05,
    flowDirection: "out",
    systemClassification: "chilled-water",
    ...overrides,
  });
  const finitePoint = (point) =>
    Number.isFinite(point.x) && Number.isFinite(point.y);

  test("projects connector origins and axes through the rendered instance transform", () => {
    const instance = new THREE.Group();
    instance.position.set(5, 2, 8);
    instance.rotation.y = Math.PI / 2;
    instance.scale.set(2, 1, 1);
    instance.add(new THREE.Mesh(new THREE.BoxGeometry(2, 1, 2)));
    const layout = buildFamilyConnectorPreviewLayout(instance, [connector()]);
    assert.ok(layout);
    assert.equal(layout.ports.length, 1);
    assert.deepEqual(layout.ports[0].worldOrigin, [5, 2, 6]);
    assert.deepEqual(layout.ports[0].worldDirection, [0, 0, -1]);
    assert.ok(finitePoint(layout.ports[0].origin));
    assert.ok(finitePoint(layout.ports[0].axisEnd));
    assert.notDeepEqual(layout.ports[0].origin, layout.ports[0].axisEnd);
  });

  test("keeps model dimensions independent from connector extensions", () => {
    const instance = new THREE.Mesh(new THREE.BoxGeometry(2, 3, 4));
    const layout = buildFamilyConnectorPreviewLayout(instance, [
      connector({ origin: [20, 0, 0] }),
    ]);
    assert.ok(layout);
    assert.deepEqual(layout.dimensions, [2, 3, 4]);
    assert.equal(layout.geometryCorners.length, 8);
    assert.ok(layout.ports[0].origin.x >= 0 && layout.ports[0].origin.x <= 220);
    assert.ok(layout.ports[0].origin.y >= 0 && layout.ports[0].origin.y <= 160);
  });

  test("supports an equipment family with ports but no preview mesh", () => {
    const instance = new THREE.Group();
    const layout = buildFamilyConnectorPreviewLayout(instance, [connector({ origin: [0, 0, 0] })]);
    assert.ok(layout);
    assert.equal(layout.geometryCorners.length, 0);
    assert.equal(layout.ports.length, 1);
    assert.ok(finitePoint(layout.ports[0].origin));
  });

  test("returns null when both preview geometry and connector definitions are absent", () => {
    assert.equal(buildFamilyConnectorPreviewLayout(new THREE.Group(), []), null);
  });

  test("rejects invalid preview dimensions and malformed connector definitions", () => {
    const instance = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    assert.throws(() => buildFamilyConnectorPreviewLayout(instance, [], 220, 160, 90), /padding are invalid/);
    assert.throws(() => buildFamilyConnectorPreviewLayout(instance, [
      connector({ direction: [0, 0, 0] }),
    ]), /must be non-zero/);
  });

  test("does not mutate connector definitions while producing the preview", () => {
    const definition = connector();
    const before = JSON.parse(JSON.stringify(definition));
    const instance = new THREE.Group();
    instance.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    buildFamilyConnectorPreviewLayout(instance, [definition]);
    assert.deepEqual(definition, before);
  });

  const browserSource = fs.readFileSync(path.join(root, "src/features/family-browser.ts"), "utf8");
  test("Family Browser passes connector definitions to the geometry preview", () => {
    assert.match(browserSource, /buildPreviewSvg\(built,\s*fam\.connectorDefs\s*\?\?\s*\[\]\)/);
    assert.match(browserSource, /buildFamilyConnectorPreviewLayout/);
    assert.match(browserSource, /createElementNS\(SVG_NS,\s*["']circle["']\)/);
    assert.match(browserSource, /createElementNS\(SVG_NS,\s*["']polygon["']\)/);
  });

  console.log("=== Family connector preview tests: " + pass + " passed, " + fail + " failed ===");
  process.exitCode = fail ? 1 : 0;
} finally {
  fs.rmSync(out, { recursive: true, force: true });
}
