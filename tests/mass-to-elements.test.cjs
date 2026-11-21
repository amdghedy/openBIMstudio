/**
 * tests/mass-to-elements.test.cjs
 *
 * Revit parity Rank 6, item 2 — mass → elements.
 *
 * Two measured gaps in `src/modules/parametric/mass-to-elements.ts`:
 *   - `classifyMassFace` had no downward branch even though its header
 *     promises "Downward normal => Soffit / Foundation": a bottom face
 *     (normal.y = -1) fell through to the "sloped roof" branch and was
 *     classified as roof. It now returns "foundation".
 *   - the classifier was never called from anywhere: no UI, no
 *     conversion, no test. `convertMassToElements` is the conversion —
 *     one native element per mass face, created through the same
 *     `createElementByType` entry the draw tools and plugins use.
 *
 * The module under test is compiled from source with tsc into a temp
 * dir inside the repo (same pattern as
 * tests/parametric-voids-sweeps-lofts.test.cjs), so `three` resolves
 * from the repo's node_modules. The authoring sink is a small
 * in-memory fake implementing the `MassElementSink` interface, because
 * authoring.ts is a browser module not loadable in node.
 *
 * Run: `node tests/mass-to-elements.test.cjs`
 * CI:  `test:mass-to-elements` (package.json +
 *       scripts/ci-unit-tests.mjs).
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");

let pass = 0, fail = 0;
const pending = [];
function t(name, fn) {
  pending.push((async () => {
    try { await fn(); pass++; console.log(`  ok - ${name}`); }
    catch (e) { fail++; console.log(`  FAIL - ${name}`); console.error(`    ${e.message}`); }
  })());
}
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);

// ── Compile the module slice ────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(root, ".mass-to-elements-test-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
process.on("exit", () => {
  try { fs.rmSync(tmpOut, { recursive: true, force: true }); } catch { /* */ }
});
execSync(
  "npx tsc src/modules/parametric/mass-to-elements.ts"
  + " --outDir " + JSON.stringify(tmpOut)
  + " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck",
  { cwd: root, stdio: "inherit", shell: true },
);
const find = (n) => {
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) { const r = walk(p); if (r) return r; }
      else if (f.name === n) return p;
    }
    return null;
  };
  return walk(tmpOut);
};
const M = require(find("mass-to-elements.js"));

// ── Fake sink ───────────────────────────────────────────────────────────────
function fakeSink(refuse = new Set()) {
  const created = [];
  return {
    created,
    async createElement(type, params) {
      if (refuse.has(type)) return null;
      const id = `${type}-${created.length + 1}`;
      created.push({ id, type, params: JSON.parse(JSON.stringify(params)) });
      return id;
    },
  };
}
const boxMass = (w = 4, h = 3) => ({
  id: "mass-1", name: "Mass 1",
  basePolygon: [[0, 0], [w, 0], [w, w], [0, w]],
  height: h, color: "#a855f7", isVoid: false,
});

// ── Classifier ──────────────────────────────────────────────────────────────
t("C1 top face: small area → roof, large area → floor", () => {
  eq(M.classifyMassFace({ x: 0, y: 1, z: 0 }, 16, 0).suggestedType, "roof");
  eq(M.classifyMassFace({ x: 0, y: 1, z: 0 }, 60, 0).suggestedType, "floor");
});

t("C2 vertical face: small area → wall, large area → curtain-wall", () => {
  eq(M.classifyMassFace({ x: 1, y: 0, z: 0 }, 12, 0).suggestedType, "wall");
  eq(M.classifyMassFace({ x: 1, y: 0, z: 0 }, 40, 0).suggestedType, "curtain-wall");
});

t("C3 bottom face is foundation, not roof (the old code said roof)", () => {
  const c = M.classifyMassFace({ x: 0, y: -1, z: 0 }, 16, 0);
  eq(c.suggestedType, "foundation");
  if (!(c.confidence >= 0.9)) throw new Error(`foundation confidence ${c.confidence} is too low`);
});

t("C4 sloped face → roof", () => {
  eq(M.classifyMassFace({ x: 0, y: 0.6, z: 0.8 }, 10, 0).suggestedType, "roof");
});

