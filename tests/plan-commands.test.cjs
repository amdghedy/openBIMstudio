const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-plan-cmd-"));
execFileSync("npx", ["tsc", "--rootDir", "src", "--outDir", out, "--module", "commonjs", "--target", "ES2022", "--skipLibCheck", "--noCheck", "src/modules/plan/plan-commands.ts"], { stdio: "inherit" });
const P = require(path.join(out, "modules/plan/plan-commands.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

t("names and aliases are unique across all commands", () => {
  const seen = new Map();
  for (const c of P.PLAN_COMMANDS) for (const k of [c.name, ...c.aliases]) { assert.ok(!seen.has(k), `${k} used by ${seen.get(k)} and ${c.name}`); seen.set(k, c.name); }
});
t("every command has a tool or an action", () => { for (const c of P.PLAN_COMMANDS) assert.ok(!!c.tool !== !!c.action, c.name); });
t("the default shortcut sequences resolve to the same tools", () => {
  const map = { wa: "wall", sl: null, cm: "column", bm: "beam", br: "brace", tr: "truss", ft: "footing", sf: "strip", du: "duct", pp: "pipe", dr: "door", wn: "window" };
  for (const [k, tool] of Object.entries(map)) if (tool) assert.strictEqual(P.resolveCommand(k).command.tool, tool, k);
});
t("resolve is case-insensitive and keeps the argument", () => {
  assert.strictEqual(P.resolveCommand("wall").command.name, "WALL");
  assert.strictEqual(P.resolveCommand("  Z  e ").arg, "e");
  assert.strictEqual(P.resolveCommand("zoom extents").command.action, "zoom-extents");
  assert.strictEqual(P.resolveCommand("nope"), null);
  assert.strictEqual(P.resolveCommand("  "), null);
});
t("CAD-style aliases: L line, U undo, E erase, M move, Z zoom, P pan, DI dimension", () => {
  const a = (s) => P.resolveCommand(s).command;
  assert.strictEqual(a("L").tool, "mline"); assert.strictEqual(a("U").action, "undo"); assert.strictEqual(a("E").action, "delete");
  assert.strictEqual(a("M").tool, "move"); assert.strictEqual(a("Z").action, "zoom-extents"); assert.strictEqual(a("P").action, "pan"); assert.strictEqual(a("DI").tool, "dim-aligned");
});
t("suggest: exact alias first, then prefix matches, limited", () => {
  const s = P.suggest("d");
  assert.ok(s.length > 1 && s.length <= 8);
  assert.ok(P.suggest("wa")[0].name === "WALL");
  assert.deepStrictEqual(P.suggest(""), []);
  assert.ok(P.suggest("dim").every((c) => /^DIM/.test(c.name) || c.aliases.some((x) => x.startsWith("DIM"))));
});
t("direct entry: absolute, relative, polar, distance", () => {
  assert.deepStrictEqual(P.parsePointEntry("5,3", { x: 1, z: 1 }), { kind: "point", x: 5, z: 3 });
  assert.deepStrictEqual(P.parsePointEntry("@2,-1", { x: 1, z: 1 }), { kind: "point", x: 3, z: 0 });
  const p = P.parsePointEntry("4<90", { x: 1, z: 1 }); near(p.x, 1); near(p.z, 5);
  const q = P.parsePointEntry("@2<0", { x: 0, z: 0 }); near(q.x, 2); near(q.z, 0);
  assert.deepStrictEqual(P.parsePointEntry("2500", null), { kind: "distance", value: 2500 });
  assert.deepStrictEqual(P.parsePointEntry(" 1.5 , -2 ", null), { kind: "point", x: 1.5, z: -2 });
  assert.strictEqual(P.parsePointEntry("abc", null), null);
  assert.strictEqual(P.parsePointEntry("", null), null);
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
