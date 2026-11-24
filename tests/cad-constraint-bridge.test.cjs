/* Phase 4: editor <-> solver bridge — relations over real entities, pinning, diagnostics, no silent edits. */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cbridge-"));
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
execSync(`npx tsc src/modules/cad-viewer/constraint-bridge.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck${flag}`, { stdio: "pipe", cwd: root });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const B = require(find(out, "constraint-bridge.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };
const near = (a, b, m = "", e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${m} ${a} != ${b}`);
const line = (x1, y1, x2, y2) => ({ type: "LINE", layer: "0", start: { x: x1, y: y1, z: 0 }, end: { x: x2, y: y2, z: 0 } });
const circle = (x, y, r) => ({ type: "CIRCLE", layer: "0", center: { x, y, z: 0 }, radius: r });
const M = (o) => new Map(Object.entries(o));

t("pinned line with unsatisfiable relations is refused, not bent", () => {
  const l = { ...line(0, 0, 9, 3), layer: "WALLS", color: 3 };
  const r = B.solveRelations(M({ L: l }), [{ kind: "horizontal", ids: ["L"] }, { kind: "length", ids: ["L"], value: 10 }], new Set(["L"]));
  // a pinned line cannot move, so the relations cannot hold: nothing may be applied
  assert.ok(["conflict", "diverged"].includes(r.status), r.status);
  assert.strictEqual(r.updated.size, 0);
});
t("pinned entity stays put; the other follows (parallel)", () => {
  const a = line(0, 0, 10, 0), b = line(0, 5, 8, 9);
  const r = B.solveRelations(M({ A: a, B: b }), [{ kind: "parallel", ids: ["A", "B"] }], new Set(["A"]));
  assert.ok(r.status === "solved" || r.status === "underconstrained", r.status);
  assert.ok(!r.updated.has("A"));
  const nb = r.updated.get("B"); assert.ok(nb);
  near(nb.end.y - nb.start.y, 0, "B horizontal now");
});
t("horizontal then length gives exact result and keeps layer/colour", () => {
  const l = { ...line(0, 0, 9, 3), layer: "WALLS", color: 3 };
  const r = B.solveRelations(M({ L: l }), [{ kind: "horizontal", ids: ["L"] }, { kind: "length", ids: ["L"], value: 10 }]);
  const n = r.updated.get("L"); assert.ok(n, r.status);
  near(n.end.y, n.start.y); near(Math.hypot(n.end.x - n.start.x, n.end.y - n.start.y), 10);
  assert.strictEqual(n.layer, "WALLS"); assert.strictEqual(n.color, 3);
  assert.strictEqual(l.end.y, 3, "input not mutated");
});
t("tangent line/circle, either argument order", () => {
  for (const ids of [["L", "C"], ["C", "L"]]) {
    const r = B.solveRelations(M({ L: line(-5, 4, 5, 4.2), C: circle(0, 0, 3) }), [{ kind: "tangent", ids }], new Set(["C"]));
    const n = r.updated.get("L"); assert.ok(n, r.status);
    const dx = n.end.x - n.start.x, dy = n.end.y - n.start.y;
    near(Math.abs(dx * n.start.y - dy * n.start.x) / Math.hypot(dx, dy), 3, "distance centre->line = radius", 1e-5);
  }
});
t("equal radius + concentric + radius value on ARC keeps its angles", () => {
  const arc = { type: "ARC", layer: "0", center: { x: 4, y: 4, z: 0 }, radius: 2, startAngle: 10, endAngle: 80 };
  const r = B.solveRelations(M({ C: circle(0, 0, 5), A: arc }), [{ kind: "concentric", ids: ["C", "A"] }, { kind: "equal", ids: ["C", "A"] }], new Set(["C"]));
  const n = r.updated.get("A"); assert.ok(n, r.status);
  near(n.center.x, 0); near(n.center.y, 0); near(n.radius, 5); assert.strictEqual(n.startAngle, 10); assert.strictEqual(n.endAngle, 80);
});
t("conflicting relations are reported and nothing is applied", () => {
  const r = B.solveRelations(M({ L: line(0, 0, 5, 1) }), [
    { kind: "length", ids: ["L"], value: 10 }, { kind: "length", ids: ["L"], value: 20 }]);
  assert.strictEqual(r.status, "conflict"); assert.strictEqual(r.updated.size, 0); assert.ok(r.conflicting.length >= 1);
  assert.ok(B.describeBridge(r, [{ kind: "length", ids: ["L"] }, { kind: "length", ids: ["L"] }]).join(" ").includes("NOT applied"));
});
t("unsupported geometry / missing objects are reported, not moved", () => {
  const poly = { type: "LWPOLYLINE", layer: "0", points: [], closed: false };
  const r = B.solveRelations(M({ P: poly, L: line(0, 0, 1, 1) }), [{ kind: "horizontal", ids: ["P"] }, { kind: "horizontal", ids: ["GONE"] }]);
  assert.strictEqual(r.status, "empty"); assert.strictEqual(r.updated.size, 0); assert.strictEqual(r.messages.length, 2);
});
t("deterministic: same input, same output", () => {
  const mk = () => B.solveRelations(M({ A: line(0, 0, 10, 1), B: line(0, 5, 8, 9) }), [{ kind: "perpendicular", ids: ["A", "B"] }], new Set(["A"]));
  assert.deepStrictEqual(JSON.stringify([...mk().updated]), JSON.stringify([...mk().updated]));
});
t("validateRelation arity and type rules", () => {
  const by = M({ L: line(0, 0, 1, 0), C: circle(0, 0, 1) });
  assert.ok(B.validateRelation({ kind: "parallel", ids: ["L"] }, by));
  assert.ok(B.validateRelation({ kind: "radius", ids: ["L"], value: 1 }, by));
  assert.strictEqual(B.validateRelation({ kind: "radius", ids: ["C"], value: 1 }, by), null);
});
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
