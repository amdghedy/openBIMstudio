/**
 * tests/cad-link.test.cjs
 *
 * CAD import / link pipeline (pure parts): DXF reader, libredwg-web database
 * converter, ACI colours, and the Revit-style placement + geometry core.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cadlink-test-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
execSync(
  `npx tsc --rootDir src --outDir "${out}" --module commonjs --target ES2022 --moduleResolution node --lib es2022,dom --skipLibCheck --noCheck ` +
  "src/modules/drawings/aci.ts src/modules/drawings/dxf-types.ts src/modules/drawings/dxf-geometry.ts " +
  "src/modules/drawings/dxf-reader.ts src/modules/drawings/dwg-convert.ts src/modules/cad-link/core.ts",
  { cwd: root, stdio: "inherit" },
);

const { parseDxf } = require(path.join(out, "modules/drawings/dxf-reader.js"));
const { dwgDatabaseToDxfDocument } = require(path.join(out, "modules/drawings/dwg-convert.js"));
const { aciToRgb } = require(path.join(out, "modules/drawings/aci.js"));
const core = require(path.join(out, "modules/cad-link/core.js"));

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("  PASS " + name); }
  catch (e) { failed++; console.log("  FAIL " + name + "\n       " + (e && e.message)); }
}
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ~ ${b}`);

/* ---- tiny DXF writer for fixtures ---- */
const P = (code, value) => `${code}\n${value}\n`;
const ent = (type, ...pairs) => P(0, type) + pairs.map(([c, v]) => P(c, v)).join("");
const section = (name, body) => P(0, "SECTION") + P(2, name) + body + P(0, "ENDSEC");
const header = (insunits) => section("HEADER", P(9, "$INSUNITS") + P(70, insunits));
const tables = (layers) =>
  section("TABLES", P(0, "TABLE") + P(2, "LAYER") +
    layers.map(([n, c, f]) => ent("LAYER", [2, n], [70, f || 0], [62, c])).join("") + P(0, "ENDTAB"));
const blocks = (list) =>
  section("BLOCKS", list.map(([name, base, body]) =>
    ent("BLOCK", [2, name], [10, base[0]], [20, base[1]], [30, 0]) + body + P(0, "ENDBLK")).join(""));
const entities = (body) => section("ENTITIES", body);
const file = (...s) => s.join("") + P(0, "EOF");

console.log("\n=== CAD link tests ===\n");

/* ---------------- ACI ---------------- */
t("ACI: named colours, hue ramp and greys", () => {
  assert.strictEqual(aciToRgb(1), 0xff0000);
  assert.strictEqual(aciToRgb(5), 0x0000ff);
  assert.strictEqual(aciToRgb(7, 0x123456), 0x123456, "7 = foreground");
  assert.strictEqual(aciToRgb(10), 0xff0000);
  assert.strictEqual(aciToRgb(250), 0x333333);
  const c11 = aciToRgb(11);
  assert.ok(Math.abs(((c11 >> 8) & 255) - 0x7f) <= 2, "ACI 11 is a tint of red");
});

/* ---------------- DXF reader ---------------- */
t("DXF: LINE, CIRCLE, ARC, units from $INSUNITS and extents", () => {
  const d = parseDxf(file(
    header(4),
    entities(
      ent("LINE", [8, "A"], [10, 0], [20, 0], [11, 1000], [21, 0]) +
      ent("CIRCLE", [8, "A"], [10, 500], [20, 500], [40, 100]) +
      ent("ARC", [8, "B"], [10, 0], [20, 0], [40, 50], [50, 0], [51, 90]),
    ),
  ));
  assert.strictEqual(d.units, "mm");
  assert.strictEqual(d.entities.length, 3);
  assert.strictEqual(d.entities[0].type, "LINE");
  near(d.extents.max.x, 1000);
  assert.ok(d.layers.some((l) => l.name === "A") && d.layers.some((l) => l.name === "B"), "layers inferred from entities");
});

