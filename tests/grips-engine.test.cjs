/**
 * Universal 3D Grips Engine tests — geometry + interaction contract.
 *
 * The engine (src/modules/grips/grips-engine.ts) is compiled standalone with
 * tsc and exercised as pure math: grip planning per object category,
 * parametric transforms, numeric-entry application, and the safety contract
 * (non-finite input → null, degenerate results → explicit warnings, never
 * silent data loss). Integration points in authoring.ts / wall-handles.ts
 * are asserted by source inspection, matching this repo's test style.
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

let passed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log("ok  -", name); }
  catch (err) { console.error("FAIL -", name, "\n ", err.message); process.exitCode = 1; }
}

const out = fs.mkdtempSync(path.join(os.tmpdir(), "grips-engine-"));
execSync(
  `npx tsc src/modules/grips/grips-engine.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --ignoreDeprecations 5.0`,
  { stdio: "inherit", cwd: path.join(__dirname, "..") },
);
const G = require(path.join(out, "grips", "grips-engine.js"));

// ── 1. Grip planning per object category ────────────────────────────────
t("planGrips: linear element (wall) → move/height/elevation", () => {
  const grips = G.planGrips({
    start: [0, 0], end: [4, 0], height: 3, elevation: 0.2,
  });
  const kinds = grips.map((g) => g.kind).sort();
  assert.deepStrictEqual(kinds, ["elevation", "height", "move"]);
  const move = grips.find((g) => g.kind === "move");
  assert.deepStrictEqual(move.position, [2, 0]); // midpoint
});

t("planGrips: polygon element (slab) → move/rotate/scale/height/elevation + edge grips", () => {
  const poly = [[0, 0], [10, 0], [10, 6], [0, 6]];
  const grips = G.planGrips({ polygon: poly, height: 0.3, elevation: 0 });
  const kinds = grips.map((g) => g.kind);
  assert.strictEqual(kinds.filter((k) => k === "move").length, 1);
  assert.strictEqual(kinds.filter((k) => k === "rotate").length, 1);
  assert.strictEqual(kinds.filter((k) => k === "scale").length, 1);
  assert.strictEqual(kinds.filter((k) => k === "height").length, 1);
  assert.strictEqual(kinds.filter((k) => k === "elevation").length, 1);
  assert.strictEqual(kinds.filter((k) => k === "edge").length, 4); // one per boundary edge
  const edge0 = grips.find((g) => g.kind === "edge" && g.edgeIndex === 0);
  assert.ok(edge0, "edge grip 0 planned");
  // Edge grip sits outside the boundary (x < 0 for the top edge [0,0]-[10,0]).
  assert.ok(edge0.position[1] < 0, "edge grip offset outward");
});

t("planGrips: point element (column) → height/elevation (point grip is the move)", () => {
  const grips = G.planGrips({ point: [3, 3], height: 3.5, elevation: 0 });
  const kinds = grips.map((g) => g.kind).sort();
  assert.deepStrictEqual(kinds, ["elevation", "height"]);
});

t("planGrips: no editable geometry → empty plan (no fabricated grips)", () => {
  assert.deepStrictEqual(G.planGrips({}), []);
  assert.deepStrictEqual(G.planGrips({ height: 3 }), []);
});

t("planGrips: missing height/elevation → no vertical grips planned", () => {
  const grips = G.planGrips({ start: [0, 0], end: [1, 0] });
  const kinds = grips.map((g) => g.kind);
  assert.deepStrictEqual(kinds, ["move"]);
});

// ── 2. Parametric transforms ────────────────────────────────────────────
t("translateParams: moves start/end/point/polygon together", () => {
  const p = { start: [0, 0], end: [4, 0], point: [1, 1], polygon: [[0, 0], [2, 0], [1, 2]] };
  const out = G.translateParams(p, 5, -2);
  assert.deepStrictEqual(out.start, [5, -2]);
  assert.deepStrictEqual(out.end, [9, -2]);
  assert.deepStrictEqual(out.point, [6, -1]);
  assert.deepStrictEqual(out.polygon[0], [5, -2]);
  // Source untouched (pure).
  assert.deepStrictEqual(p.start, [0, 0]);
});

t("translateParams: non-finite delta → null (invalid edit rejected)", () => {
  assert.strictEqual(G.translateParams({ point: [0, 0] }, NaN, 1), null);
  assert.strictEqual(G.translateParams({ point: [0, 0] }, 1, Infinity), null);
});

t("rotateParams: 90° about centre rotates geometry exactly", () => {
  const p = { start: [1, 1], end: [3, 1] };
  const out = G.rotateParams(p, 2, 1, Math.PI / 2);
  // (1,1) → (2, 0); (3,1) → (2, 2)
  assert.ok(Math.abs(out.start[0] - 2) < 1e-9 && Math.abs(out.start[1] - 0) < 1e-9);
  assert.ok(Math.abs(out.end[0] - 2) < 1e-9 && Math.abs(out.end[1] - 2) < 1e-9);
});

t("rotateParams: non-finite angle/centre → null", () => {
  assert.strictEqual(G.rotateParams({ point: [0, 0] }, NaN, 0, 1), null);
  assert.strictEqual(G.rotateParams({ point: [0, 0] }, 0, 0, Infinity), null);
});

t("scalePolygon: factor 2 doubles extents about the centre", () => {
  const poly = [[0, 0], [4, 0], [4, 2], [0, 2]];
  const r = G.scalePolygon(poly, 2, 1, 2);
  assert.ok(!r.warnings.length);
  assert.ok(Math.abs(r.polygon[0][0] - (-2)) < 1e-9 && Math.abs(r.polygon[0][1] - (-1)) < 1e-9);
  assert.ok(Math.abs(r.polygon[2][0] - 6) < 1e-9 && Math.abs(r.polygon[2][1] - 3) < 1e-9);
});

t("scalePolygon: zero/negative factor → null (never produce inverted geometry)", () => {
  const poly = [[0, 0], [4, 0], [4, 2], [0, 2]];
  assert.strictEqual(G.scalePolygon(poly, 2, 1, 0), null);
  assert.strictEqual(G.scalePolygon(poly, 2, 1, -3), null);
});

t("scalePolygon: degenerate collapse → warning, original kept (no silent loss)", () => {
  const poly = [[0, 0], [4, 0], [4, 2], [0, 2]];
  const r = G.scalePolygon(poly, 2, 1, 1e-9);
  assert.ok(r.warnings.length >= 1, "explicit warning present");
  assert.deepStrictEqual(r.polygon, poly); // original boundary kept
});

t("translatePolygonEdge: moves exactly the two edge vertices", () => {
  const poly = [[0, 0], [10, 0], [10, 6], [0, 6]];
  const r = G.translatePolygonEdge(poly, 2, 0, -3); // bottom edge [10,6]-[0,6] moves -z
  assert.deepStrictEqual(r.polygon[2], [10, 3]);
  assert.deepStrictEqual(r.polygon[3], [0, 3]);
  assert.deepStrictEqual(r.polygon[0], [0, 0]); // others untouched
});

t("translatePolygonEdge: self-intersecting move → warning + original kept", () => {
  // A "U" shape where pushing the middle edge across self-intersects.
  const poly = [[0, 0], [10, 0], [10, 10], [8, 10], [8, 2], [2, 2], [2, 10], [0, 10]];
  const r = G.translatePolygonEdge(poly, 2, 0, -12); // edge [10,10]-[8,10] pushed past y=2
  assert.ok(r.warnings.length >= 1, "explicit warning");
  assert.deepStrictEqual(r.polygon, poly);
});

t("translatePolygonEdge: bad index / non-finite → null", () => {
  const poly = [[0, 0], [4, 0], [4, 2]];
  assert.strictEqual(G.translatePolygonEdge(poly, -1, 1, 1), null);
  assert.strictEqual(G.translatePolygonEdge(poly, 5, 1, 1), null);
  assert.strictEqual(G.translatePolygonEdge(poly, 0, NaN, 0), null);
});

// ── 3. applyEngineGrip — the application contract ───────────────────────
t("applyEngineGrip move: translates whole element by pointer − centre", () => {
  const p = { start: [0, 0], end: [4, 0], height: 3, elevation: 0 };
  const r = G.applyEngineGrip("move", p, { target: [6, 2] }); // centre (2,0) → delta (4,2)
  assert.deepStrictEqual(r.params.start, [4, 2]);
  assert.deepStrictEqual(r.params.end, [8, 2]);
  assert.strictEqual(r.params.height, 3); // non-geometry params untouched
});

t("applyEngineGrip move: non-finite target → null", () => {
  assert.strictEqual(G.applyEngineGrip("move", { point: [0, 0] }, { target: [NaN, 0] }), null);
  assert.strictEqual(G.applyEngineGrip("move", { point: [0, 0] }, {}), null);
});

t("applyEngineGrip height: exact set + min clamp with explicit warning", () => {
  const p = { start: [0, 0], end: [4, 0], height: 3 };
  const r1 = G.applyEngineGrip("height", p, { height: 5.5 });
  assert.strictEqual(r1.params.height, 5.5);
  assert.strictEqual(r1.warnings.length, 0);
  const r2 = G.applyEngineGrip("height", p, { height: -1 });
  assert.strictEqual(r2.params.height, G.MIN_GRIP_HEIGHT);
  assert.ok(r2.warnings.some((w) => /clamped/i.test(w)), "clamp warning surfaced");
  assert.strictEqual(G.applyEngineGrip("height", p, { height: NaN }), null);
});

t("applyEngineGrip elevation: exact set; non-finite → null", () => {
  const p = { point: [1, 1], elevation: 0 };
  const r = G.applyEngineGrip("elevation", p, { elevation: 2.75 });
  assert.strictEqual(r.params.elevation, 2.75);
  assert.strictEqual(G.applyEngineGrip("elevation", p, {}), null);
});

t("applyEngineGrip rotate: numeric degrees→radians applied to polygon", () => {
  const poly = [[1, 1], [3, 1], [3, 3], [1, 3]]; // centre (2,2)
  const r = G.applyEngineGrip("rotate", { polygon: poly, height: 0.2 }, { angleRad: Math.PI / 2 });
  // vertex (1,1) about (2,2) by +90° → (3, 1)
  assert.ok(Math.abs(r.params.polygon[0][0] - 3) < 1e-9 && Math.abs(r.params.polygon[0][1] - 1) < 1e-9);
});

t("applyEngineGrip rotate: linear/point elements not rotatable → null (honest limits)", () => {
  assert.strictEqual(G.applyEngineGrip("rotate", { start: [0, 0], end: [1, 0] }, { angleRad: 1 }), null);
  assert.strictEqual(G.applyEngineGrip("rotate", { point: [0, 0] }, { angleRad: 1 }), null);
});

t("applyEngineGrip scale: numeric factor about centre; degenerate → warning", () => {
  const poly = [[0, 0], [4, 0], [4, 2], [0, 2]];
  const r = G.applyEngineGrip("scale", { polygon: poly }, { scaleFactor: 2 });
  assert.ok(Math.abs(r.params.polygon[2][0] - 6) < 1e-9);
  const bad = G.applyEngineGrip("scale", { polygon: poly }, { scaleFactor: 1e-12 });
  assert.ok(bad.warnings.length >= 1);
  assert.deepStrictEqual(bad.params.polygon, poly);
});

t("applyEngineGrip scale: drag-driven factor from pointer distance", () => {
  const poly = [[2, 2], [6, 2], [6, 5], [2, 5]]; // centre (4, 3.5); vertex0 dist 2.5
  const r = G.applyEngineGrip("scale", { polygon: poly }, { target: [9, 3.5] }); // dist 5 → factor 2
  assert.ok(Math.abs(r.params.polygon[1][0] - 8) < 1e-9);
});

t("applyEngineGrip edge: pointer target moves the edge; invalid → warnings/null", () => {
  const poly = [[0, 0], [10, 0], [10, 6], [0, 6]];
  // Edge 0 midpoint (5,0) → target (5,-2): edge moves -2 in z.
  const r = G.applyEngineGrip("edge", { polygon: poly }, { target: [5, -2], edgeIndex: 0 });
  assert.deepStrictEqual(r.params.polygon[0], [0, -2]);
  assert.deepStrictEqual(r.params.polygon[1], [10, -2]);
  assert.strictEqual(G.applyEngineGrip("edge", { polygon: poly }, { target: [NaN, 0], edgeIndex: 0 }), null);
  assert.strictEqual(G.applyEngineGrip("edge", { polygon: poly }, { target: [0, 0] }), null); // no edgeIndex
});

t("applyEngineGrip: unknown grip kind → null (no silent passthrough)", () => {
  assert.strictEqual(G.applyEngineGrip("nonexistent", { point: [0, 0] }, { target: [1, 1] }), null);
});

t("applyEngineGrip: missing geometry → null (safe no-op)", () => {
  assert.strictEqual(G.applyEngineGrip("move", {}, { target: [1, 1] }), null);
  assert.strictEqual(G.applyEngineGrip("edge", { start: [0, 0], end: [1, 1] }, { target: [1, 1], edgeIndex: 0 }), null);
});

// ── 4. Interaction integration (source contract) ────────────────────────
const repo = path.join(__dirname, "..");
const authoring = fs.readFileSync(path.join(repo, "src/features/authoring.ts"), "utf8");
const wallHandles = fs.readFileSync(path.join(repo, "src/features/wall-handles.ts"), "utf8");
const accudraw = fs.readFileSync(path.join(repo, "src/features/accudraw.ts"), "utf8");

t("authoring.ts renders engine grips with distinct shapes per kind", () => {
  assert.ok(authoring.includes("applyEngineGrip"), "engine application wired");
  assert.ok(authoring.includes("planGrips("), "engine planning wired");
  assert.ok(authoring.includes("OctahedronGeometry"), "move/scale diamond shape");
  assert.ok(authoring.includes("TorusGeometry"), "rotate ring shape");
  assert.ok(authoring.includes("ConeGeometry"), "height cone shape");
  assert.ok(authoring.includes("CylinderGeometry"), "elevation cylinder shape");
  assert.ok(authoring.includes("BoxGeometry(GRIP_SIZE"), "edge box shape");
});

t("authoring.ts vertical grip drags scale by world-per-pixel", () => {
  assert.ok(authoring.includes("worldPerPixelAt"), "vertical drag scaling helper");
  assert.ok(authoring.includes("startPointerY - pointerY"), "pointer-up = taller");
});

t("authoring.ts numeric entry: Enter commits typed values during grip drags", () => {
  assert.ok(authoring.includes("commitGripNumeric"), "numeric commit function");
  assert.ok(authoring.includes('accuDraw.begin(worldPt.clone())'), "AccuDraw armed at grip drag start");
  assert.ok(accudraw.includes("getTypedBuffer()"), "AccuDraw exposes typed buffer");
  assert.ok(/key === "Enter" && gripDrag/.test(authoring), "Enter handled during grip drag");
});

t("authoring.ts grip commits sync IFC archive + properties panel", () => {
  assert.ok(/markNativeDimensionModified\(el\.sourceArchive, k\)/.test(authoring), "source archive marked");
  assert.ok(/notifyAuthoringChange\(\);\n\n  \/\/ Persist wall–column link/.test(authoring), "palette notified after commit");
});

t("authoring.ts Esc reverts an in-flight grip drag (no silent intermediate commit)", () => {
  assert.ok(authoring.includes("function cancelGripDrag"), "cancel restores snapshot");
  assert.ok(/cancelGripDrag\(\)/.test(authoring), "Esc path wired");
});

t("authoring.ts degenerate edits surface explicit warnings (no silent data loss)", () => {
  assert.ok(/notify\("warn", result\.warnings\.join\(" "\)\)/.test(authoring), "warnings surfaced");
});

t("wall-handles.ts gains move/height/elevation parity for wall-like elements", () => {
  assert.ok(wallHandles.includes('"move" | "height" | "elevation"'), "drag kinds extended");
  assert.ok(wallHandles.includes("MIN_WALL_HEIGHT"), "height clamp in overlay");
  assert.ok(wallHandles.includes("markNativeDimensionModified"), "IFC archive sync in overlay");
  assert.ok(wallHandles.includes("Resize height "), "undo label per grip kind");
  assert.ok(wallHandles.includes("accuDraw.begin"), "numeric entry armed");
});

t("undo/redo labels distinguish grip operations", () => {
  assert.ok(authoring.includes("`Move grip · ${el.name}`"), "3D grip undo label");
  assert.ok(wallHandles.includes('"Resize height " + el.name'), "overlay height label");
});

console.log(`\nUniversal 3D Grips Engine tests: ${passed} passed${process.exitCode ? " (FAILURES)" : ""}.`);