// ── Conversion ──────────────────────────────────────────────────────────────
t("M1 4×4×3 box mass converts to 4 walls + 1 roof + 1 foundation slab", async () => {
  const sink = fakeSink();
  const r = await M.convertMassToElements(boxMass(), sink);
  eq(r.massId, "mass-1");
  eq(r.skipped, []);
  eq(r.created.length, 6);
  const byType = {};
  for (const c of r.created) byType[c.elementType] = (byType[c.elementType] ?? 0) + 1;
  eq(byType, { wall: 4, roof: 1, slab: 1 });
  // The slab is the foundation (bottom face, index 0); the roof is the top (index 1).
  const slab = r.created.find((c) => c.elementType === "slab");
  eq(slab.suggestedType, "foundation");
  eq(slab.faceIndex, 0);
  const roof = r.created.find((c) => c.elementType === "roof");
  eq(roof.suggestedType, "roof");
  eq(roof.faceIndex, 1);
  for (const w of r.created.filter((c) => c.elementType === "wall")) {
    eq(w.suggestedType, "wall");
    if (!(w.areaM2 === 12)) throw new Error(`wall face area ${w.areaM2} !== 12 (4 m edge × 3 m height)`);
  }
});

t("M2 wall params follow the polygon edges; slab/roof carry the footprint", async () => {
  const sink = fakeSink();
  await M.convertMassToElements(boxMass(), sink);
  const walls = sink.created.filter((c) => c.type === "wall");
  eq(walls.map((w) => [w.params.start, w.params.end]), [
    [[0, 0], [4, 0]],
    [[4, 0], [4, 4]],
    [[4, 4], [0, 4]],
    [[0, 4], [0, 0]],
  ]);
  for (const w of walls) {
    eq(w.params.elevation, 0);
    eq(w.params.height, 3);
  }
  const slab = sink.created.find((c) => c.type === "slab");
  eq(slab.params.polygon, [[0, 0], [4, 0], [4, 4], [0, 4]]);
  eq(slab.params.elevation, 0);
  const roof = sink.created.find((c) => c.type === "roof");
  eq(roof.params.polygon, [[0, 0], [4, 0], [4, 4], [0, 4]]);
  eq(roof.params.elevation, 3);
});

t("M3 large top face becomes a floor slab, large sides become curtain walls", async () => {
  const sink = fakeSink();
  const r = await M.convertMassToElements(boxMass(10, 4), sink);
  const byType = {};
  for (const c of r.created) byType[c.elementType] = (byType[c.elementType] ?? 0) + 1;
  eq(byType, { "curtain-wall": 4, slab: 2 }); // top floor slab + foundation slab
  const top = r.created.find((c) => c.faceIndex === 1);
  eq(top.suggestedType, "floor");
  eq(top.elementType, "slab");
});

t("M4 a refused face is skipped, not fatal — the rest still converts", async () => {
  const sink = fakeSink(new Set(["roof"]));
  const r = await M.convertMassToElements(boxMass(), sink);
  eq(r.created.length, 5);
  eq(r.skipped.length, 1);
  eq(r.skipped[0].faceIndex, 1);
  eq(r.skipped[0].suggestedType, "roof");
});

t("M5 a throwing sink is reported as skipped with the reason", async () => {
  const sink = {
    async createElement(type) {
      if (type === "wall") throw new Error("wall creation exploded");
      return `${type}-x`;
    },
  };
  const r = await M.convertMassToElements(boxMass(), sink);
  eq(r.created.length, 2); // roof + foundation
  eq(r.skipped.length, 4);
  if (!r.skipped.every((s) => /exploded/.test(s.reason))) throw new Error("skipped reason lost the sink error");
});

t("M6 degenerate masses throw: too few points, zero area, no height", async () => {
  const sink = fakeSink();
  await assert.rejects(
    M.convertMassToElements({ id: "m", name: "M", basePolygon: [[0, 0], [1, 0]], height: 3, color: "#000", isVoid: false }, sink),
    /≥ 3 points/,
  );
  await assert.rejects(
    M.convertMassToElements({ id: "m", name: "M", basePolygon: [[0, 0], [1, 0], [2, 0]], height: 3, color: "#000", isVoid: false }, sink),
    /zero footprint area/,
  );
  await assert.rejects(
    M.convertMassToElements({ ...boxMass(), height: 0 }, sink),
    /positive height/,
  );
});

t("M7 degenerate polygon edge (zero length) is skipped, the face is not built", async () => {
  const sink = fakeSink();
  const mass = {
    id: "m", name: "M",
    basePolygon: [[0, 0], [4, 0], [4, 0], [4, 4], [0, 4]],
    height: 3, color: "#000", isVoid: false,
  };
  const r = await M.convertMassToElements(mass, sink);
  eq(r.created.filter((c) => c.elementType === "wall").length, 4);
  eq(r.skipped, []);
});

(async () => {
  await Promise.all(pending);
  console.log(`\nmass-to-elements: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