t("DXF: layer table (colour, frozen, off) and true colour", () => {
  const d = parseDxf(file(
    tables([["WALLS", 3, 0], ["HIDDEN", 5, 1], ["OFF", -2, 0]]),
    entities(ent("LINE", [8, "WALLS"], [420, 0xff8800], [10, 0], [20, 0], [11, 1], [21, 1])),
  ));
  const by = (n) => d.layers.find((l) => l.name === n);
  assert.strictEqual(by("WALLS").color, 3);
  assert.strictEqual(by("HIDDEN").frozen, true);
  assert.strictEqual(by("OFF").off, true);
  assert.strictEqual(by("OFF").color, 2);
  assert.strictEqual(d.entities[0].rgb, 0xff8800);
});

t("DXF: LWPOLYLINE bulge becomes a true arc (semicircle)", () => {
  const d = parseDxf(file(entities(
    ent("LWPOLYLINE", [8, "0"], [70, 0], [90, 2], [10, 0], [20, 0], [42, 1], [10, 2], [20, 0]),
  )));
  const pts = d.entities[0].points;
  assert.ok(pts.length > 8, "tessellated");
  for (const p of pts) near(Math.hypot(p.x - 1, p.y), 1, 1e-9);
  near(Math.min(...pts.map((p) => p.y)), -1, 1e-6); // positive bulge = CCW, dips below the chord
});

t("DXF: old-style POLYLINE with VERTEX records, closed", () => {
  const d = parseDxf(file(entities(
    ent("POLYLINE", [8, "0"], [70, 1]) +
    ent("VERTEX", [8, "0"], [10, 0], [20, 0]) +
    ent("VERTEX", [8, "0"], [10, 4], [20, 0]) +
    ent("VERTEX", [8, "0"], [10, 4], [20, 3]) +
    ent("SEQEND") +
    ent("LINE", [8, "0"], [10, 9], [20, 9], [11, 10], [21, 10]),
  )));
  assert.strictEqual(d.entities.length, 2, "polyline + the line after SEQEND");
  assert.strictEqual(d.entities[0].points.length, 3);
  assert.strictEqual(d.entities[0].closed, true);
});

t("DXF: INSERT applies base point, scale, rotation; layer 0 inherits the insert layer", () => {
  const d = parseDxf(file(
    blocks([["B", [0, 0], ent("LINE", [8, "0"], [10, 0], [20, 0], [11, 1], [21, 0])]]),
    entities(ent("INSERT", [2, "B"], [8, "FURN"], [10, 10], [20, 5], [41, 2], [42, 2], [50, 90])),
  ));
  assert.strictEqual(d.entities.length, 1);
  const l = d.entities[0];
  assert.strictEqual(l.layer, "FURN");
  near(l.start.x, 10); near(l.start.y, 5);
  near(l.end.x, 10, 1e-9); near(l.end.y, 7, 1e-9);
});

t("DXF: nested blocks and MINSERT arrays", () => {
  const d = parseDxf(file(
    blocks([
      ["IN", [0, 0], ent("LINE", [8, "0"], [10, 0], [20, 0], [11, 1], [21, 0])],
      ["OUT", [0, 0], ent("INSERT", [2, "IN"], [8, "0"], [10, 5], [20, 0])],
    ]),
    entities(
      ent("INSERT", [2, "OUT"], [8, "L"], [10, 100], [20, 0]) +
      ent("INSERT", [2, "IN"], [8, "L"], [10, 0], [20, 0], [70, 2], [71, 2], [44, 10], [45, 20]),
    ),
  ));
  assert.strictEqual(d.entities.length, 1 + 4);
  near(d.entities[0].start.x, 105);
});

t("DXF: mirrored insert turns a circle into a polyline instead of a wrong circle", () => {
  const d = parseDxf(file(
    blocks([["C", [0, 0], ent("CIRCLE", [8, "0"], [10, 1], [20, 0], [40, 1])]]),
    entities(ent("INSERT", [2, "C"], [8, "L"], [10, 0], [20, 0], [41, -1], [42, 1])),
  ));
  assert.strictEqual(d.entities[0].type, "LWPOLYLINE");
  for (const p of d.entities[0].points) near(Math.hypot(p.x + 1, p.y), 1, 1e-9);
});

