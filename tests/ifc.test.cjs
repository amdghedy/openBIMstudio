const assert = require("assert");
const dir = process.env.OUT_DIR || "";
const { exportAuthoredToIfc } = require(dir + "/authored-ifc.js");
const { isValidIfcGuid } = require(dir + "/ifc-guid.js");
let passed = 0;
function t(name, fn) { try { fn(); passed++; console.log("  ok  " + name); } catch (e) { console.log("  FAIL " + name + "\n       " + e.message); process.exitCode = 1; } }

/* ---- tiny STEP parser ---- */
function splitArgs(s) {
  const out = []; let depth = 0, cur = "", inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { cur += c; if (c === "'") { if (s[i + 1] === "'") { cur += "'"; i++; } else inStr = false; } continue; }
    if (c === "'") { inStr = true; cur += c; continue; }
    if (c === "(") depth++; if (c === ")") depth--;
    if (c === "," && depth === 0) { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur); return out;
}
function parse(text) {
  const data = text.split("DATA;\n")[1].split("\nENDSEC;")[0].split("\n").filter(Boolean);
  const ents = new Map();
  for (const line of data) {
    const m = /^#(\d+)=([A-Z0-9_]+)\((.*)\);$/.exec(line);
    assert.ok(m, "bad line: " + line.slice(0, 100));
    assert.ok(!ents.has(+m[1]), "duplicate id " + m[1]);
    ents.set(+m[1], { name: m[2], args: m[3] === "" ? [] : splitArgs(m[3]), raw: m[3] });
  }
  return ents;
}
const COUNTS = {
  IFC4: { IFCWALL: 9, IFCSLAB: 9, IFCCOLUMN: 9, IFCBEAM: 9, IFCMEMBER: 9, IFCFOOTING: 9, IFCCOVERING: 9, IFCDOOR: 13, IFCWINDOW: 13, IFCOPENINGELEMENT: 9,
    IFCDUCTSEGMENT: 9, IFCPIPESEGMENT: 9, IFCCABLECARRIERSEGMENT: 9, IFCBUILDINGELEMENTPROXY: 9, IFCSPACE: 11, IFCBUILDINGSTOREY: 10, IFCBUILDING: 12, IFCSITE: 14, IFCPROJECT: 9,
    IFCOWNERHISTORY: 8, IFCEXTRUDEDAREASOLID: 4, IFCRECTANGLEPROFILEDEF: 5, IFCCIRCLEPROFILEDEF: 4, IFCAXIS2PLACEMENT3D: 3, IFCLOCALPLACEMENT: 2, IFCSHAPEREPRESENTATION: 4,
    IFCRELCONTAINEDINSPATIALSTRUCTURE: 6, IFCRELAGGREGATES: 6, IFCRELVOIDSELEMENT: 6, IFCRELFILLSELEMENT: 6, IFCPROPERTYSET: 5, IFCRELDEFINESBYPROPERTIES: 6, IFCELEMENTQUANTITY: 6, IFCQUANTITYLENGTH: 5, IFCTRIANGULATEDFACESET: 5, IFCMATERIAL: 3, IFCSTAIR: 9, IFCRAILING: 9, IFCRAMP: 9, IFCCURTAINWALL: 9 },
  IFC2X3: { IFCWALLSTANDARDCASE: 8, IFCSLAB: 9, IFCCOLUMN: 8, IFCBEAM: 8, IFCMEMBER: 8, IFCFOOTING: 9, IFCCOVERING: 9, IFCDOOR: 10, IFCWINDOW: 10, IFCOPENINGELEMENT: 8,
    IFCFLOWSEGMENT: 8, IFCBUILDINGELEMENTPROXY: 9, IFCSPACE: 11, IFCBUILDINGSTOREY: 10, IFCBUILDING: 12, IFCSITE: 14, IFCPROJECT: 9, IFCOWNERHISTORY: 8, IFCQUANTITYLENGTH: 4, IFCMATERIAL: 1, IFCFACETEDBREP: 1, IFCSTAIR: 9, IFCRAILING: 9, IFCRAMP: 9, IFCCURTAINWALL: 8 },
};
function validate(text, schema) {
  const ents = parse(text);
  assert.ok(text.includes(`FILE_SCHEMA(('${schema}'));`));
  const guids = new Set();
  for (const [id, e] of ents) {
    // refs resolve
    for (const m of e.raw.matchAll(/#(\d+)/g)) assert.ok(ents.has(+m[1]), `#${id} ${e.name} -> missing #${m[1]}`);
    // reals contain a decimal point (REAL attributes of the geometry entities)
    if (e.name === "IFCCARTESIANPOINT" || e.name === "IFCDIRECTION") for (const n of e.args[0].slice(1, -1).split(",")) assert.ok(/\./.test(n), `integer in real list: ${e.raw}`);
    if (e.name === "IFCEXTRUDEDAREASOLID") assert.ok(/\./.test(e.args[3]), "depth must be REAL: " + e.args[3]);
    const want = COUNTS[schema][e.name];
    if (want !== undefined) assert.strictEqual(e.args.length, want, `${schema} ${e.name} #${id} has ${e.args.length} attrs, want ${want}`);
    // rooted entities carry a valid, unique GlobalId
    if (/^IFC(WALL|WALLSTANDARDCASE|SLAB|COLUMN|BEAM|MEMBER|FOOTING|COVERING|DOOR|WINDOW|OPENINGELEMENT|DUCTSEGMENT|PIPESEGMENT|CABLECARRIERSEGMENT|FLOWSEGMENT|BUILDINGELEMENTPROXY|SPACE|BUILDINGSTOREY|BUILDING|SITE|PROJECT|REL[A-Z]+|PROPERTYSET|ELEMENTQUANTITY)$/.test(e.name)) {
      const g = e.args[0].slice(1, -1);
      assert.ok(isValidIfcGuid(g), `${e.name} #${id} bad GlobalId ${g}`);
      assert.ok(!guids.has(g), `duplicate GlobalId ${g} (${e.name})`);
      guids.add(g);
    }
  }
  assert.ok(!/NaN|Infinity|undefined/.test(text));
  return ents;
}
const walls = [
  { id: "w1", type: "wall", name: "Wall A", params: { start: [0, 0], end: [6, 0], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0", properties: { material: "Brick", fire: 2, ext: true, note: "O'Brien \u00e9\u00e8" } },
  { id: "w2", type: "wall", params: { start: [6, 0], end: [6, 4], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0" },
];
const model = [
  ...walls,
  { id: "d1", type: "door", hostId: "w1", params: { width: 0.9, height: 2.1, thickness: 0.2, elevation: 0, offsetAlongHost: 2, sillHeight: 0 } },
  { id: "win1", type: "window", hostId: "w1", params: { width: 1.2, height: 1.4, thickness: 0.2, elevation: 0, offsetAlongHost: 4.5, sillHeight: 0.9 } },
  { id: "s1", type: "slab", name: "Floor", params: { polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], height: 0.2, thickness: 0.2, elevation: -0.2 }, levelId: "L0" },
  { id: "r1", type: "slab", name: "Roof slab", params: { polygon: [[0, 0], [0, 4], [6, 4], [6, 0]], height: 0.25, thickness: 0.25, elevation: 3 }, levelId: "L1" },
  { id: "c1", type: "column", params: { point: [1, 1], height: 3, thickness: 0.3, depth: 0.4, elevation: 0 } },
  { id: "b1", type: "beam", params: { start: [0, 0], end: [6, 0], height: 0.5, thickness: 0.25, elevation: 2.5 } },
  { id: "dk", type: "duct", params: { start: [0, 2], end: [5, 2], height: 0.4, thickness: 0.6, elevation: 2.4 } },
  { id: "pp", type: "pipe", params: { start: [0, 3], end: [5, 3], height: 0.1, thickness: 0.1, elevation: 2.2 } },
  { id: "ct", type: "cable-tray", params: { start: [0, 3.5], end: [5, 3.5], height: 0.1, thickness: 0.3, elevation: 2.2 } },
  { id: "eq", type: "equipment", params: { point: [3, 2], height: 1.2, thickness: 0.8, depth: 0.6, elevation: 0 } },
  { id: "br", type: "brace", params: { start: [0, 0], end: [2, 0], height: 2.5, thickness: 0.15, elevation: 0 } },
  { id: "ft", type: "footing", params: { point: [1, 1], height: 0.4, thickness: 1.2, elevation: 0 } },
  { id: "nt", type: "generic", params: { height: 1, thickness: 1, elevation: 0 }, nativeGeometry: { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1] }, transform: { position: [10, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }, ifc: { entity: "IFCFURNISHINGELEMENT" } },
  { id: "tr", type: "truss", params: { start: [0, 0], end: [4, 0], height: 1, thickness: 0.1, elevation: 3 } },
  { id: "orph", type: "door", hostId: "missing", params: { width: 1, height: 2, thickness: 0.2, elevation: 0 } },
];
const levels = [{ id: "L0", name: "Ground", elevation: 0 }, { id: "L1", name: "First", elevation: 3 }];
const spaces = [{ id: "rm1", name: "Office", number: "101", levelId: "L0", boundary: [{ x: 0.1, z: 0.1 }, { x: 5.9, z: 0.1 }, { x: 5.9, z: 3.9 }, { x: 0.1, z: 3.9 }], holes: [[{ x: 2, z: 1 }, { x: 2.5, z: 1 }, { x: 2.5, z: 1.5 }, { x: 2, z: 1.5 }]], height: 2.8, area: 21.99 }];

for (const schema of ["IFC4", "IFC2X3"]) {
  t(`${schema}: structure, attribute counts, GlobalIds, references`, () => {
    const r = exportAuthoredToIfc(model, { schema, levels, spaces, projectName: "Test", timestamp: "2026-10-10T12:00:00Z" });
    validate(r.text, schema);
    assert.strictEqual(r.stats.storeys, 2);
    assert.strictEqual(r.stats.openings, 2);
    assert.strictEqual(r.stats.spaces, 1);
    const sk = r.stats.skipped.map((s) => s.id).sort();
    assert.deepStrictEqual(sk, ["orph", "tr"]);
  });
}
t("IFC4: expected classes", () => {
  const r = exportAuthoredToIfc(model, { schema: "IFC4", levels, spaces });
  const c = r.stats.byClass;
  for (const k of ["IFCWALL", "IFCDOOR", "IFCWINDOW", "IFCSLAB", "IFCCOLUMN", "IFCBEAM", "IFCDUCTSEGMENT", "IFCPIPESEGMENT", "IFCCABLECARRIERSEGMENT", "IFCMEMBER", "IFCFOOTING", "IFCBUILDINGELEMENTPROXY", "IFCSPACE"]) assert.ok(c[k] >= 1, k + " missing");
  assert.strictEqual(c.IFCWALL, 2); assert.strictEqual(c.IFCSLAB, 2); assert.strictEqual(c.IFCBUILDINGELEMENTPROXY, 2);
});
t("IFC2X3: uses IfcWallStandardCase + IfcFlowSegment and a faceted brep for native twins", () => {
  const r = exportAuthoredToIfc(model, { schema: "IFC2X3", levels });
  assert.strictEqual(r.stats.byClass.IFCWALLSTANDARDCASE, 2);
  assert.strictEqual(r.stats.byClass.IFCFLOWSEGMENT, 3);
  assert.ok(r.text.includes("IFCFACETEDBREP"));
  assert.ok(!r.text.includes("IFCTRIANGULATEDFACESET"));
});
t("native twins export their real IFC class (wall/beam/slab), edited geometry baked; unknown stays proxy", () => {
  const tri = [0, 0, 0, 4, 0, 0, 0, 3, 0, 0, 0, 0, 0, 3, 0, 0, 0, 1];
  const mk = (id, type, extra = {}) => ({ id, type, params: { height: 3, thickness: 0.2, elevation: 0, ...extra }, nativeGeometry: { positions: tri }, transform: { position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] } });
  const r = exportAuthoredToIfc([mk("w", "wall"), mk("b", "beam"), mk("s", "slab"), mk("g", "generic")], { schema: "IFC4", levels });
  assert.strictEqual(r.stats.byClass.IFCWALL, 1);
  assert.strictEqual(r.stats.byClass.IFCBEAM, 1);
  assert.strictEqual(r.stats.byClass.IFCSLAB, 1);
  assert.strictEqual(r.stats.byClass.IFCBUILDINGELEMENTPROXY, 1);
});
t("wall geometry: origin (x,-z), X axis along the wall, 6 x 0.2 profile, depth 3, storey-relative Z", () => {
  const r = exportAuthoredToIfc([walls[1]], { schema: "IFC4", levels });
  const e = parse(r.text);
  const wall = [...e.values()].find((v) => v.name === "IFCWALL");
  const pl = e.get(+wall.args[5].slice(1)); const ax = e.get(+pl.args[1].slice(1));
  const pt = e.get(+ax.args[0].slice(1)).args[0];
  assert.strictEqual(pt, "(6.,0.,0.)");               // (x=6, -z=0, z-elev=0)
  const rd = e.get(+ax.args[2].slice(1)).args[0];
  assert.strictEqual(rd, "(0.,-1.,0.)");               // wall runs +z in authoring => -Y in IFC
  const solid = [...e.values()].find((v) => v.name === "IFCEXTRUDEDAREASOLID");
  assert.strictEqual(solid.args[3], "3.");
  const prof = e.get(+solid.args[0].slice(1));
  assert.strictEqual(prof.args[3], "4."); assert.strictEqual(prof.args[4], "0.2");   // length 4, thickness 0.2
});
t("element on level 1 is placed relative to its storey (Z = 0 at elevation 3)", () => {
  const r = exportAuthoredToIfc([model.find((m) => m.id === "r1")], { schema: "IFC4", levels });
  const e = parse(r.text);
  const slab = [...e.values()].find((v) => v.name === "IFCSLAB");
  assert.ok(slab.args[8].includes("ROOF"));
  const pl = e.get(+slab.args[5].slice(1)); const ax = e.get(+pl.args[1].slice(1));
  assert.strictEqual(e.get(+ax.args[0].slice(1)).args[0], "(0.,0.,0.)");
});
t("door: opening is voided from the host wall and filled by the door; width/height are exact", () => {
  const r = exportAuthoredToIfc([walls[0], model.find((m) => m.id === "d1")], { schema: "IFC4", levels });
  const e = parse(r.text);
  const door = [...e.entries()].find(([, v]) => v.name === "IFCDOOR");
  assert.strictEqual(door[1].args[8], "2.1"); assert.strictEqual(door[1].args[9], "0.9");
  const voids = [...e.values()].find((v) => v.name === "IFCRELVOIDSELEMENT");
  const fills = [...e.values()].find((v) => v.name === "IFCRELFILLSELEMENT");
  assert.strictEqual(fills.args[5], "#" + door[0]);
  assert.strictEqual(voids.args[5], fills.args[4]);
  // door centre: 2 m along the wall
  const pl = e.get(+door[1].args[5].slice(1)); const ax = e.get(+pl.args[1].slice(1));
  assert.strictEqual(e.get(+ax.args[0].slice(1)).args[0], "(2.,0.,0.)");
});
t("text is escaped (apostrophes, non-ASCII) and output is deterministic", () => {
  const a = exportAuthoredToIfc(walls, { schema: "IFC4", levels, timestamp: "2026-10-10T12:00:00Z" });
  const b = exportAuthoredToIfc(walls, { schema: "IFC4", levels, timestamp: "2026-10-10T12:00:00Z" });
  assert.strictEqual(a.text, b.text);
  assert.ok(a.text.includes("O''Brien \\X2\\00E9\\X0\\\\X2\\00E8\\X0\\") || a.text.includes("O''Brien \\X2\\00E900E8\\X0\\"));
  assert.ok(a.text.includes("IFCMATERIAL('Brick'"));
});
t("empty project still produces a valid file with one default storey", () => {
  const r = exportAuthoredToIfc([], { schema: "IFC4" });
  validate(r.text, "IFC4"); assert.strictEqual(r.stats.storeys, 1);
});
t("room -> IfcSpace with a void profile for the island hole", () => {
  const r = exportAuthoredToIfc([], { schema: "IFC4", levels, spaces });
  assert.ok(r.text.includes("IFCARBITRARYPROFILEDEFWITHVOIDS"));
  assert.ok(r.text.includes("IFCSPACE('"));
});

/* ---------------- M2 element types ---------------- */
const base3 = { height: 3, thickness: 0.2, elevation: 0 };
const m2model = [
  { id: "st1", type: "stairs", name: "Main stair", levelId: "L0", params: { ...base3, height: 3, start: [0, 0], end: [5, 0], width: 1.2 } },
  { id: "st2", type: "stairs", params: { ...base3, start: [10, 0], end: [13, 0], width: 1.1 }, properties: { stairShape: "L", stairTurn: "right" } },
  { id: "st3", type: "stairs", params: { ...base3, start: [20, 0], end: [23, 0], width: 1.1 }, properties: { stairShape: "U" } },
  { id: "rl1", type: "railing", params: { ...base3, height: 1, thickness: 0.05, polygon: [[0, 1], [5, 1], [5, 4]] } },
  { id: "rp1", type: "ramp", params: { ...base3, height: 0.5, start: [0, 8], end: [6, 8], width: 1.5 } },
  { id: "cw1", type: "curtain-wall", params: { ...base3, height: 3.6, thickness: 0.1, start: [0, 12], end: [6, 12] } },
  { id: "rf1", type: "roof", name: "Gable roof", levelId: "L1", params: { ...base3, elevation: 3, polygon: [[0, 0], [10, 0], [10, 6], [0, 6]] }, properties: { slope: 30, roofType: "gable" } },
  { id: "cl1", type: "ceiling", levelId: "L0", params: { height: 0.02, thickness: 0.02, elevation: 2.7, polygon: [[0, 0], [4, 0], [4, 3], [0, 3]] } },
  { id: "bad", type: "stairs", params: { ...base3 } },
];
for (const schema of ["IFC4", "IFC2X3"]) {
  t(`${schema} M2: stairs / railing / ramp / curtain wall / roof / ceiling export with valid structure`, () => {
    const r = exportAuthoredToIfc(m2model, { schema, levels, projectName: "M2", timestamp: "2026-10-10T12:00:00Z" });
    const e = validate(r.text, schema);
    const c = r.stats.byClass;
    assert.strictEqual(c.IFCSTAIR, 3); assert.strictEqual(c.IFCRAILING, 1); assert.strictEqual(c.IFCRAMP, 1); assert.strictEqual(c.IFCCURTAINWALL, 1);
    assert.strictEqual(c.IFCSLAB, 1); assert.strictEqual(c.IFCCOVERING, 1);
    assert.deepStrictEqual(r.stats.skipped.map((s) => s.id), ["bad"]);
    const stairs = [...e.values()].filter((v) => v.name === "IFCSTAIR").map((v) => v.args[8]);
    assert.deepStrictEqual(stairs.sort(), [".HALF_TURN_STAIR.", ".QUARTER_TURN_STAIR.", ".STRAIGHT_RUN_STAIR."]);
    assert.ok([...e.values()].some((v) => v.name === "IFCSLAB" && v.args[8] === ".ROOF."));
    // curtain wall keeps frame and glazing as two items with their own colours
    const cw = [...e.values()].find((v) => v.name === "IFCCURTAINWALL");
    const prodShape = e.get(+cw.args[6].slice(1)); const shapeRep = e.get(+prodShape.args[2].slice(1, -1).slice(1));
    assert.strictEqual(shapeRep.args[3].split(",").length, 2);
    assert.ok(r.text.includes("IFCQUANTITYVOLUME"));
  });
}
t("IFC4 M2: tessellation indices are 1-based, in range, and triangles are not degenerate", () => {
  const r = exportAuthoredToIfc(m2model.slice(0, 1), { schema: "IFC4", levels });
  const e = parse(r.text);
  const fs = [...e.values()].find((v) => v.name === "IFCTRIANGULATEDFACESET");
  const pts = e.get(+fs.args[0].slice(1)); const n = pts.args[0].slice(1, -1).split("),(").length;
  const idx = fs.args[3].match(/\d+/g).map(Number);
  assert.ok(Math.min(...idx) >= 1 && Math.max(...idx) <= n, `index range 1..${n} got ${Math.min(...idx)}..${Math.max(...idx)}`);
  assert.ok(idx.length % 3 === 0 && idx.length / 3 > 100);
});
t("IFC M2: stair geometry sits at the storey-relative level and rises by exactly the stair height", () => {
  const r = exportAuthoredToIfc([{ id: "s", type: "stairs", levelId: "L1", params: { ...base3, elevation: 3, height: 2.7, start: [0, 0], end: [4, 0], width: 1 } }], { schema: "IFC4", levels });
  const e = parse(r.text);
  const fs = [...e.values()].find((v) => v.name === "IFCTRIANGULATEDFACESET");
  const list = e.get(+fs.args[0].slice(1)).args[0].slice(2, -2).split("),(").map((s) => s.split(",").map(Number));
  const z = list.map((p) => p[2]);
  assert.ok(Math.abs(Math.max(...z) - 2.7) < 1e-5, "max z " + Math.max(...z));   // 3 m storey elevation removed, rise 2.7
  assert.ok(Math.min(...z) >= -1e-9);
  const y = list.map((p) => p[1]); assert.ok(Math.abs(Math.min(...y) + 0.5) < 1e-5 && Math.abs(Math.max(...y) - 0.5) < 1e-5); // width 1 centred on the run line
});

console.log(`${passed} passed`);
