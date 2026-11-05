// Reveal cutter: a closed, outward-wound groove solid with the expected volume and depth.
const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
const { execFileSync } = require("child_process");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-reveal-"));
execFileSync("npx", ["tsc", "--rootDir", "src", "--outDir", out, "--module", "commonjs", "--target", "ES2022", "--skipLibCheck", "--noCheck", "src/modules/wall-sweeps/geometry.ts"], { stdio: "inherit" });
const G = require(path.join(out, "modules/wall-sweeps/geometry.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const tris = (pos) => { const r = []; for (let i = 0; i < pos.length; i += 9) r.push([[pos[i], pos[i+1], pos[i+2]], [pos[i+3], pos[i+4], pos[i+5]], [pos[i+6], pos[i+7], pos[i+8]]]); return r; };
const volume = (pos) => tris(pos).reduce((v, [p, q, r]) => v + (p[0]*(q[1]*r[2]-q[2]*r[1]) - p[1]*(q[0]*r[2]-q[2]*r[0]) + p[2]*(q[0]*r[1]-q[1]*r[0])) / 6, 0);
const edgeKey = (a, b) => [a, b].map((v) => v.map((x) => x.toFixed(6)).join(",")).sort().join("|");
const closed = (pos) => { const m = new Map(); for (const [a, b, c] of tris(pos)) for (const [u, v] of [[a, b], [b, c], [c, a]]) { const k = edgeKey(u, v); m.set(k, (m.get(k) || 0) + 1); } return [...m.values()].every((n) => n % 2 === 0); };
const W = [0, 0], E = [6, 0];
const place = (o = {}) => ({ wallId: "w", profileId: "reveal-10", height: 1, face: "exterior", ...o });

t("a sweep profile is not a reveal", () => assert.strictEqual(G.generateRevealCutter(W, E, 0.2, 0, place({ profileId: "baseboard-100" })), null));
t("the cutter is a closed body with positive volume", () => {
  const c = G.generateRevealCutter(W, E, 0.2, 0, place());
  assert.ok(c && c.positions.length > 0);
  assert.ok(closed(c.positions), "every edge is shared by two triangles");
  assert.ok(volume(c.positions) > 0, "outward winding");
});
t("volume equals profile area (incl. overshoot) times length", () => {
  const c = G.generateRevealCutter(W, E, 0.2, 0, place());
  // profile 10 mm deep x 20 mm tall, starting 10 mm outside the face: (0.01 + 0.01) x 0.02 x 6 m
  assert.ok(Math.abs(volume(c.positions) - 0.02 * 0.02 * 6) < 1e-9, String(volume(c.positions)));
});
t("both faces give two bodies, each closed and positive", () => {
  const one = G.generateRevealCutter(W, E, 0.2, 0, place());
  const two = G.generateRevealCutter(W, E, 0.2, 0, place({ face: "both" }));
  assert.strictEqual(two.positions.length, one.positions.length * 2);
  assert.ok(closed(two.positions));
  assert.ok(Math.abs(volume(two.positions) - 2 * volume(one.positions)) < 1e-9);
});
t("the groove stays inside the wall thickness (plus overshoot)", () => {
  const c = G.generateRevealCutter(W, E, 0.2, 0, place({ face: "both" }));
  const zs = tris(c.positions).flat(2).filter((_, i) => i % 3 === 2);
  assert.ok(Math.max(...zs) <= 0.1 + G.REVEAL_OVERSHOOT + 1e-9 && Math.min(...zs) >= -0.1 - G.REVEAL_OVERSHOOT - 1e-9);
});
t("height and start/end offsets are honoured", () => {
  const c = G.generateRevealCutter(W, E, 0.2, 0.5, place({ height: 1.2, startOffset: 1, endOffset: 4 }));
  const p = tris(c.positions).flat(2);
  const ys = p.filter((_, i) => i % 3 === 1), xs = p.filter((_, i) => i % 3 === 0);
  assert.ok(Math.min(...ys) >= 1.7 - 1e-9 && Math.max(...ys) <= 1.72 + 1e-9);
  assert.ok(Math.abs(Math.min(...xs) - 1) < 1e-9 && Math.abs(Math.max(...xs) - 4) < 1e-9);
});
t("a groove deeper than the wall allows is refused", () => assert.strictEqual(G.generateRevealCutter(W, E, 0.01, 0, place()), null));
t("a too-short wall is refused", () => assert.strictEqual(G.generateRevealCutter(W, [0.02, 0], 0.2, 0, place()), null));
console.log(`=== Result: ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