t("DXF: DIMENSION is drawn through its anonymous block", () => {
  const d = parseDxf(file(
    blocks([["*D1", [0, 0], ent("LINE", [8, "DIM"], [10, 0], [20, 0], [11, 3], [21, 0])]]),
    entities(ent("DIMENSION", [2, "*D1"], [8, "DIM"])),
  ));
  assert.strictEqual(d.entities.length, 1);
});

t("DXF: cubic B-spline passes through its end points and matches the Bezier midpoint", () => {
  const knots = [0, 0, 0, 0, 1, 1, 1, 1];
  const ctrl = [[0, 0], [1, 2], [3, 2], [4, 0]];
  const d = parseDxf(file(entities(
    ent("SPLINE", [8, "0"], [70, 8], [71, 3],
      ...knots.map((k) => [40, k]),
      ...ctrl.flatMap(([x, y]) => [[10, x], [20, y], [30, 0]])),
  )));
  const pts = d.entities[0].points;
  near(pts[0].x, 0); near(pts[0].y, 0);
  near(pts[pts.length - 1].x, 4); near(pts[pts.length - 1].y, 0);
  const mid = pts[Math.floor(pts.length / 2)];
  near(mid.x, 2, 1e-6); near(mid.y, 1.5, 1e-6); // (P0+3P1+3P2+P3)/8
});

t("DXF: full ELLIPSE is a closed polyline with the right semi-axes", () => {
  const d = parseDxf(file(entities(
    ent("ELLIPSE", [8, "0"], [10, 0], [20, 0], [30, 0], [11, 4], [21, 0], [31, 0], [40, 0.5], [41, 0], [42, Math.PI * 2]),
  )));
  const e = d.entities[0];
  assert.strictEqual(e.closed, true);
  near(Math.max(...e.points.map((p) => p.x)), 4, 1e-6);
  near(Math.max(...e.points.map((p) => p.y)), 2, 1e-6);
});

t("DXF: MTEXT formatting stripped, paper space skipped, unsupported types counted", () => {
  const d = parseDxf(file(entities(
    ent("MTEXT", [8, "T"], [10, 0], [20, 0], [40, 2], [1, "{\\fArial|b0;Room\\P101}"]) +
    ent("LINE", [8, "0"], [67, 1], [10, 0], [20, 0], [11, 1], [21, 1]) +
    ent("HATCH", [8, "0"]) + ent("HATCH", [8, "0"]),
  )));
  assert.strictEqual(d.entities.length, 1, "paper-space line dropped");
  assert.strictEqual(d.entities[0].value, "Room 101");
  assert.strictEqual(d.skipped.HATCH, 2);
});

/* ---------------- DWG database converter ---------------- */
const mockDb = (angleScale) => ({
  header: { INSUNITS: 6 },
  tables: {
    LAYER: { entries: [{ name: "WALL", colorIndex: 2, flag: 0 }, { name: "OLD", colorIndex: 3, flag: 1 }] },
    BLOCK_RECORD: { entries: [
      { name: "CHAIR", basePoint: { x: 0, y: 0, z: 0 }, entities: [
        { type: "LINE", layer: "0", startPoint: { x: 0, y: 0, z: 0 }, endPoint: { x: 1, y: 0, z: 0 } },
      ] },
    ] },
  },
  entities: [
    { type: "LINE", layer: "WALL", startPoint: { x: 0, y: 0, z: 0 }, endPoint: { x: 10, y: 0, z: 0 } },
    { type: "ARC", layer: "WALL", center: { x: 0, y: 0, z: 0 }, radius: 2, startAngle: 0, endAngle: 90 * angleScale },
    { type: "LWPOLYLINE", layer: "WALL", flag: 1,
      vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }] },
    { type: "INSERT", name: "CHAIR", layer: "FURN", insertionPoint: { x: 5, y: 5, z: 0 },
      xScale: 1, yScale: 1, zScale: 1, rotation: 90 * angleScale },
    { type: "HATCH", layer: "WALL" },
  ],
});

