#!/usr/bin/env node
/**
 * Annotate distinctions — Revit 2D environment audit gap G7.
 *
 * Two layers, same style as tests/auto-dim-chains.test.cjs:
 *  1. The distinction model itself is EXECUTED: src/modules/views/
 *     annotate-distinctions.ts is a pure, DOM-free module compiled with tsc
 *     and required here.
 *  2. Source pins prove the ribbon and the plan view actually use that
 *     model — Diameter/Slope/Continuous/Baseline call distinct plan tools,
 *     each tag mode calls its own tool, Insulation emits batting segments.
 *
 * What is pinned, and why it matters (audit §2 G7):
 * - Tag modes: Material / Room / Space / Multi-Category / Area no longer
 *   all call setTool("tag"). Room tags only tag rooms, Area tags only tag
 *   areas, Space tags nothing (no space model exists — recorded, not faked).
 * - Continuous chains segments end-to-end; Baseline measures every target
 *   from the first picked boundary.
 * - Diameter is its own dimension type (Ø = 2R, solid line) — the engine
 *   already had it; the ribbon aliased it to Radial. Slope is a new
 *   dimension type that only exists where the element itself is sloped.
 * - Detail Line stays a plain line; Insulation renders as batting.
 *
 * Sensitivity: on the pre-G7 tree this fails — there is no
 * annotate-distinctions.ts to compile, the ribbon calls setTool("tag")
 * for every tag mode, Diameter calls dim-radial, Slope calls spot-elev,
 * and Continuous/Baseline both call dim-aligned.
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "g7-"));
execSync(`npx tsc src/modules/views/annotate-distinctions.ts src/modules/plan/plan-commands.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`, { stdio: "inherit", cwd: root });
const m = require(path.join(out, "views/annotate-distinctions.js"));
const cmds = require(path.join(out, "plan/plan-commands.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

const wall = { id: "w1", type: "wall", name: "Wall 1", properties: { Mark: "W-1", Material: "Concrete" }, params: { start: [0, 0], end: [6, 0], thickness: 0.2 } };
const duct = { id: "d1", type: "duct", name: "Duct 1", properties: { Mark: "D-2", Material: "Galvanised steel" }, params: { start: [0, 0], end: [4, 0], width: 0.3, elevation: 3 } };
const door = { id: "dr1", type: "door", name: "Door 1", properties: { Mark: "D-101" }, params: { point: [2, 0] } };

// ── Tag modes ────────────────────────────────────────────────────────────
t("category/material/multi accept any authored element", () => {
  for (const mode of ["category", "material", "multi"]) {
    for (const el of [wall, duct, door]) assert.ok(m.tagModeAcceptsElement(mode, el.type), `${mode} should accept ${el.type}`);
  }
});
t("room/area/space accept no authored element", () => {
  for (const mode of ["room", "area", "space"]) {
    for (const el of [wall, duct, door]) assert.ok(!m.tagModeAcceptsElement(mode, el.type), `${mode} must not accept ${el.type}`);
  }
});
t("material tag renders the material, not the mark", () => {
  assert.strictEqual(m.tagModeLabel("material", wall), "Concrete");
  assert.strictEqual(m.tagModeLabel("material", { id: "x", type: "wall", properties: {}, params: {} }), "Material");
});
t("multi-category tag renders category + mark", () => {
  assert.strictEqual(m.tagModeLabel("multi", wall), "Wall: W-1");
  assert.strictEqual(m.tagModeLabel("multi", duct), "Duct: D-2");
});
t("category tag renders the mark", () => { assert.strictEqual(m.tagModeLabel("category", wall), "W-1"); });
t("space tag records why it is not done", () => {
  assert.strictEqual(m.TAG_MODE_DEFS.space.accepts, "none");
  assert.ok(/no space model/i.test(m.TAG_MODE_DEFS.space.notDoneReason), "reason must name the missing space model");
});
t("room tag label is number + name", () => {
  assert.strictEqual(m.roomTagLabel({ id: "r1", name: "Office", number: "101", boundary: [], area: 24 }), "Room 101 Office");
});
t("area tag label carries the area", () => {
  assert.strictEqual(m.areaTagLabel({ id: "a1", name: "Rentable", number: "001", boundary: [], area: 24 }), "Area 001 Rentable — 24.0 m²");
});
t("roomAtPoint finds the room containing the click, and only it", () => {
  const rooms = [
    { id: "r1", name: "A", number: "1", boundary: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }, { x: 0, z: 3 }], area: 12 },
    { id: "r2", name: "B", number: "2", boundary: [{ x: 5, z: 0 }, { x: 9, z: 0 }, { x: 9, z: 3 }, { x: 5, z: 3 }], area: 12 },
  ];
  assert.strictEqual(m.roomAtPoint(rooms, 2, 1.5).id, "r1");
  assert.strictEqual(m.roomAtPoint(rooms, 7, 1.5).id, "r2");
  assert.strictEqual(m.roomAtPoint(rooms, 4.5, 1.5), null);
  assert.strictEqual(m.roomAtPoint(rooms, 2, 9), null);
});
t("areaAtPoint mirrors roomAtPoint for areas", () => {
  const areas = [{ id: "a1", name: "G", number: "1", boundary: [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 3 }, { x: 0, z: 3 }], area: 12 }];
  assert.strictEqual(m.areaAtPoint(areas, 2, 1).id, "a1");
  assert.strictEqual(m.areaAtPoint(areas, 9, 9), null);
});

// ── Chains: Continuous vs Baseline ────────────────────────────────────────
const pts = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 7, z: 0 }, { x: 10, z: 0 }];
t("aligned chain line runs along the first two boundaries, offset to the side", () => {
  const line = m.chainLineForPoints(pts, false, undefined, 0.5);
  near(line.ux, 1); near(line.uz, 0); near(line.oz, 0.5);
});
t("linear chain line is horizontal for a mostly-horizontal run", () => {
  const line = m.chainLineForPoints(pts, true, undefined, 0.5);
  assert.deepStrictEqual(line, { ox: 0, oz: -0.5, ux: 1, uz: 0 });
});
t("linear chain line is vertical for a mostly-vertical run", () => {
  const v = [{ x: 0, z: 0 }, { x: 0, z: 4 }, { x: 0, z: 7 }];
  const line = m.chainLineForPoints(v, true, undefined, 0.5);
  assert.deepStrictEqual(line, { ox: -0.5, oz: 0, ux: 0, uz: 1 });
});
t("continuous chains segments end-to-end", () => {
  const line = m.chainLineForPoints(pts, false, undefined, 0.5);
  const segs = m.chainSegments(pts, "continuous", line);
  assert.strictEqual(segs.length, 3);
  assert.deepStrictEqual(segs.map((s) => [s.i1, s.i2]), [[0, 1], [1, 2], [2, 3]]);
  near(segs[0].x2, segs[1].x1); near(segs[1].x2, segs[2].x1);
});
t("baseline measures every target from the first boundary", () => {
  const line = m.chainLineForPoints(pts, false, undefined, 0.5);
  const segs = m.chainSegments(pts, "baseline", line);
  assert.strictEqual(segs.length, 3);
  assert.deepStrictEqual(segs.map((s) => [s.i1, s.i2]), [[0, 1], [0, 2], [0, 3]]);
  for (const s of segs) { near(s.x1, 0); }
  near(segs[2].x2, 10);
});
t("continuous and baseline differ on the same picks", () => {
  const line = m.chainLineForPoints(pts, false, undefined, 0.5);
  const c = m.chainSegments(pts, "continuous", line);
  const b = m.chainSegments(pts, "baseline", line);
  assert.notDeepStrictEqual(c, b);
});
t("a target with zero length along the line is skipped", () => {
  // Baseline: the third pick sits directly across from the origin, so it
  // projects to zero on the dimension line and is skipped.
  const p = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 0, z: 2 }];
  const line = m.chainLineForPoints(p, false, undefined, 0.5);
  assert.strictEqual(m.chainSegments(p, "baseline", line).length, 1);
  // Continuous: a consecutive pair straight across the line (no run along
  // it) is skipped the same way.
  const q = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 2 }];
  const lineQ = m.chainLineForPoints(q, false, undefined, 0.5);
  assert.strictEqual(m.chainSegments(q, "continuous", lineQ).length, 1);
});
t("a duplicate pick is skipped", () => {
  const p = [{ x: 0, z: 0 }, { x: 4, z: 0 }, { x: 4, z: 0 }, { x: 7, z: 0 }];
  const line = m.chainLineForPoints(p, false, undefined, 0.5);
  assert.strictEqual(m.chainSegments(p, "continuous", line).length, 2);
});

// ── Slope ────────────────────────────────────────────────────────────────
t("sloped duct run reports rise over run", () => {
  const sloped = { ...duct, params: { ...duct.params, endElevation: 3.2 } };
  const s = m.slopeOfElement(sloped);
  assert.ok(s);
  near(s.percent, 5);
  near(s.ratio, 20);
  near(s.x1, 0); near(s.x2, 4);
});
t("flat duct (no end elevation) has no slope", () => {
  assert.strictEqual(m.slopeOfElement(duct), null);
});
t("level duct (end elevation equals start) has no slope", () => {
  const flat = { ...duct, params: { ...duct.params, endElevation: 3 } };
  assert.strictEqual(m.slopeOfElement(flat), null);
});
t("a wall has no slope", () => { assert.strictEqual(m.slopeOfElement(wall), null); });
t("sloped floor reports properties.slope", () => {
  const floor = { id: "f1", type: "slab", properties: { slope: 2, slopeDirection: 0 }, params: { polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] } };
  const s = m.slopeOfElement(floor);
  assert.ok(s);
  near(s.percent, 2);
});
t("slope label shows arrow, percent and 1:N", () => {
  assert.strictEqual(m.slopeLabel(2), "↗ 2.00%  1:50");
  assert.strictEqual(m.slopeLabel(-1.5), "↘ 1.50%  1:67");
});

// ── Insulation batting ───────────────────────────────────────────────────
t("batting starts and ends on the centreline", () => {
  const pts2 = m.insulationBattingPoints(0, 0, 3, 0);
  near(pts2[0].x, 0); near(pts2[0].z, 0);
  near(pts2[pts2.length - 1].x, 3); near(pts2[pts2.length - 1].z, 0);
});
t("batting oscillates across the centreline in both directions", () => {
  const pts2 = m.insulationBattingPoints(0, 0, 3, 0);
  const offs = pts2.map((q) => q.z);
  assert.ok(Math.max(...offs) > 0.05, "wave must rise above the line");
  assert.ok(Math.min(...offs) < -0.05, "wave must dip below the line");
  assert.ok(Math.max(...offs) < 0.07 && Math.min(...offs) > -0.07, "amplitude must stay ~6 cm");
});
t("batting follows a diagonal run, not just horizontal", () => {
  const pts2 = m.insulationBattingPoints(0, 0, 3, 4);
  const mid = pts2[Math.floor(pts2.length / 2)];
  // midpoint of the run is (1.5, 2); the wave offset is perpendicular
  assert.ok(Math.abs(mid.x - 1.5) < 0.1 && Math.abs(mid.z - 2) < 0.1, `mid ${mid.x},${mid.z} should sit near (1.5, 2)`);
});

// ── Plan commands ────────────────────────────────────────────────────────
t("plan command line exposes the distinct G7 tools", () => {
  const byName = new Map(cmds.PLAN_COMMANDS.map((c) => [c.name, c.tool]));
  assert.strictEqual(byName.get("DIMCONTINUOUS"), "dim-continuous");
  assert.strictEqual(byName.get("DIMBASELINE"), "dim-baseline");
  assert.strictEqual(byName.get("DIMSLOPE"), "dim-slope");
  assert.strictEqual(byName.get("TAGMULTI"), "tag-multi");
  assert.strictEqual(byName.get("TAGAREA"), "tag-area");
  assert.strictEqual(byName.get("INSULATION"), "insulation");
  assert.strictEqual(byName.get("DIMDIAMETER"), "dim-diameter");
});

// ── Source pins: ribbon + plan view actually use the model ──────────────
const ribbon = fs.readFileSync(path.join(root, "src/shell/ribbon.ts"), "utf8");
const panel = fs.readFileSync(path.join(root, "src/features/plan-view-panel.ts"), "utf8");
const generator = fs.readFileSync(path.join(root, "src/modules/drawings/plan-generator.ts"), "utf8");
const pin = (n, re, src) => t(n, () => assert.ok(re.test(src), `missing: ${re}`));
pin("ribbon: Diameter activates dim-diameter (not dim-radial)", /"Diameter"[\s\S]{0,400}?setTool\?\.\("dim-diameter"\)/, ribbon);
pin("ribbon: Slope activates dim-slope (not spot-elev)", /"Slope"[\s\S]{0,400}?setTool\?\.\("dim-slope"\)/, ribbon);
pin("ribbon: Continuous activates dim-continuous", /"Continuous"[\s\S]{0,400}?setTool\?\.\("dim-continuous"\)/, ribbon);
pin("ribbon: Baseline activates dim-baseline", /"Baseline"[\s\S]{0,400}?setTool\?\.\("dim-baseline"\)/, ribbon);
pin("ribbon: Material activates tag-material", /"Material"[\s\S]{0,400}?setTool\?\.\("tag-material"\)/, ribbon);
pin("ribbon: Room tag activates room-tag", /"Room tag"[\s\S]{0,400}?setTool\?\.\("room-tag"\)/, ribbon);
pin("ribbon: Multi-Cat activates tag-multi", /"Multi-Cat"[\s\S]{0,400}?setTool\?\.\("tag-multi"\)/, ribbon);
pin("ribbon: Area activates tag-area", /"Area"[\s\S]{0,400}?setTool\?\.\("tag-area"\)/, ribbon);
pin("ribbon: Space is an honest stub, not the generic tag tool", /planned\("room-tag", "Space", "Space tags need a space model/, ribbon);
t("ribbon: only the plain Tag button still uses the generic tag tool", () => {
  const uses = ribbon.match(/setTool\?\.\("tag"\)/g) ?? [];
  assert.strictEqual(uses.length, 1, `expected 1 generic tag use, found ${uses.length}`);
});
pin("ribbon: Insulation routes to the insulation plan tool", /"Insulation"[\s\S]{0,400}?setTool\?\.\("insulation"\)/, ribbon);
pin("panel: setTool handles dim-continuous / dim-baseline / dim-slope", /tool === "dim-continuous" \|\| tool === "dim-baseline"/, panel);
pin("panel: setTool handles tag-multi / tag-area", /tool === "tag-multi" \|\| tool === "tag-area"/, panel);
pin("panel: chain commit uses the shared chain model", /chainSegments\(pts, planDimChainKind, line\)/, panel);
pin("panel: slope click places a slope dimension from the element", /planDimStyle === "slope"[\s\S]{0,600}?slopeOfElement\(hit\.element\)/, panel);
pin("panel: insulation segments render as batting", /s\.lineStyle === "insulation"[\s\S]{0,600}?data-obs-insulation/, panel);
pin("panel: room / area tags hit-test the rooms store", /roomAtPoint\(list, w\.x, w\.z\)/, panel);
pin("generator: insulation mline emits a batting segment", /lineStyle === "insulation"[\s\S]{0,300}?lineStyle: "insulation"/, generator);

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
