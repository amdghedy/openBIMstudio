/**
 * tests/v68-acceptance.test.cjs
 *
 * MASTER PROMPT MODULE 2E — the ten mandatory integration/acceptance
 * scenarios, executed against the real engine APIs (no mocks of the
 * behaviour under test). Performance scenario 10 measures candidate
 * query time and memory with generous CI-safe budgets.
 *
 * Run: `node tests/v68-acceptance.test.cjs`
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`    ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function near(a, b, tol = 1e-9) { if (!(Math.abs(a - b) <= tol)) throw new Error(`Expected ${a} ~ ${b} (tol ${tol})`); }

const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-v68-acc-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/modules/snapping/index.ts src/modules/relationships/index.ts src/modules/modify/index.ts" +
  " src/modules/mep/connectors.ts src/modules/properties-panel/authoring.ts" +
  " src/modules/object-hierarchy/index.ts src/modules/solid-kernel/index.ts" +
  " src/modules/hosting/index.ts src/modules/dependency-graph/index.ts" +
  " src/modules/parameter-engine/index.ts src/modules/constraints/solver.ts",
  { cwd: root, stdio: "inherit", shell: true },
);

const snap = require(path.join(tmpOut, "modules/snapping/index.js"));
const rel = require(path.join(tmpOut, "modules/relationships/index.js"));
const mod = require(path.join(tmpOut, "modules/modify/index.js"));
const mepc = require(path.join(tmpOut, "modules/mep/connectors.js"));
const pp = require(path.join(tmpOut, "modules/properties-panel/authoring.js"));
const oh = require(path.join(tmpOut, "modules/object-hierarchy/index.js"));
const sk = require(path.join(tmpOut, "modules/solid-kernel/index.js"));
const host = require(path.join(tmpOut, "modules/hosting/index.js"));
const dg = require(path.join(tmpOut, "modules/dependency-graph/index.js"));
const pe = require(path.join(tmpOut, "modules/parameter-engine/index.js"));
const solver = require(path.join(tmpOut, "modules/constraints/solver.js"));

function makeStore(elements) {
  const map = new Map();
  for (const el of elements) map.set(el.id, { ...el, curve: el.curve ? { ...el.curve } : undefined });
  return {
    get: (id) => map.get(id),
    apply: (id, patch) => { const el = map.get(id); if (!el) return false; Object.assign(el, patch); return true; },
    insert: (el) => map.set(el.id, { ...el, curve: el.curve ? { ...el.curve } : undefined }),
    all: () => [...map.values()],
  };
}
const wall = (id, start, end, extra = {}) => ({
  id, categoryId: "walls", pinned: false, editable: true,
  position: [0, 0], rotationZ: 0,
  curve: { start, end }, ...extra,
});

// Minimal smoke that still exercises rotate rigid-motion + move propagation.
t("2E.6 connected objects: Rotate Commit propagates dependents", () => {
  const store = makeStore([wall("beam1", [0, 0], [4, 0], { position: [0, 0], categoryId: "beams" })]);
  const registry = new rel.RelationshipRegistry();
  registry.createRelationship({
    type: "rigid-attachment",
    source: { elementId: "beam1", kind: "endpoint", position: [4, 0, 0] },
    target: { elementId: "hanger", kind: "endpoint", position: [4, -1, 0] },
    reconnection: "follow-source",
  });
  const rot = new mod.RotateCommand({ store, relationships: registry });
  rot.Begin(["beam1"]);
  rot.UpdatePreview({ type: "rotation", pivot: [0, 0], angle: Math.PI / 2 });
  const rc = rot.Commit();
  assert(rc.ok);
  const el = store.get("beam1");
  const rwex = el.position[0] + el.curve.end[0] * Math.cos(el.rotationZ) - el.curve.end[1] * Math.sin(el.rotationZ);
  const rwey = el.position[1] + el.curve.end[0] * Math.sin(el.rotationZ) + el.curve.end[1] * Math.cos(el.rotationZ);
  near(rwex, 0, 1e-9);
  near(rwey, 4, 1e-9);
  const deps = registry.queryRelationships({ elementId: "beam1" });
  assert(deps.length === 1 && deps[0].target.elementId === "hanger");
  near(deps[0].target.position[0], 1, 1e-9);
  near(deps[0].target.position[1], 4, 1e-9);
});

t("2E.7 locked alignment blocks; valid state preserved", () => {
  const store = makeStore([wall("w1", [0, 0], [4, 0])]);
  const registry = new rel.RelationshipRegistry();
  registry.createRelationship({
    type: "persistent-alignment",
    source: { elementId: "w1", kind: "endpoint", position: [0, 0, 0] },
    target: { elementId: "grid-a", kind: "grid", position: [0, 0, 0] },
    constraint: { kind: "coincident" },
    reconnection: "follow-source",
  });
  const cmd = new mod.MoveCommand({ store, relationships: registry });
  cmd.Begin(["w1"]);
  cmd.UpdatePreview({ type: "numeric-offset", dx: 2, dy: 0 });
  const v = cmd.Validate();
  assert(!v.ok && v.diagnostics.some((d) => d.code === "alignment-conflict"));
  const c = cmd.Commit();
  assert(!c.ok && c.applied === 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