t("DWG: radians database (libredwg native) converts angles correctly", () => {
  const { doc, summary } = dwgDatabaseToDxfDocument(mockDb(Math.PI / 180));
  const arc = doc.entities.find((e) => e.type === "ARC");
  near(arc.startAngle, 0); near(arc.endAngle, 90, 1e-9);
  const ins = doc.entities.find((e) => e.layer === "FURN");
  near(ins.end.x, 5, 1e-9); near(ins.end.y, 6, 1e-9); // rotated 90 degrees
  assert.strictEqual(doc.units, "m");
  assert.strictEqual(doc.skipped.HATCH, 1);
  assert.ok(/HATCH/.test(summary));
});

t("DWG: degrees database is detected and gives the same result", () => {
  const { doc } = dwgDatabaseToDxfDocument(mockDb(1));
  const arc = doc.entities.find((e) => e.type === "ARC");
  near(arc.endAngle, 90, 1e-9);
  const ins = doc.entities.find((e) => e.layer === "FURN");
  near(ins.end.y, 6, 1e-9);
});

t("DWG: layer flags, closed polyline and layer-0 inheritance", () => {
  const { doc } = dwgDatabaseToDxfDocument(mockDb(1));
  assert.strictEqual(doc.layers.find((l) => l.name === "OLD").frozen, true);
  const poly = doc.entities.find((e) => e.type === "LWPOLYLINE");
  assert.strictEqual(poly.closed, true);
  assert.ok(doc.entities.some((e) => e.type === "LINE" && e.layer === "FURN"), "block layer 0 -> insert layer");
});

t("DWG: alternative field names and model space taken from the block table", () => {
  const { doc } = dwgDatabaseToDxfDocument({
    tables: { BLOCK_RECORD: { entries: [{ name: "*Model_Space", entities: [
      { type: "LINE", layerName: "X", start: { x: 0, y: 0 }, end: { x: 2, y: 0 } },
      { type: "CIRCLE", layer: "X", center: [1, 1, 0], radius: 0.5 },
    ] }] } },
  });
  assert.strictEqual(doc.entities.length, 2);
  assert.strictEqual(doc.entities[1].center.x, 1);
});

t("DWG: garbage input never throws and says what happened", () => {
  const r = dwgDatabaseToDxfDocument({ entities: [{ type: "WEIRD" }, null, { type: "LINE" }] });
  assert.ok(r.doc.skipped && r.doc.skipped.WEIRD === 1);
  const empty = dwgDatabaseToDxfDocument({});
  assert.strictEqual(empty.doc.entities.length, 0);
  assert.ok(/empty/.test(empty.summary));
});

/* ---------------- placement + geometry core ---------------- */
const env = { modelCenter: { x: 100, z: -50 }, surveyToProject: (e, n) => [e - 1000, n - 2000] };
const sq = (units) => ({
  layers: [{ name: "0", color: 7 }],
  units,
  entities: [{ type: "LWPOLYLINE", layer: "0", closed: true,
    points: [{ x: 0, y: 0 }, { x: 4000, y: 0 }, { x: 4000, y: 2000 }, { x: 0, y: 2000 }] }],
});
const opts = (o) => ({ ...core.DEFAULT_LINK_OPTIONS, ...o });

t("placement: units from the file (mm -> m), origin to origin, north = +Z", () => {
  const doc = sq("mm");
  const pl = core.computePlacement(doc, opts({}), env);
  assert.strictEqual(pl.unitsUsed, "mm"); assert.strictEqual(pl.unitsGuessed, false);
  const p = core.mapPoint(pl, 4000, 2000, 0);
  near(p[0], 4); near(p[1], 0); near(p[2], 2);
});

