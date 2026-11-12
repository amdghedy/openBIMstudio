/**
 * Hatch engine tests — HATCH 2.0 (pattern hatching + boundary detection).
 *
 * Covers the pure modules (hatch-patterns, hatch-boundary), the patternSpace
 * DXF round trip through the real writer/reader, the viewer-math inside-fill
 * picking, and the full UI wiring of the editor (catalog → dispatcher →
 * ribbon → command palette → hatch panel → act map → tool flow).
 *
 * Run: npm run test:hatch-engine
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.join(__dirname, "..");
const outDir = path.join(repo, ".tmp-hatch-test");
let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}: ${err && err.message ? err.message : err}`);
  }
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

(async () => {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { rolldown } = require("rolldown");
  for (const entry of ["hatch-patterns", "hatch-boundary", "dxf-writer", "dxf-reader"]) {
    const bundle = await rolldown({
      input: path.join(repo, "src/modules/drawings", `${entry}.ts`),
      platform: "node",
    });
    await bundle.write({ format: "cjs", dir: outDir, entryFileNames: `${entry}.cjs` });
    await bundle.close();
  }
  const vmBundle = await rolldown({
    input: path.join(repo, "src/modules/cad-viewer/viewer-math.ts"),
    platform: "node",
  });
  await vmBundle.write({ format: "cjs", dir: outDir, entryFileNames: "viewer-math.cjs" });
  await vmBundle.close();

  const HP = require(path.join(outDir, "hatch-patterns.cjs"));
  const HB = require(path.join(outDir, "hatch-boundary.cjs"));
  const { writeDxf } = require(path.join(outDir, "dxf-writer.cjs"));
  const { parseDxf } = require(path.join(outDir, "dxf-reader.cjs"));
  const M = require(path.join(outDir, "viewer-math.cjs"));

  const pt = (x, y) => ({ x, y });
  const poly = (pts) => ({ type: "LWPOLYLINE", layer: "0", points: pts, closed: true });

  console.log("hatch-patterns (pattern library):");

  check("library: 13 patterns, SOLID first, ANSI31 default", () => {
    expect(HP.HATCH_PATTERN_NAMES.length === 13, `names ${HP.HATCH_PATTERN_NAMES.length}`);
    expect(HP.HATCH_PATTERN_NAMES[0] === "SOLID", "SOLID missing");
    expect(HP.DEFAULT_HATCH_PATTERN === "ANSI31", "default pattern");
    expect(HP.isKnownHatchPattern("ansi31") && HP.isKnownHatchPattern("NET") && !HP.isKnownHatchPattern("NOPE"), "isKnownHatchPattern");
  });

  check("ANSI31: one 45° family at the 0.125-inch grid (3.175 mm)", () => {
    const fams = HP.patternDefinition("ANSI31");
    expect(fams && fams.length === 1, "one family");
    expect(Math.abs((fams[0].angle * 180) / Math.PI - 45) < 1e-9, "45 degrees");
    expect(Math.abs(fams[0].offset[1] - 3.175) < 1e-9, "spacing 3.175");
    expect(fams[0].dashes.length === 0, "continuous");
  });

  check("SOLID has no definition; unknown patterns are null", () => {
    expect(HP.patternDefinition("SOLID") === null, "SOLID");
    expect(HP.patternDefinition("NOPE") === null, "unknown");
  });

  check("ANSI37 is a 45/135 cross-hatch; ANSI33 carries a dash-dot motif", () => {
    const f = HP.patternDefinition("ANSI37");
    expect(f.length === 2, "two families");
    const a1 = (f[0].angle * 180) / Math.PI, a2 = (f[1].angle * 180) / Math.PI;
    expect(Math.abs(Math.abs(a1 - a2) - 90) < 1e-9, "perpendicular families");
    const d = HP.patternDefinition("ANSI33");
    expect(d[0].dashes.length === 4 && d[0].dashes[0] > 0 && d[0].dashes[1] < 0, "dash-dot dashes");
  });

  check("transformToDrawingSpace: scale 2 doubles spacing and dashes, 90° rotates the offset", () => {
    const base = HP.patternDefinition("ANSI31");
    const s2 = HP.transformToDrawingSpace(base, 0, 2);
    expect(Math.abs(s2[0].offset[1] - 6.35) < 1e-9, "scaled spacing");
    const rot = HP.transformToDrawingSpace(base, 90, 1);
    expect(Math.abs(rot[0].offset[0] + 3.175) < 1e-6 && Math.abs(rot[0].offset[1]) < 1e-6, `rotated offset ${JSON.stringify(rot[0].offset)}`);
    const dashed = HP.transformToDrawingSpace(HP.patternDefinition("ANSI33"), 0, 3);
    expect(Math.abs(dashed[0].dashes[0] - 3 * 3.175) < 1e-9, "dashes scale");
  });

  console.log("hatch-boundary (boundary detection):");

  check("tier 1: smallest closed object containing the seed wins (nested rectangles)", () => {
    const outer = poly([pt(0, 0), pt(100, 0), pt(100, 100), pt(0, 100)]);
    const inner = poly([pt(30, 30), pt(70, 30), pt(70, 70), pt(30, 70)]);
    const geom = HB.collectHatchGeometry([outer, inner]);
    const res = HB.detectLoopAt(geom, pt(50, 50));
    expect(res.ok && res.source === "entity", "tier 1");
    expect(Math.abs(res.area - 1600) < 1e-6, `inner area ${res.area}`);
    const res2 = HB.detectLoopAt(geom, pt(15, 15));
    expect(res2.ok && Math.abs(res2.area - 10000) < 1e-6, `outer area ${res2.ok ? res2.area : "null"}`);
  });

  check("tier 1: a circle bounds its inside — 72-gon loop within 2% of the true area", () => {
    const circle = { type: "CIRCLE", layer: "0", center: pt(50, 50), radius: 30 };
    const geom = HB.collectHatchGeometry([circle]);
    expect(geom.loops.length === 1 && geom.loops[0].length >= 70, "polygonised circle");
    const res = HB.detectLoopAt(geom, pt(50, 50));
    expect(res.ok, "detected");
    const trueArea = Math.PI * 900;
    expect(Math.abs(res.area - trueArea) / trueArea < 0.02, `area ${res.area} vs ${trueArea}`);
  });

  check("tier 2: four loose lines forming a room are traced", () => {
    const lines = [
      { type: "LINE", layer: "0", start: pt(0, 0), end: pt(100, 0) },
      { type: "LINE", layer: "0", start: pt(100, 0), end: pt(100, 100) },
      { type: "LINE", layer: "0", start: pt(100, 100), end: pt(0, 100) },
      { type: "LINE", layer: "0", start: pt(0, 100), end: pt(0, 0) },
    ];
    const geom = HB.collectHatchGeometry(lines);
    const res = HB.detectLoopAt(geom, pt(50, 50));
    expect(res.ok && res.source === "traced", `traced, got ${res.ok ? res.source : "null"}`);
    expect(Math.abs(res.area - 10000) < 1e-6, `area ${res.ok ? res.area : "null"}`);
  });

  check("tier 2: a wall-to-wall crossing line splits the room — the seed's half is found", () => {
    const lines = [
      { type: "LINE", layer: "0", start: pt(0, 0), end: pt(100, 0) },
      { type: "LINE", layer: "0", start: pt(100, 0), end: pt(100, 100) },
      { type: "LINE", layer: "0", start: pt(100, 100), end: pt(0, 100) },
      { type: "LINE", layer: "0", start: pt(0, 100), end: pt(0, 0) },
      { type: "LINE", layer: "0", start: pt(0, 50), end: pt(100, 50) },
    ];
    const geom = HB.collectHatchGeometry(lines);
    const bottom = HB.detectLoopAt(geom, pt(50, 25));
    const top = HB.detectLoopAt(geom, pt(50, 75));
    expect(bottom.ok && top.ok, "both halves");
    expect(Math.abs(bottom.area - 5000) < 1e-6, `bottom ${bottom.area}`);
    expect(Math.abs(top.area - 5000) < 1e-6, `top ${top.area}`);
  });

  check("tier 2: adjacent rooms sharing a wall pick the correct room", () => {
    const lines = [
      { type: "LINE", layer: "0", start: pt(0, 0), end: pt(100, 0) },
      { type: "LINE", layer: "0", start: pt(100, 0), end: pt(200, 0) },
      { type: "LINE", layer: "0", start: pt(0, 100), end: pt(100, 100) },
      { type: "LINE", layer: "0", start: pt(100, 100), end: pt(200, 100) },
      { type: "LINE", layer: "0", start: pt(0, 0), end: pt(0, 100) },
      { type: "LINE", layer: "0", start: pt(100, 0), end: pt(100, 100) },
      { type: "LINE", layer: "0", start: pt(200, 0), end: pt(200, 100) },
    ];
    const geom = HB.collectHatchGeometry(lines);
    const left = HB.detectLoopAt(geom, pt(50, 50));
    const right = HB.detectLoopAt(geom, pt(150, 50));
    expect(left.ok && right.ok, "both rooms");
    expect(Math.abs(left.area - 10000) < 1e-6 && Math.abs(right.area - 10000) < 1e-6, `areas ${left.area} / ${right.area}`);
  });

  check("an open floor plan never bounds a hatch; text and rays are ignored", () => {
    const geom = HB.collectHatchGeometry([
      { type: "LINE", layer: "0", start: pt(0, 0), end: pt(100, 0) },
      { type: "LINE", layer: "0", start: pt(100, 0), end: pt(100, 100) },
      { type: "TEXT", layer: "0", position: pt(50, 50), height: 5, value: "OPEN" },
      { type: "RAY", layer: "0", start: pt(0, 0), direction: pt(1, 1) },
    ]);
    const res = HB.detectLoopAt(geom, pt(50, 50));
    expect(res.ok === false && res.reason === "not-found", `not found, got ${JSON.stringify(res)}`);
    expect(geom.segs.length === 2, `text/ray excluded, segs ${geom.segs.length}`);
  });

  check("tier 2 declines to trace oversized drawings with an explicit reason", () => {
    const segs = [];
    for (let i = 0; i < 3000; i++) segs.push([pt(i, 0), pt(i + 1, 1)]);
    const res = HB.detectLoopAt({ loops: [], segs }, pt(10, 0.2));
    expect(res.ok === false && res.reason === "too-complex" && res.segs === 3000, `reason ${JSON.stringify(res)}`);
  });

  console.log("DXF patternSpace round trip:");

  check("authored hatch: pattern name, angle, scale, families and patternSpace survive write→parse", () => {
    const e = {
      ...poly([pt(0, 0), pt(100, 0), pt(100, 60), pt(0, 60)]),
      hatch: {
        solid: false,
        pattern: "ANSI31",
        angle: 45,
        scale: 2,
        loops: [[pt(0, 0), pt(100, 0), pt(100, 60), pt(0, 60)]],
        patternLines: HP.patternDefinition("ANSI31"),
        patternSpace: true,
      },
    };
    const doc = {
      layers: [{ name: "0", color: 7 }],
      entities: [e],
      units: "mm",
    };
    const text = writeDxf(doc);
    const back = parseDxf(text);
    const he = back.entities[0];
    expect(he.type === "LWPOLYLINE" && he.hatch, "hatch read back");
    expect(he.hatch.pattern === "ANSI31", `pattern ${he.hatch.pattern}`);
    expect(Math.abs(he.hatch.angle - 45) < 1e-9, `angle ${he.hatch.angle}`);
    expect(Math.abs(he.hatch.scale - 2) < 1e-9, `scale ${he.hatch.scale}`);
    expect(he.hatch.patternLines && he.hatch.patternLines.length === 1, "families read back");
    expect(he.hatch.patternSpace === true, "patternSpace flag");
    expect(Math.abs((he.hatch.patternLines[0].angle * 180) / Math.PI - 45) < 1e-6, "family angle 45°");
  });

  check("DWG-style drawing-space families export at angle 0 / scale 1 (no double transform)", () => {
    const e = {
      ...poly([pt(0, 0), pt(100, 0), pt(100, 60), pt(0, 60)]),
      hatch: {
        solid: false,
        pattern: "ANSI31",
        angle: 45,
        scale: 2,
        loops: [[pt(0, 0), pt(100, 0), pt(100, 60), pt(0, 60)]],
        patternLines: [{ angle: (45 * Math.PI) / 180, base: [0, 0], offset: [0, 6.35], dashes: [] }],
      },
    };
    const text = writeDxf({ layers: [{ name: "0", color: 7 }], entities: [e], units: "mm" });
    const back = parseDxf(text);
    const he = back.entities[0];
    expect(Math.abs(he.hatch.angle) < 1e-9, `angle written 0, got ${he.hatch.angle}`);
    expect(Math.abs(he.hatch.scale - 1) < 1e-9, `scale written 1, got ${he.hatch.scale}`);
    expect(he.hatch.patternLines && Math.abs((he.hatch.patternLines[0].angle * 180) / Math.PI - 45) < 1e-6, "drawing-space family preserved");
  });

  console.log("viewer-math: inside-fill picking:");

  check("pickEntity selects a hatch by its fill inside, still prefers a line under the cursor", () => {
    const hatched = {
      ...poly([pt(0, 0), pt(100, 0), pt(100, 100), pt(0, 100)]),
      hatch: { solid: true, loops: [[pt(0, 0), pt(100, 0), pt(100, 100), pt(0, 100)]] },
    };
    const crossing = { type: "LINE", layer: "0", start: pt(0, 50), end: pt(100, 50) };
    const entities = [hatched, crossing];
    const idx = M.buildIndex(entities, { minX: 0, minY: 0, maxX: 100, maxY: 100 });
    const tol = 10;
    expect(M.pickEntity(idx, entities, 50, 25, tol) === 0, "inside fill → hatch");
    expect(M.pickEntity(idx, entities, 50, 50, tol) === 1, "line under cursor wins");
    expect(M.pickEntity(idx, entities, 50, 61, tol) === 0, "fill still beats empty space");
    expect(M.pickEntity(idx, entities, 200, 200, tol) === -1, "outside → nothing");
  });

  console.log("editor wiring:");

  const viewerSrc = fs.readFileSync(path.join(repo, "src/features/cad-viewer.ts"), "utf8");
  const catalogBlock = (viewerSrc.match(/const CAD_COMMANDS[^=]*= \[([\s\S]*?)\n\];/) || ["", ""])[1];

  check("catalog: HATCH/BHATCH + BOUNDARY/BPOLY + HATCHEDIT/HE, no duplicate names", () => {
    expect(/name: "HATCH", aliases: \["H", "BHATCH"\]/.test(catalogBlock), "HATCH entry");
    expect(/name: "BOUNDARY", aliases: \["BPOLY"\]/.test(catalogBlock), "BOUNDARY entry");
    expect(/name: "HATCHEDIT", aliases: \["HE"\]/.test(catalogBlock), "HATCHEDIT entry");
    const names = [...catalogBlock.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(names).size === names.length, `duplicate catalog names (${names.length} entries)`);
    expect(names.length === 167, `catalog has ${names.length} entries, expected 167`);
  });

  check("dispatcher: HATCH presets + PANEL, BOUNDARY/BPOLY arm, HATCHEDIT arm", () => {
    expect(viewerSrc.includes('if (cmd === "HATCH" || cmd === "H" || cmd === "BHATCH")'), "HATCH arm");
    expect(viewerSrc.includes('if (cmd === "BOUNDARY" || cmd === "BPOLY")'), "BOUNDARY arm");
    expect(viewerSrc.includes('if (cmd === "HATCHEDIT" || cmd === "HE")'), "HATCHEDIT arm");
    expect(viewerSrc.includes("hatchDefaults.pattern = p;") && viewerSrc.includes("saveHatchDefaults();"), "preset path");
    expect(viewerSrc.includes("void showHatchPalette();"), "plain HATCH opens the panel");
  });

  check("tool flow: boundary mode creates outline; fill mode detects + hatches", () => {
    expect(viewerSrc.includes('if (hatchMode === "boundary")'), "boundary branch in the hatch tool");
    expect(viewerSrc.includes("const res = detectBoundaryAt(wp);"), "boundary detection on pick");
    expect(viewerSrc.includes("hatch: authoredHatchFor([res.loop])"), "detected loop is hatched");
    expect(viewerSrc.includes("addDraftEntity({ type: \"LWPOLYLINE\", layer: currentLayer, ...newObjectProps(), points: res.loop, closed: true })"), "BOUNDARY polyline");
    expect(viewerSrc.includes("HATCH: no boundary found around that point"), "honest failure message");
  });

  check("hatch panel: pattern gallery previews through the real segment generator", () => {
    expect(viewerSrc.includes('panel.className = "obs-hatch-panel"'), "panel class");
    expect(viewerSrc.includes("for (const name of HATCH_PATTERN_NAMES)"), "one tile per pattern");
    expect(viewerSrc.includes("M.hatchPatternLineSegments(box, fams, 400)"), "previews use the drawing generator");
    expect(viewerSrc.includes("function showHatchPalette(): void"), "panel entry");
    expect(viewerSrc.includes("function hatchEditCmd(arg?: string): void"), "HATCHEDIT entry");
    expect(viewerSrc.includes('"obs.cad.hatchDefaults"'), "settings persist");
  });

  check("ribbon + act + command palette wired on every surface", () => {
    expect(viewerSrc.includes('rb("polygon", "Boundary", `data-a="boundary"`'), "ribbon Boundary");
    expect(viewerSrc.includes('rb("hatch", "HatchEdit", `data-a="hatchedit"`'), "ribbon HatchEdit");
    expect(viewerSrc.includes('rb("grid", "Hatch Panel", `data-a="hatchpanel"`'), "ribbon Hatch Panel");
    expect(viewerSrc.includes("hatchedit: () => hatchEditCmd()"), "act hatchedit");
    expect(viewerSrc.includes("hatchpanel: () => {"), "act hatchpanel");
    expect(viewerSrc.includes('addItem("Boundary from Pick…"'), "palette Boundary");
    expect(viewerSrc.includes('addItem("Hatch & Boundaries Panel…"'), "palette panel");
    expect(viewerSrc.includes('addItem("Edit Hatch…"'), "palette HATCHEDIT");
  });

  check("renderer: pattern-space families get angle/scale; drawing-space stay as-is", () => {
    expect(viewerSrc.includes("transformToDrawingSpace(h.patternLines, h.angle ?? 0, h.scale ?? 1)"), "renderer transform");
    expect(viewerSrc.includes("h.patternSpace"), "patternSpace branch");
  });

  check("picking: hatchFillHit feeds both pickEntity and pickEntities", () => {
    const vmSrc = fs.readFileSync(path.join(repo, "src/modules/cad-viewer/viewer-math.ts"), "utf8");
    expect(vmSrc.includes("export function hatchFillHit"), "hatchFillHit exported");
    expect((vmSrc.match(/pickDistance\(/g) || []).length >= 3, "pickDistance shared by both pickers");
  });

  check("package.json: test:hatch script registered", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));
    expect(pkg.scripts["test:hatch-engine"] === "node tests/hatch-engine.test.cjs", "script");
    expect(pkg.scripts["test:hatch"] === "node tests/hatch-patterns.test.cjs", "original test:hatch script kept");
  });

  console.log(`\nhatch engine: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((err) => {
  console.error("harness error:", err);
  process.exit(1);
});
