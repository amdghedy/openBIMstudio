/* Phase 4: deterministic constraint solver — every constraint type, DOF, redundancy, conflicts, determinism. */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "csolve-"));
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
execSync(`npx tsc src/modules/cad-viewer/constraint-solver.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck${flag}`, { stdio: "pipe", cwd: root });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const S = require(find(out, "constraint-solver.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };
const near = (a, b, m = "", e = 1e-6) => assert.ok(Math.abs(a - b) < e, `${m} ${a} != ${b}`);
const sk = (points, lines = {}, circles = {}, arcs = {}) => ({ points, lines, circles, arcs });
const len = (s, l) => { const a = s.points[s.lines[l].p1], b = s.points[s.lines[l].p2]; return Math.hypot(b.x - a.x, b.y - a.y); };

t("coincident joins two points; fixed point stays put", () => {
  const s = sk({ a: { x: 0, y: 0 }, b: { x: 5, y: 7 } });
  const r = S.solve(s, [{ id: "c1", type: "coincident", a: "a", b: "b" }, { id: "f", type: "fixed", point: "a" }]);
  assert.strictEqual(r.status, "solved"); near(r.sketch.points.b.x, 0); near(r.sketch.points.b.y, 0); near(r.sketch.points.a.x, 0);
});
t("horizontal + vertical + length make a fully constrained rectangle side", () => {
  const s = sk({ a: { x: 0, y: 0 }, b: { x: 9, y: 3 }, c: { x: 8, y: 12 } }, { ab: { p1: "a", p2: "b" }, bc: { p1: "b", p2: "c" } });
  const r = S.solve(s, [
    { id: "1", type: "fixed", point: "a" }, { id: "2", type: "horizontal", line: "ab" }, { id: "3", type: "vertical", line: "bc" },
    { id: "4", type: "length", line: "ab", value: 10 }, { id: "5", type: "length", line: "bc", value: 6 }]);
  assert.strictEqual(r.status, "solved", JSON.stringify(r.messages)); assert.strictEqual(r.dof, 0);
  near(Math.abs(r.sketch.points.b.x), 10); near(r.sketch.points.b.y, 0); near(r.sketch.points.c.x, r.sketch.points.b.x); near(Math.abs(r.sketch.points.c.y), 6);
});
t("parallel and perpendicular", () => {
  const s = sk({ a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 0, y: 5 }, d: { x: 9, y: 9 }, e: { x: 3, y: 3 }, f: { x: 4, y: 12 } },
    { ab: { p1: "a", p2: "b" }, cd: { p1: "c", p2: "d" }, ef: { p1: "e", p2: "f" } });
  const r = S.solve(s, [{ id: "p", type: "parallel", a: "ab", b: "cd" }, { id: "q", type: "perpendicular", a: "ab", b: "ef" }, { id: "fa", type: "fixed", point: "a" }, { id: "fb", type: "fixed", point: "b" }]);
  assert.ok(["solved", "underconstrained"].includes(r.status)); assert.ok(S.maxViolation(r.sketch, [{ id: "p", type: "parallel", a: "ab", b: "cd" }, { id: "q", type: "perpendicular", a: "ab", b: "ef" }]) < 1e-7);
});
t("tangent line-circle and circle-circle (external + internal)", () => {
  const s = sk({ a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 5, y: 4 }, d: { x: 20, y: 4 } }, { ab: { p1: "a", p2: "b" } }, { k: { c: "c", r: 2 }, m: { c: "d", r: 3 } });
  const cs = [{ id: "1", type: "fixed", point: "a" }, { id: "2", type: "fixed", point: "b" }, { id: "3", type: "fixed", point: "c" }, { id: "4", type: "tangent", line: "ab", circle: "k" },
    { id: "5", type: "tangentCircles", a: "k", b: "m" }, { id: "6", type: "radius", circle: "m", value: 3 }];
  const r = S.solve(s, cs); assert.ok(r.residual < 1e-7, JSON.stringify(r.messages)); near(r.sketch.circles.k.r, 4, "r");
  near(Math.hypot(r.sketch.points.c.x - r.sketch.points.d.x, r.sketch.points.c.y - r.sketch.points.d.y), 7, "external tangent distance");
  const r2 = S.solve(s, cs.map((c) => (c.id === "5" ? { ...c, internal: true } : c))); near(Math.hypot(r2.sketch.points.c.x - r2.sketch.points.d.x, r2.sketch.points.c.y - r2.sketch.points.d.y), 1, "internal tangent distance");
});
t("concentric, equal radius, equal length", () => {
  const s = sk({ c1: { x: 0, y: 0 }, c2: { x: 4, y: 4 }, a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, c: { x: 0, y: 1 }, d: { x: 3, y: 5 } }, { ab: { p1: "a", p2: "b" }, cd: { p1: "c", p2: "d" } }, { k1: { c: "c1", r: 5 }, k2: { c: "c2", r: 2 } });
  const r = S.solve(s, [{ id: "1", type: "concentric", a: "k1", b: "k2" }, { id: "2", type: "equalRadius", a: "k1", b: "k2" }, { id: "3", type: "equalLength", a: "ab", b: "cd" }, { id: "4", type: "fixed", point: "c1" }, { id: "5", type: "fixed", point: "a" }, { id: "6", type: "fixed", point: "b" }, { id: "7", type: "fixed", point: "c" }]);
  near(r.sketch.points.c2.x, 0); near(r.sketch.points.c2.y, 0); near(r.sketch.circles.k1.r, r.sketch.circles.k2.r); near(len(r.sketch, "cd"), 10);
});
t("symmetric about an axis", () => {
  const s = sk({ a: { x: 3, y: 2 }, b: { x: 5, y: 9 }, p: { x: 0, y: 0 }, q: { x: 0, y: 10 } }, { axis: { p1: "p", p2: "q" } });
  const r = S.solve(s, [{ id: "1", type: "symmetric", a: "a", b: "b", line: "axis" }, { id: "2", type: "fixed", point: "p" }, { id: "3", type: "fixed", point: "q" }, { id: "4", type: "fixed", point: "a" }]);
  near(r.sketch.points.b.x, -3); near(r.sketch.points.b.y, 2);
});
t("dimensional: distance, radius, angle", () => {
  const s = sk({ a: { x: 0, y: 0 }, b: { x: 10, y: 1 }, c: { x: 0, y: 0 }, d: { x: 5, y: 5 }, o: { x: 0, y: 0 } }, { ab: { p1: "a", p2: "b" }, cd: { p1: "c", p2: "d" } }, { k: { c: "o", r: 1 } });
  const r = S.solve(s, [{ id: "1", type: "fixed", point: "a" }, { id: "2", type: "fixed", point: "c" }, { id: "3", type: "horizontal", line: "ab" }, { id: "4", type: "distance", a: "a", b: "b", value: 12 },
    { id: "5", type: "angle", a: "ab", b: "cd", value: Math.PI / 3 }, { id: "6", type: "radius", circle: "k", value: 7.5 }, { id: "7", type: "length", line: "cd", value: 4 }, { id: "8", type: "fixed", point: "o" }]);
  assert.strictEqual(r.status, "solved", JSON.stringify(r.messages)); near(r.sketch.circles.k.r, 7.5); near(len(r.sketch, "ab"), 12);
  const ab = r.sketch.points, ang = Math.atan2(ab.d.y - ab.c.y, ab.d.x - ab.c.x) - Math.atan2(ab.b.y - ab.a.y, ab.b.x - ab.a.x); near(Math.cos(ang), Math.cos(Math.PI / 3));
});
t("under-constrained reports remaining DOF", () => {
  const s = sk({ a: { x: 0, y: 0 }, b: { x: 3, y: 1 } }, { ab: { p1: "a", p2: "b" } });
  const r = S.solve(s, [{ id: "1", type: "fixed", point: "a" }, { id: "2", type: "length", line: "ab", value: 5 }]);
  assert.strictEqual(r.status, "underconstrained"); assert.strictEqual(r.dof, 1); near(len(r.sketch, "ab"), 5);
});
t("redundant constraint is reported, not an error", () => {
  const s = sk({ a: { x: 0, y: 0 }, b: { x: 3, y: 1 } }, { ab: { p1: "a", p2: "b" } });
  const r = S.solve(s, [{ id: "1", type: "fixed", point: "a" }, { id: "2", type: "horizontal", line: "ab" }, { id: "3", type: "horizontal", line: "ab" }, { id: "4", type: "length", line: "ab", value: 4 }]);
  assert.strictEqual(r.status, "overconstrained"); assert.ok(r.redundant.includes("2") && r.redundant.includes("3"), JSON.stringify(r.redundant)); near(r.sketch.points.b.y, 0);
});
t("conflicting constraints are detected and the sketch is left unchanged", () => {
  const s = sk({ a: { x: 0, y: 0 }, b: { x: 3, y: 1 } }, { ab: { p1: "a", p2: "b" } });
  const r = S.solve(s, [{ id: "1", type: "fixed", point: "a" }, { id: "2", type: "length", line: "ab", value: 5 }, { id: "3", type: "length", line: "ab", value: 8 }]);
  assert.strictEqual(r.status, "conflict"); assert.ok(r.conflicting.includes("2") && r.conflicting.includes("3")); assert.strictEqual(r.sketch, s);
});
t("deterministic: same input, same output; constraint order does not matter", () => {
  const mk = () => sk({ a: { x: 0, y: 0 }, b: { x: 9, y: 3 }, c: { x: 8, y: 12 } }, { ab: { p1: "a", p2: "b" }, bc: { p1: "b", p2: "c" } });
  const cs = [{ id: "1", type: "fixed", point: "a" }, { id: "2", type: "horizontal", line: "ab" }, { id: "3", type: "vertical", line: "bc" }, { id: "4", type: "length", line: "ab", value: 10 }, { id: "5", type: "length", line: "bc", value: 6 }];
  const r1 = S.solve(mk(), cs), r2 = S.solve(mk(), cs), r3 = S.solve(mk(), cs.slice().reverse());
  assert.deepStrictEqual(r1.sketch, r2.sketch); assert.deepStrictEqual(r1.sketch, r3.sketch);
});
t("invalid input is rejected with a message", () => {
  const s = sk({ a: { x: 0, y: 0 } });
  assert.strictEqual(S.solve(s, [{ id: "1", type: "horizontal", line: "nope" }]).status, "invalid");
  assert.strictEqual(S.solve(s, [{ id: "1", type: "fixed", point: "a" }, { id: "1", type: "fixed", point: "a" }]).status, "invalid");
});
t("serialisation round trip is stable and validated", () => {
  const cs = [{ id: "b", type: "fixed", point: "a" }, { id: "a", type: "length", line: "ab", value: 5 }];
  const j = S.serializeConstraints(cs); assert.deepStrictEqual(S.parseConstraints(j).map((c) => c.id), ["a", "b"]);
  assert.throws(() => S.parseConstraints('[{"id":"x","type":"nope"}]')); assert.throws(() => S.parseConstraints("{}"));
});
t("scales: a 60-point chain of equal-length horizontal links converges", () => {
  const points = {}, lines = {}, cs = [];
  for (let i = 0; i <= 60; i++) points["p" + String(i).padStart(2, "0")] = { x: i * 1.3, y: (i % 3) * 0.7 };
  for (let i = 0; i < 60; i++) { const id = "l" + String(i).padStart(2, "0"); lines[id] = { p1: "p" + String(i).padStart(2, "0"), p2: "p" + String(i + 1).padStart(2, "0") }; cs.push({ id: "h" + id, type: "horizontal", line: id }, { id: "n" + id, type: "length", line: id, value: 2 }); }
  cs.push({ id: "fix", type: "fixed", point: "p00" });
  const t0 = Date.now(); const r = S.solve(sk(points, lines), cs); const ms = Date.now() - t0;
  assert.strictEqual(r.status, "solved", r.status + JSON.stringify(r.messages)); near(r.sketch.points.p60.x, 120, "end", 1e-5); console.log(`    (${ms} ms, ${r.iterations} iterations, 122 variables)`);
});
console.log(`\ncad-constraint-solver: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