t("placement: unitless drawing guesses units from its size and flags it", () => {
  const pl = core.computePlacement(sq("unitless"), opts({}), env);
  assert.strictEqual(pl.unitsUsed, "cm"); assert.strictEqual(pl.unitsGuessed, true); // 4000 wide
  const big = { ...sq("unitless"), entities: [{ type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 60000, y: 0 } }] };
  assert.strictEqual(core.computePlacement(big, opts({}), env).unitsUsed, "mm");
  assert.strictEqual(core.computePlacement(sq("unitless"), opts({ units: "m" }), env).unitsGuessed, false);
});

t("placement: centre to centre puts the drawing centre on the model centre", () => {
  const pl = core.computePlacement(sq("mm"), opts({ positioning: "center" }), env);
  const c = core.mapPoint(pl, 2000, 1000, 0); // drawing centre
  near(c[0], 100); near(c[2], -50);
});

t("placement: manual offset, elevation and rotation about the origin", () => {
  const pl = core.computePlacement(sq("mm"), opts({ positioning: "manual", manual: { x: 10, z: 20 }, elevation: 3, rotationDeg: 90 }), env);
  const p = core.mapPoint(pl, 4000, 0, 0); // (4,0) rotated 90 deg CCW -> (0,4)
  near(p[0], 10, 1e-9); near(p[2], 24, 1e-9); near(p[1], 3);
});

t("placement: shared coordinates go through the survey transform", () => {
  const pl = core.computePlacement(sq("m"), opts({ positioning: "shared", rotationDeg: 45 }), env);
  const p = core.mapPoint(pl, 1500, 2600, 0);
  near(p[0], 500); near(p[2], 600);
});

t("geometry: closed polyline gives 4 world segments with the right colour per theme", () => {
  const doc = { ...sq("mm"), entities: [{ ...sq("mm").entities[0], color: 7 }] };
  const pl = core.computePlacement(doc, opts({}), env);
  const light = core.buildGeometry(doc, pl, opts({}), "light");
  const dark = core.buildGeometry(doc, pl, opts({}), "dark");
  assert.strictEqual(light.segmentCount, 4);
  assert.strictEqual(light.groups[0].rgb, 0x111827);
  assert.strictEqual(dark.groups[0].rgb, 0xe5e7eb);
  near(light.bounds.maxX, 4); near(light.bounds.maxZ, 2);
  assert.strictEqual(core.buildGeometry(doc, pl, opts({ colors: "invert" }), "light").groups[0].rgb, (0x111827 ^ 0xffffff) & 0xffffff);
});

t("geometry: 'visible layers only' drops frozen layers, 'all' keeps them", () => {
  const doc = {
    layers: [{ name: "A", color: 1 }, { name: "B", color: 2, frozen: true }],
    units: "m",
    entities: [
      { type: "LINE", layer: "A", start: { x: 0, y: 0 }, end: { x: 1, y: 0 } },
      { type: "LINE", layer: "B", start: { x: 0, y: 1 }, end: { x: 1, y: 1 } },
    ],
  };
  const pl = core.computePlacement(doc, opts({}), env);
  assert.strictEqual(core.buildGeometry(doc, pl, opts({ layers: "all" }), "light").segmentCount, 2);
  assert.strictEqual(core.buildGeometry(doc, pl, opts({ layers: "visible" }), "light").segmentCount, 1);
});

t("geometry: circles/arcs tessellate, text keeps world height and rotation", () => {
  const doc = {
    layers: [{ name: "0", color: 7 }], units: "mm",
    entities: [
      { type: "CIRCLE", layer: "0", center: { x: 0, y: 0 }, radius: 1000 },
      { type: "TEXT", layer: "0", position: { x: 1000, y: 0 }, height: 250, value: "R1", rotation: 10 },
    ],
  };
  const pl = core.computePlacement(doc, opts({ rotationDeg: 30 }), env);
  const g = core.buildGeometry(doc, pl, opts({ rotationDeg: 30 }), "light");
  assert.ok(g.segmentCount >= 24);
  near(g.texts[0].height, 0.25); near(g.texts[0].rotation, 40);
});

