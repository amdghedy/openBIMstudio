const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "lc-"));
execSync(`npx tsc src/modules/native-bim/level-constraints.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
const m = require(path.join(out, "level-constraints.js"));
const L = [{ id: "L1", name: "Level 1", elevation: 0 }, { id: "L2", name: "Level 2", elevation: 3.2 }, { id: "L3", name: "Level 3", elevation: 6.4 }];
let r = m.resolveVertical({ baseLevelId: "L1", topLevelId: "L2" }, L, { elevation: 9, height: 9 });
assert.ok(r.ok && r.elevation === 0 && Math.abs(r.height - 3.2) < 1e-9);
r = m.resolveVertical({ baseLevelId: "L1", baseOffset: 0.5, topLevelId: "L2", topOffset: -0.2 }, L, { elevation: 0, height: 1 });
assert.ok(r.ok && Math.abs(r.elevation - 0.5) < 1e-9 && Math.abs(r.height - 2.5) < 1e-9);
r = m.resolveVertical({ baseLevelId: "L1", topLevelId: "" }, L, { elevation: 4, height: 2.7 }); // unconnected top keeps height
assert.ok(r.ok && r.elevation === 0 && r.height === 2.7);
r = m.resolveVertical({ baseLevelId: "L3", topLevelId: "L2" }, L, { elevation: 0, height: 3 }); assert.ok(!r.ok && /height/.test(r.reason));
r = m.resolveVertical({ baseLevelId: "nope" }, L, { elevation: 0, height: 3 }); assert.ok(!r.ok);
assert.deepStrictEqual(m.inferBase(3.7, L), { baseLevelId: "L2", baseOffset: 0.5 });
assert.strictEqual(m.inferBase(-5, L), null);
// moving Level 2 up 0.8 drags constrained walls; unconstrained untouched; broken ones reported
const els = [
  { id: "w1", params: { baseLevelId: "L1", topLevelId: "L2", elevation: 0, height: 3.2 } },
  { id: "w2", params: { baseLevelId: "L2", topLevelId: "L3", elevation: 3.2, height: 3.2 } },
  { id: "w3", params: { elevation: 0, height: 3 } },
  { id: "w4", params: { baseLevelId: "L1", topLevelId: "L2", topOffset: -10, elevation: 0, height: 3 } },
];
const L2 = L.map((l) => (l.id === "L2" ? { ...l, elevation: 4 } : l));
const res = m.levelChangeUpdates(els, L2);
const byId = Object.fromEntries(res.updates.map((u) => [u.id, u]));
assert.ok(Math.abs(byId.w1.height - 4) < 1e-9 && byId.w1.elevation === 0);
assert.ok(Math.abs(byId.w2.elevation - 4) < 1e-9 && Math.abs(byId.w2.height - 2.4) < 1e-9);
assert.ok(!byId.w3); assert.strictEqual(res.failures.length, 1); assert.strictEqual(res.failures[0].id, "w4");
assert.strictEqual(m.levelChangeUpdates(els, L).updates.length, 0);
console.log("level-constraints OK");
