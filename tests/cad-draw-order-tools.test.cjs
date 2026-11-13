/**
 * Draw-order + radius dimension + path array tests — the critical 2D gaps
 * closed after HATCH 2.0 (hatches made paint order user-visible).
 *
 * Covers the pure math module (modify-math pathPointTangent / pathArrayEnts)
 * and the full UI wiring of the editor (catalog → dispatcher → ribbon →
 * context menu → act map → click flows → undo/redo).
 *
 * Run: npm run test:cad-draw-order
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const repo = path.join(__dirname, "..");
const outDir = path.join(repo, ".tmp-draworder-test");
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
  const bundle = await rolldown({
    input: path.join(repo, "src/modules/cad-viewer/modify-math.ts"),
    platform: "node",
  });
  await bundle.write({ format: "cjs", dir: outDir, entryFileNames: "modify-math.cjs" });
  await bundle.close();
  const X = require(path.join(outDir, "modify-math.cjs"));
  const src = fs.readFileSync(path.join(repo, "src/features/cad-viewer.ts"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8"));

  const pt = (x, y) => ({ x, y });
  const line = (a, b) => ({ type: "LINE", layer: "0", start: pt(a[0], a[1]), end: pt(b[0], b[1]) });
  const circ = (c, r) => ({ type: "CIRCLE", layer: "0", center: pt(c[0], c[1]), radius: r });
  const arc = (c, r, s, e) => ({ type: "ARC", layer: "0", center: pt(c[0], c[1]), radius: r, startAngle: s, endAngle: e });
  const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
  const anchorOf = (e) => X.entityArrayAnchor(e);

  console.log("pathPointTangent (path sampling):");

  check("LINE: t=0/0.5/1 walk start → mid → end, tangent along the line", () => {
    const L = line([0, 0], [300, 0]);
    const a = X.pathPointTangent(L, 0), b = X.pathPointTangent(L, 0.5), c = X.pathPointTangent(L, 1);
    expect(near(a.p.x, 0) && near(a.p.y, 0), "t=0 position");
    expect(near(b.p.x, 150) && near(b.p.y, 0), "t=0.5 position");
    expect(near(c.p.x, 300) && near(c.p.y, 0), "t=1 position");
    expect(near(a.deg, 0) && near(b.deg, 0) && near(c.deg, 0), "tangent 0°");
  });

  check("open LWPOLYLINE: parameter walks both legs with per-leg tangents", () => {
    const P = { type: "LWPOLYLINE", layer: "0", points: [pt(0, 0), pt(100, 0), pt(100, 100)] };
    const a = X.pathPointTangent(P, 0.25), b = X.pathPointTangent(P, 0.75), c = X.pathPointTangent(P, 1);
    expect(near(a.p.x, 50) && near(a.p.y, 0) && near(a.deg, 0), "first leg midpoint");
    expect(near(b.p.x, 100) && near(b.p.y, 50) && near(b.deg, 90), "second leg midpoint");
    expect(near(c.p.x, 100) && near(c.p.y, 100), "endpoint inclusive");
  });

  check("ARC: counter-clockwise from startAngle, tangent perpendicular to the radius", () => {
    const A = arc([0, 0], 100, 0, 90);
    const s = X.pathPointTangent(A, 0), e = X.pathPointTangent(A, 1);
    expect(near(s.p.x, 100) && near(s.p.y, 0), "arc start");
    expect(near(e.p.x, 0) && near(e.p.y, 100), "arc end");
    expect(near(s.deg, 90) && near(e.deg, 180), "tangents 90° → 180°");
  });

  check("CIRCLE: full loop from angle 0, closed semantics", () => {
    const C = circ([0, 0], 50);
    const a = X.pathPointTangent(C, 0), q = X.pathPointTangent(C, 0.25);
    expect(near(a.p.x, 50) && near(a.p.y, 0), "t=0");
    expect(near(q.p.x, 0) && near(q.p.y, 50), "t=0.25");
    expect(X.pathPointTangent(C, 0.999), "t≈1 valid");
  });

  console.log("pathArrayEnts (ARRAYPATH math):");

  check("line path: 4 items land at even t, first and last on the endpoints", () => {
    const item = circ([100, 50], 10);
    const copies = X.pathArrayEnts([item], line([0, 0], [300, 0]), 4, false);
    expect(copies.length === 4, `copies ${copies.length}`);
    const xs = copies.map((c) => anchorOf(c).x).sort((p, q) => p - q);
    expect(near(xs[0], 0) && near(xs[1], 100) && near(xs[2], 200) && near(xs[3], 300), "anchors on t=0,1/3,2/3,1");
    expect(copies.every((c) => near(anchorOf(c).y, 0)), "every anchor sits on the path");
  });

  check("closed circle path: items distribute around the loop without duplicate start", () => {
    const item = circ([10, 0], 5);
    const copies = X.pathArrayEnts([item], circ([0, 0], 100), 6, false);
    expect(copies.length === 6, `copies ${copies.length}`);
    const ancs = copies.map(anchorOf);
    expect(ancs.every((a) => near(Math.hypot(a.x, a.y), 100, 1e-6)), "all anchors on the circle");
    for (let i = 0; i < ancs.length; i++)
      for (let j = i + 1; j < ancs.length; j++)
        expect(Math.hypot(ancs[i].x - ancs[j].x, ancs[i].y - ancs[j].y) > 1e-3, `items ${i}/${j} coincide`);
  });

  check("alignToPath=true rotates the copy onto the path tangent (Aligned)", () => {
    const item = line([100, 0], [120, 0]); // local +X horizontal
    const path = arc([0, 0], 100, 0, 90);
    const copies = X.pathArrayEnts([item], path, 2, true);
    const first = copies[0]; // t=0 → position (100,0), tangent 90°
    const dx = first.end.x - first.start.x, dy = first.end.y - first.start.y;
    expect(Math.abs(dx) < 1e-6 && Math.abs(dy) > 19, "copy now runs vertically");
    expect(near(anchorOf(first).x, 100) && near(anchorOf(first).y, 0), "anchor on the path start");
  });

  check("alignToPath=false keeps the original orientation", () => {
    const item = line([100, 0], [120, 0]);
    const copies = X.pathArrayEnts([item], arc([0, 0], 100, 0, 90), 2, false);
    expect(near(copies[0].start.y, copies[0].end.y), "still horizontal");
    expect(near(copies[0].end.x - copies[0].start.x, 20), "still 20 long");
  });

  check("immutability: the source entities are never mutated", () => {
    const item = circ([100, 50], 10);
    const before = JSON.stringify(item);
    X.pathArrayEnts([item], line([0, 0], [300, 0]), 3, true);
    expect(JSON.stringify(item) === before, "source changed");
  });

  check("validation: bad counts, unsupported paths, zero-length paths, 10k cap", () => {
    const item = circ([0, 0], 5), L = line([0, 0], [100, 0]);
    const throws = (fn, which) => {
      try { fn(); } catch (e) { return e; }
      throw new Error(`no throw: ${which}`);
    };
    expect(throws(() => X.pathArrayEnts([item], L, 1), "count 1") instanceof RangeError, "count 1 not RangeError");
    expect(throws(() => X.pathArrayEnts([item], L, 501), "count 501") instanceof RangeError, "count 501");
    expect(throws(() => X.pathArrayEnts([item], L, 2.5), "count 2.5") instanceof RangeError, "count 2.5");
    expect(throws(() => X.pathArrayEnts([item], { type: "TEXT", layer: "0", position: pt(0, 0), text: "x", height: 2 }, 4), "TEXT path") instanceof TypeError, "TEXT path not TypeError");
    expect(throws(() => X.pathArrayEnts([item], line([5, 5], [5, 5]), 4), "zero length") instanceof RangeError, "zero length");
    const many = Array.from({ length: 21 }, (_, i) => circ([i * 3, 0], 2));
    expect(throws(() => X.pathArrayEnts(many, L, 500), "cap") instanceof RangeError, "10000 cap");
  });

  console.log("editor wiring (catalog → dispatcher → UI):");

  check("catalog: ARRAYPATH, DRAWORDER and DIMRADIUS registered with fresh aliases", () => {
    const i = src.indexOf("const CAD_COMMANDS");
    const blk = src.slice(i, i + 36000);
    for (const [name, alias] of [["ARRAYPATH", "ARPATH"], ["DRAWORDER", "DORD"], ["DIMRADIUS", "DIMRAD"], ["DIMRADIUS", "DRA"]]) {
      const re = new RegExp(`name: "${name}"[\\s\\S]{0,160}?aliases: \\[[^\\]]*"${alias}"`);
      expect(re.test(blk), `catalog ${name} alias ${alias}`);
    }
    const names = [...blk.matchAll(/name: "([^"]+)"/g)].map((m) => m[1]);
    expect(names.length === 168, `catalog size ${names.length} (want 168)`); // tracks the real CAD_COMMANDS size (PDFTODWG added the 168th)
  });

  check("dispatcher arms: ARRAYPATH, DRAWORDER and DIMRADIUS all routable", () => {
    expect(/cmd === "ARRAYPATH" \|\| cmd === "ARPATH"/.test(src), "ARRAYPATH arm");
    expect(/cmd === "DRAWORDER" \|\| cmd === "DORD"/.test(src), "DRAWORDER arm");
    expect(/cmd === "DIMRADIUS" \|\| cmd === "DIMRAD" \|\| cmd === "DRA"/.test(src), "DIMRADIUS arm");
    expect(/cmd === "DIMRADIUS"[\s\S]{0,80}setTool\("radius"\)/.test(src), "DIMRADIUS → radius tool");
    expect(/cmd === "ARRAYPATH"[\s\S]{0,200}setTool\("arpath"\)/.test(src), "ARRAYPATH → arpath tool");
    expect(/cmd === "DRAWORDER"[\s\S]{0,300}drawOrder\("back"\)/.test(src), "DRAWORDER → drawOrder back");
  });

  check("ARRAYPATH click flow: pick path, prompt items + align, addEntities", () => {
    const i = src.indexOf('case "arpath"');
    expect(i > 0, "case arpath missing");
    const flow = src.slice(i, i + 2400);
    for (const needle of ["path.type === \"LINE\"", "path.type === \"CIRCLE\"", "promptLine(\"Path Array — Items\"", "promptLine(\"Path Array — Align Items\"", "X.pathArrayEnts(items, path, count, align)", "addEntities(copies)"])
      expect(flow.includes(needle), `flow missing ${needle}`);
  });

  check("DIMRADIUS click flow: entity-based radial dimension, not a 2-point probe", () => {
    const i = src.indexOf('case "radius"');
    expect(i > 0, "case radius missing");
    const flow = src.slice(i, i + 900);
    expect(flow.includes("M.pickEntity"), "flow must pick an entity");
    expect(flow.includes('e.type === "CIRCLE" || e.type === "ARC"'), "flow must accept circle/arc");
    expect(flow.includes('kind: "dimrad"'), "flow must push a dimrad markup");
    expect(flow.includes("R${fmt(e.radius)}"), "flow must label R<radius>");
    expect(!flow.includes("pts.push(p)"), "old 2-point probe still present");
  });

  check("dimrad markup: union member + renderer branch", () => {
    expect(/kind: "line" \| "note" [\s\S]{0,120}"dimrad"/.test(src) || src.includes('| "dimrad" | "dimcenter"'), "Markup union dimrad");
    expect(src.includes('m.kind === "dimrad" && m.pts.length >= 2'), "dimrad render branch");
  });

  check("DRAWORDER: drawOrder function with full-order undo", () => {
    expect(src.includes('function drawOrder(mode: "front" | "back"): void'), "drawOrder fn");
    expect(src.includes('type: "add" | "delete" | "modify" | "replace" | "order"'), "UndoAction order type");
    expect(src.includes("orderBefore?: DxfEntity[]") && src.includes("orderAfter?: DxfEntity[]"), "order fields");
    expect(/act\.type === "order"[\s\S]{0,200}act\.orderBefore/.test(src), "undo order branch");
    expect(/act\.type === "order"[\s\S]{0,200}act\.orderAfter/.test(src), "redo order branch");
    expect(src.includes('undoStack.push({ type: "order", orderBefore, orderAfter: ents.slice() })'), "undo entry pushed");
  });

  check("draw order surfaces: ribbon buttons, act handlers, context-menu items", () => {
    expect(src.includes('data-a="dofront"') && src.includes('data-a="doback"'), "ribbon data-a");
    expect(/dofront: \(\) => executeDrawingCommand\("DRAWORDER FRONT"\)/.test(src), "act dofront");
    expect(/doback: \(\) => executeDrawingCommand\("DRAWORDER BACK"\)/.test(src), "act doback");
    expect(src.includes('rb("front", "To Front"') && src.includes('rb("back", "To Back"'), "ribbon labels");
    expect(src.includes('addItem("Path Array",()=>executeDrawingCommand("ARRAYPATH")'), "context menu Path Array");
    expect(src.includes('addItem("Bring to Front",()=>executeDrawingCommand("DRAWORDER FRONT")'), "context menu Bring to Front");
    expect(src.includes('addItem("Send to Back",()=>executeDrawingCommand("DRAWORDER BACK")'), "context menu Send to Back");
    expect(src.includes('  | "arpath"'), "Tool union arpath");
  });

  check("package.json: test:cad-draw-order script registered", () => {
    expect(pkg.scripts["test:cad-draw-order"] === "node tests/cad-draw-order-tools.test.cjs", `got ${pkg.scripts["test:cad-draw-order"]}`);
  });

  console.log(`\ndraw-order tools: ${passed} passed, ${failed} failed`);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("suite crashed:", err);
  process.exit(1);
});