t("collectLayerSegments filters layer, short and duplicate lines", () => {
  const doc = {
    layers: [{ name: "WALL", color: 1 }, { name: "X", color: 2 }], units: "m",
    entities: [
      { type: "LINE", layer: "WALL", start: { x: 0, y: 0 }, end: { x: 4, y: 0 } },
      { type: "LINE", layer: "WALL", start: { x: 4, y: 0 }, end: { x: 0, y: 0 } },
      { type: "LINE", layer: "WALL", start: { x: 0, y: 0 }, end: { x: 0.01, y: 0 } },
      { type: "LINE", layer: "X", start: { x: 0, y: 1 }, end: { x: 4, y: 1 } },
    ],
  };
  const pl = core.computePlacement(doc, opts({}), env);
  const g = core.buildGeometry(doc, pl, opts({}), "light");
  const r = core.collectLayerSegments(g, new Set(["WALL"]));
  assert.strictEqual(r.length, 1);
  near(Math.hypot(r[0].x2 - r[0].x1, r[0].z2 - r[0].z1), 4);
});

t("snap segments honour layer visibility", () => {
  const doc = {
    layers: [{ name: "A", color: 1 }, { name: "B", color: 2 }], units: "m",
    entities: [
      { type: "LINE", layer: "A", start: { x: 0, y: 0 }, end: { x: 1, y: 0 } },
      { type: "LINE", layer: "B", start: { x: 0, y: 1 }, end: { x: 1, y: 1 } },
    ],
  };
  const pl = core.computePlacement(doc, opts({}), env);
  const g = core.buildGeometry(doc, pl, opts({}), "light");
  assert.strictEqual(core.snapSegments(g, () => true).length, 8);
  assert.strictEqual(core.snapSegments(g, (n) => n === "A").length, 4);
});

t("placement: drawing Z is flattened by default, kept on request", () => {
  const doc = sq("mm");
  const flat = core.computePlacement(doc, opts({ elevation: 3 }), env);
  near(core.mapPoint(flat, 1000, 1000, 2000)[1], 3);          // z ignored: lies on the level
  const keep = core.computePlacement(doc, opts({ elevation: 3, flatten: false }), env);
  near(core.mapPoint(keep, 1000, 1000, 2000)[1], 5);          // 3 m level + 2 m drawing Z
  // options saved before the setting existed behave as flat
  const legacy = { ...core.DEFAULT_LINK_OPTIONS }; delete legacy.flatten;
  near(core.mapPoint(core.computePlacement(doc, legacy, env), 0, 0, 5000)[1], 0);
});

t("geometry: an insert at a different Z lands on the same plane as the lines", () => {
  const dxf = P(0, "SECTION") + P(2, "BLOCKS") + ent("BLOCK", [8, "0"], [2, "G"], [70, 0], [10, 0], [20, 0], [30, 0]) +
    ent("LINE", [8, "0"], [10, 0], [20, 0], [30, 0], [11, 100], [21, 0], [31, 0]) + P(0, "ENDBLK") + P(0, "ENDSEC") +
    section("ENTITIES", ent("INSERT", [8, "A"], [2, "G"], [10, 1000], [20, 500], [30, 2800]) + ent("LINE", [8, "A"], [10, 0], [20, 0], [30, 0], [11, 1000], [21, 500], [31, 0]));
  const doc = parseDxf(P(9, "x") && header(4) + dxf);
  const pl = core.computePlacement(doc, opts({}), env);
  const geo = core.buildGeometry(doc, pl, opts({}), "dark");
  const ys = new Set(); for (const g of geo.groups) for (let i = 1; i < g.segs.length; i += 3) ys.add(+g.segs[i].toFixed(6));
  assert.deepStrictEqual([...ys], [0]);
});

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
