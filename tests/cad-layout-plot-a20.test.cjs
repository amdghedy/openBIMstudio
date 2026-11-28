// AutoCAD 2D parity A20 — CAD layouts as vector PDF (node test).
//
// Proved fail-without-fix against the base: `cad-layout-plot.ts` is new
// here, so the tsc compile below fails there (TS6053) and the suite never
// runs. The geometry assertions also fail on the old semantics: there is
// no model -> sheet transform or viewport clipping anywhere in the
// batch plotter, so a layout's model content could never reach a PDF.
//
// No mocks: the real collection, colour resolution, tessellation and
// pdf-lib drawing are the shipped ones; the PDF assertions read the
// decoded content stream of a real saved PDF.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-layout-plot-a20-"));
try { fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* pdf-lib is a runtime dep of the compiled plot module */ }
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
execSync(
  "npx tsc src/modules/export/cad-layout-plot.ts src/modules/export/pdf.ts " +
    "src/modules/cad-viewer/cad-viewport-a8.ts src/modules/cad-viewer/viewer-math.ts " +
    "src/modules/drawings/block-refs.ts src/modules/drawings/dxf-geometry.ts " +
    "src/modules/drawings/dxf-types.ts src/modules/drawings/aci.ts " +
    "src/modules/drawings/cad-styles.ts src/modules/drawings/hatch-patterns.ts " +
    "src/modules/views/scene.ts src/modules/views/hatch-patterns.ts " +
    "src/modules/filled-regions/polygon.ts " +
    "--outDir " + out + " --module commonjs --target es2020 --skipLibCheck --esModuleInterop",
  { cwd: root, stdio: "pipe" },
);
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const P = require(find(out, "cad-layout-plot.js"));
const { PDFDocument, StandardFonts } = require("pdf-lib");

const PT = 72 / 25.4; // exact mm -> pt

const line = (x1, y1, x2, y2, extra = {}) => ({ type: "LINE", layer: "0", start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, ...extra });
const text = (x, y, height, value, extra = {}) => ({ type: "TEXT", layer: "0", position: { x, y }, height, value, ...extra });

// A3 landscape sheet, one viewport: centre (210,148.5), 400x280, looking
// at model (50,0) with viewHeight 100 -> scale 280/100 = 2.8.
const viewport = {
  center: { x: 210, y: 148.5 }, width: 400, height: 280,
  viewCenter: { x: 50, y: 0 }, viewHeight: 100,
};
const layoutA3 = {
  name: "Layout1", entities: [], viewports: [viewport],
  paper: "A3",
};
const layers = [{ name: "0", color: 7 }];

(async () => {
  await t("paper size: A3 layout with no setup is 420x297mm in points", async () => {
    const g = P.collectCadLayoutGeometry({ layout: layoutA3, model: [], layers });
    assert.ok(Math.abs(g.pageW - 420 * PT) < 0.01, `pageW ${g.pageW}`);
    assert.ok(Math.abs(g.pageH - 297 * PT) < 0.01, `pageH ${g.pageH}`);
  });

  await t("paper size: a named portrait A4 setup wins over the layout paper", async () => {
    const layout = { ...layoutA3, pageSetup: "A4P", paper: "A3" };
    const setups = { A4P: { name: "A4P", paper: "A4", orient: "portrait", scale: "fit", area: "layout" } };
    const g = P.collectCadLayoutGeometry({ layout, model: [], setups, layers });
    assert.ok(Math.abs(g.pageW - 210 * PT) < 0.01, `pageW ${g.pageW}`);
    assert.ok(Math.abs(g.pageH - 297 * PT) < 0.01, `pageH ${g.pageH}`);
  });

  await t("viewport transform: model LINE (0,0)-(100,0) lands at (70,148.5)-(350,148.5)", async () => {
    const g = P.collectCadLayoutGeometry({ layout: layoutA3, model: [line(0, 0, 100, 0)], layers });
    const hit = g.segments.find((s) => Math.abs(s.y1 - 148.5) < 1e-9 && Math.abs(s.x1 - 70) < 1e-9);
    assert.ok(hit, `segments: ${JSON.stringify(g.segments)}`);
    assert.ok(Math.abs(hit.x2 - 350) < 1e-9 && Math.abs(hit.y2 - 148.5) < 1e-9, `hit: ${JSON.stringify(hit)}`);
  });

  await t("viewport clipping: a LINE crossing the viewport is cut at the rect (10,148.5)-(410,148.5)", async () => {
    const g = P.collectCadLayoutGeometry({ layout: layoutA3, model: [line(-100, 0, 300, 0)], layers });
    const hit = g.segments.find((s) => Math.abs(s.y1 - 148.5) < 1e-9);
    assert.ok(hit, `segments: ${JSON.stringify(g.segments)}`);
    assert.ok(Math.abs(hit.x1 - 10) < 1e-9 && Math.abs(hit.x2 - 410) < 1e-9, `hit: ${JSON.stringify(hit)}`);
  });

  await t("paper entities draw in sheet coords, untransformed", async () => {
    const layout = { ...layoutA3, entities: [line(10, 10, 410, 10)] };
    const g = P.collectCadLayoutGeometry({ layout, model: [], layers });
    const hit = g.segments.find((s) => Math.abs(s.y1 - 10) < 1e-9 && Math.abs(s.x1 - 10) < 1e-9);
    assert.ok(hit, `segments: ${JSON.stringify(g.segments)}`);
    assert.ok(Math.abs(hit.x2 - 410) < 1e-9, `hit: ${JSON.stringify(hit)}`);
  });

  await t("INSERT resolves through the block table, then through the viewport", async () => {
    const blocks = { CHAIR: { name: "CHAIR", base: { x: 0, y: 0 }, attdefs: [], entities: [line(0, 0, 10, 0)] } };
    const ins = { type: "INSERT", layer: "0", name: "CHAIR", position: { x: 10, y: 20 }, scale: { x: 2, y: 2 } };
    const g = P.collectCadLayoutGeometry({ layout: layoutA3, model: [ins], blocks, layers });
    // Resolved model LINE (10,20)-(30,20) -> sheet (98,204.5)-(154,204.5).
    const hit = g.segments.find((s) => Math.abs(s.y1 - 204.5) < 1e-9 && Math.abs(s.x1 - 98) < 1e-9);
    assert.ok(hit, `segments: ${JSON.stringify(g.segments)}`);
    assert.ok(Math.abs(hit.x2 - 154) < 1e-9, `hit: ${JSON.stringify(hit)}`);
  });

  await t("LWPOLYLINE bulge tessellates to an arc, not a chord", async () => {
    // A +1 bulge is counter-clockwise, so the semicircle dips BELOW the
    // (100,100)-(110,100) chord to an apex at (105,95); the chord alone
    // would stay at y=100. The polyline sits at y=100 so the whole arc
    // stays inside the page (a chord at y=0 would be clipped away).
    const pl = { type: "LWPOLYLINE", layer: "0", points: [{ x: 100, y: 100 }, { x: 110, y: 100 }], bulges: [1], closed: false };
    const layout = { ...layoutA3, viewports: [], entities: [pl] };
    const g = P.collectCadLayoutGeometry({ layout, model: [], layers });
    assert.strictEqual(g.segments.length, 16, `segments: ${g.segments.length}`);
    const minY = Math.min(...g.segments.map((s) => Math.min(s.y1, s.y2)));
    assert.ok(minY > 94.9 && minY < 95.1, `apex y ${minY}`);
  });

  await t("CIRCLE tessellates to 72 segments; ARC 0-90 to 18", async () => {
    const circle = { type: "CIRCLE", layer: "0", center: { x: 100, y: 100 }, radius: 10 };
    const arc = { type: "ARC", layer: "0", center: { x: 200, y: 200 }, radius: 10, startAngle: 0, endAngle: 90 };
    const layout = { ...layoutA3, viewports: [], entities: [circle, arc] };
    const g = P.collectCadLayoutGeometry({ layout, model: [], layers });
    const near = (cx, cy) => g.segments.filter((s) => Math.hypot(s.x1 - cx, s.y1 - cy) < 11 && Math.hypot(s.x2 - cx, s.y2 - cy) < 11);
    assert.strictEqual(near(100, 100).length, 72);
    assert.strictEqual(near(200, 200).length, 18);
    for (const s of near(100, 100)) {
      assert.ok(Math.abs(Math.hypot(s.x1 - 100, s.y1 - 100) - 10) < 0.05, `radius drift ${JSON.stringify(s)}`);
    }
  });

  await t("TEXT: paper text keeps size; model text scales by the viewport scale", async () => {
    const layout = { ...layoutA3, entities: [text(20, 280, 5, "LAYOUT1")] };
    const g = P.collectCadLayoutGeometry({ layout, model: [text(50, 0, 10, "MODEL")], layers });
    const paper = g.texts.find((x) => x.value === "LAYOUT1");
    assert.ok(paper, `texts: ${JSON.stringify(g.texts)}`);
    assert.ok(Math.abs(paper.x - 20) < 1e-9 && Math.abs(paper.y - 280) < 1e-9, `paper: ${JSON.stringify(paper)}`);
    assert.ok(Math.abs(paper.size - 5 * PT) < 0.01, `paper size ${paper.size}`);
    const model = g.texts.find((x) => x.value === "MODEL");
    assert.ok(model, `texts: ${JSON.stringify(g.texts)}`);
    assert.ok(Math.abs(model.x - 210) < 1e-9 && Math.abs(model.y - 148.5) < 1e-9, `model: ${JSON.stringify(model)}`);
    assert.ok(Math.abs(model.size - 10 * 2.8 * PT) < 0.01, `model size ${model.size}`);
  });

  await t("DIMENSION draws nothing; its geometry sibling still draws; invisible is skipped", async () => {
    const dim = { type: "DIMENSION", layer: "0", dimId: "D1", defPoint: { x: 0, y: 0 } };
    const geom = line(0, 0, 10, 0, { meta: { dimId: "D1" } });
    const hidden = line(20, 20, 30, 20, { invisible: true });
    const layout = { ...layoutA3, viewports: [], entities: [dim, geom, hidden] };
    const g = P.collectCadLayoutGeometry({ layout, model: [], layers });
    assert.strictEqual(g.segments.length, 1, `segments: ${JSON.stringify(g.segments)}`);
    assert.ok(Math.abs(g.segments[0].x2 - 10) < 1e-9, `seg: ${JSON.stringify(g.segments[0])}`);
  });

  await t("colour: true colour > ACI (1 = red) > layer colour (7 = black on paper)", async () => {
    const red = line(0, 0, 1, 0, { color: 1 });
    const green = line(0, 1, 1, 1, { rgb: 0x00ff00 });
    const bylayer = line(0, 2, 1, 2);
    const layout = { ...layoutA3, viewports: [], entities: [red, green, bylayer] };
    const g = P.collectCadLayoutGeometry({ layout, model: [], layers });
    const at = (y) => g.segments.find((s) => Math.abs(s.y1 - y) < 1e-9);
    assert.deepStrictEqual(at(0).color, { r: 1, g: 0, b: 0 });
    assert.deepStrictEqual(at(1).color, { r: 0, g: 1, b: 0 });
    assert.deepStrictEqual(at(2).color, { r: 0, g: 0, b: 0 });
  });

  await t("lineweight in mm becomes points; default is 0.7pt", async () => {
    const heavy = line(0, 0, 1, 0, { lineweight: 0.5 });
    const plain = line(0, 1, 1, 1);
    const layout = { ...layoutA3, viewports: [], entities: [heavy, plain] };
    const g = P.collectCadLayoutGeometry({ layout, model: [], layers });
    const at = (y) => g.segments.find((s) => Math.abs(s.y1 - y) < 1e-9);
    assert.ok(Math.abs(at(0).width - 0.5 * PT) < 0.01, `width ${at(0).width}`);
    assert.strictEqual(at(1).width, 0.7);
  });

  await t("drawn PDF: one A3 page whose decoded content stream holds the vector LINE", async () => {
    const layout = { ...layoutA3, entities: [text(20, 280, 5, "LAYOUT1")] };
    const g = P.collectCadLayoutGeometry({ layout, model: [line(0, 0, 100, 0)], layers });
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([g.pageW, g.pageH]);
    P.drawCadLayoutOnPage(page, g, regular, bold);
    const bytes = await doc.save();
    const loaded = await PDFDocument.load(bytes);
    assert.strictEqual(loaded.getPageCount(), 1);
    const lp = loaded.getPage(0);
    assert.ok(Math.abs(lp.getWidth() - 420 * PT) < 0.01, `w ${lp.getWidth()}`);
    assert.ok(Math.abs(lp.getHeight() - 297 * PT) < 0.01, `h ${lp.getHeight()}`);
    // The content stream is Flate-compressed on disk; inflate it with
    // zlib and assert the vector operators + the model LINE's coords.
    // (Contents() is a PDFArray of refs even for a single stream.)
    const refs = lp.node.Contents().asArray();
    assert.ok(refs.length >= 1, "page has no content stream");
    const stream = loaded.context.lookup(refs[0]);
    let content;
    try {
      content = require("zlib").inflateSync(Buffer.from(stream.getContents())).toString("latin1");
    } catch {
      content = Buffer.from(stream.getContents()).toString("latin1");
    }
    assert.ok(content.includes(" m") && content.includes(" l"), `no line operators in: ${content.slice(0, 200)}`);
    // Model LINE (70,148.5)-(350,148.5) mm in points.
    assert.ok(content.includes("198.42"), `x1 missing in: ${content.slice(0, 400)}`);
    assert.ok(content.includes("992.12") || content.includes("992.13"), `x2 missing in: ${content.slice(0, 400)}`);
    assert.ok(content.includes("420.94") || content.includes("420.95"), `y missing in: ${content.slice(0, 400)}`);
    assert.ok(content.includes("BT"), "no text operators (the LAYOUT1 text)");
  });

  await t("clipSegment: a segment fully outside returns null; a crossing one is cut", async () => {
    const r = { minX: 10, minY: 10, maxX: 20, maxY: 20 };
    assert.strictEqual(P.clipSegment(0, 0, 5, 5, r), null);
    const cut = P.clipSegment(0, 15, 30, 15, r);
    assert.ok(cut, "expected a cut segment");
    assert.ok(Math.abs(cut[0].x - 10) < 1e-9 && Math.abs(cut[1].x - 20) < 1e-9, `cut: ${JSON.stringify(cut)}`);
  });

  /* ── 2D-25: Model vector plot over a synthetic full-page viewport ── */
  const modelSetup = { name: "__model__", paper: "A3", orient: "landscape", scale: "fit", area: "extents" };
  const modelArea = { minX: 10, minY: 10, maxX: 110, maxY: 60 }; // 100 x 50 model units
  const modelLayout = P.modelVectorLayout(modelArea, "fit", modelSetup);

  await t("2D-25: modelVectorLayout builds a full-page viewport over the Model area, fit", async () => {
    assert.strictEqual(modelLayout.name, "Model");
    assert.strictEqual(modelLayout.viewports.length, 1);
    const vp = modelLayout.viewports[0];
    assert.ok(Math.abs(vp.center.x - 210) < 1e-9 && Math.abs(vp.center.y - 148.5) < 1e-9, `centre: ${JSON.stringify(vp.center)}`);
    assert.ok(Math.abs(vp.width - 420) < 1e-9 && Math.abs(vp.height - 297) < 1e-9, `size: ${vp.width}x${vp.height}`);
    assert.ok(Math.abs(vp.viewCenter.x - 60) < 1e-9 && Math.abs(vp.viewCenter.y - 35) < 1e-9, `viewCenter: ${JSON.stringify(vp.viewCenter)}`);
    assert.ok(Math.abs(vp.scale - 4.2) < 1e-9, `fit scale: ${vp.scale}`);
    assert.strictEqual(vp.hideBorder, true, "the synthetic viewport must not draw a border");
    assert.strictEqual(modelLayout.pageSetup, "__model__");
  });

  await t("2D-25: Model fit plot maps the area across the full page with no border", async () => {
    const g = P.collectCadLayoutGeometry({ layout: modelLayout, model: [line(10, 10, 110, 10), line(10, 10, 10, 60)], setups: { __model__: modelSetup }, layers });
    assert.ok(Math.abs(g.pageW - 420 * PT) < 0.01, `pageW ${g.pageW}`);
    assert.ok(Math.abs(g.pageH - 297 * PT) < 0.01, `pageH ${g.pageH}`);
    // Exactly the two model LINEs — the 4 border segments are absent.
    assert.strictEqual(g.segments.length, 2, `segments: ${JSON.stringify(g.segments)}`);
    const h = g.segments.find((s) => Math.abs(s.y1 - 43.5) < 1e-9);
    assert.ok(h && Math.abs(h.x1) < 1e-9 && Math.abs(h.x2 - 420) < 1e-9, `horizontal LINE: ${JSON.stringify(h)}`);
    const v = g.segments.find((s) => Math.abs(s.x1) < 1e-9 && Math.abs(s.x2) < 1e-9 && Math.abs(s.y1 - 43.5) < 1e-9);
    assert.ok(v && Math.abs(v.y2 - 253.5) < 1e-9, `vertical LINE: ${JSON.stringify(v)}`);
    assert.ok(!g.segments.some((s) => s.y1 < 1 || s.y1 > 296 || s.y2 < 1 || s.y2 > 296), "a border segment touches the page edge");
  });

  await t("2D-25: Model numeric scale (1:50) centres the area at that scale", async () => {
    const setup = { ...modelSetup, scale: 0.02 };
    const layout = P.modelVectorLayout(modelArea, 0.02, setup);
    const g = P.collectCadLayoutGeometry({ layout, model: [line(10, 10, 110, 10)], setups: { __model__: setup }, layers });
    assert.strictEqual(g.segments.length, 1, `segments: ${JSON.stringify(g.segments)}`);
    const s = g.segments[0];
    assert.ok(Math.abs(s.x1 - 209) < 1e-9 && Math.abs(s.x2 - 211) < 1e-9 && Math.abs(s.y1 - 148) < 1e-9, `1:50 LINE: ${JSON.stringify(s)}`);
  });

  await t("2D-25: Model portrait setup resolves through the named-setup path", async () => {
    const setup = { name: "__model__", paper: "A4", orient: "portrait", scale: "fit", area: "extents" };
    const layout = P.modelVectorLayout(modelArea, "fit", setup);
    const g = P.collectCadLayoutGeometry({ layout, model: [], setups: { __model__: setup }, layers });
    assert.ok(Math.abs(g.pageW - 210 * PT) < 0.01, `pageW ${g.pageW}`);
    assert.ok(Math.abs(g.pageH - 297 * PT) < 0.01, `pageH ${g.pageH}`);
  });

  await t("2D-25: the PLOT dialog offers Vector PDF for Model through the layout pipeline", async () => {
    const cv = fs.readFileSync(path.join(root, "src", "features", "cad-viewer.ts"), "utf8");
    assert.ok(!/Model vector plot is a follow-up/.test(cv), "the follow-up refusal must be gone");
    assert.ok(/modelVectorLayout\(box, o\.scale, setup\)/.test(cv), "Model Vector PDF must build the synthetic layout");
    assert.ok(!/Model plots via the raster button/.test(cv), "the button title must not send Model to raster");
  });

  /* ── 2D-26: viewport twist in the vector plot ── */
  // Same A3 sheet and view as layoutA3, but the viewport is twisted
  // 90°: the model rotates by -90° around the view centre (50,0) at
  // scale 2.8, clipped to the same 400x280 window.
  const viewportTwist90 = {
    center: { x: 210, y: 148.5 }, width: 400, height: 280,
    viewCenter: { x: 50, y: 0 }, viewHeight: 100, twist: 90,
  };
  const layoutTwist90 = {
    name: "LayoutT", entities: [], viewports: [viewportTwist90],
    paper: "A3",
  };

  await t("2D-26: twisted viewport rotates model LINEs by -twist around the view centre", async () => {
    const g = P.collectCadLayoutGeometry({ layout: layoutTwist90, model: [line(0, 0, 100, 0)], layers });
    const hit = g.segments.find((s) => Math.abs(s.x1 - 210) < 1e-9 && Math.abs(s.x2 - 210) < 1e-9 && Math.abs(s.y1 - 288.5) < 1e-9);
    assert.ok(hit, `segments: ${JSON.stringify(g.segments)}`);
    assert.ok(Math.abs(hit.y2 - 8.5) < 1e-9, `hit: ${JSON.stringify(hit)}`);
  });

  await t("2D-26: twisted viewport rotates TEXT position and rotation, keeps its size", async () => {
    const g = P.collectCadLayoutGeometry({ layout: layoutTwist90, model: [text(50, 0, 10, "UP", { rotation: 30 })], layers });
    assert.strictEqual(g.texts.length, 1, `texts: ${JSON.stringify(g.texts)}`);
    const tx = g.texts[0];
    assert.ok(Math.abs(tx.x - 210) < 1e-9 && Math.abs(tx.y - 148.5) < 1e-9, `text pos: ${JSON.stringify(tx)}`);
    assert.strictEqual(tx.rotation, -60, `text rotation: ${tx.rotation}`);
    assert.ok(Math.abs(tx.size - 28 * PT) < 0.01, `text size: ${tx.size}`);
  });

  await t("2D-26: ARC through a twisted viewport rotates its tessellated points", async () => {
    const arc = { type: "ARC", layer: "0", center: { x: 50, y: 0 }, radius: 50, startAngle: 0, endAngle: 90 };
    const g = P.collectCadLayoutGeometry({ layout: layoutTwist90, model: [arc], layers });
    // Border segments are 0.35 wide; model segments 0.7 — filter the border out.
    const model = g.segments.filter((s) => s.width > 0.5);
    assert.ok(model.length > 0, `segments: ${JSON.stringify(g.segments)}`);
    const xs = model.flatMap((s) => [s.x1, s.x2]), ys = model.flatMap((s) => [s.y1, s.y2]);
    assert.ok(Math.abs(Math.min(...xs) - 210) < 0.01 && Math.abs(Math.max(...xs) - 350) < 0.01, `arc x range: ${Math.min(...xs)}..${Math.max(...xs)}`);
    assert.ok(Math.abs(Math.min(...ys) - 8.5) < 0.01 && Math.abs(Math.max(...ys) - 148.5) < 0.01, `arc y range: ${Math.min(...ys)}..${Math.max(...ys)}`);
  });

  await t("2D-26: RAY is transformed through the viewport, not clipped in model space", async () => {
    const ray = { type: "RAY", layer: "0", start: { x: 0, y: 0 }, direction: { x: 1, y: 0 } };
    const g = P.collectCadLayoutGeometry({ layout: layoutA3, model: [ray], layers });
    const hit = g.segments.find((s) => Math.abs(s.y1 - 148.5) < 1e-9 && Math.abs(s.x1 - 70) < 1e-9);
    assert.ok(hit, `untwisted RAY segments: ${JSON.stringify(g.segments)}`);
    assert.ok(Math.abs(hit.x2 - 410) < 1e-9 && Math.abs(hit.y2 - 148.5) < 1e-9, `hit: ${JSON.stringify(hit)}`);
  });

  await t("2D-26: RAY through a twisted viewport rotates its direction", async () => {
    const ray = { type: "RAY", layer: "0", start: { x: 0, y: 0 }, direction: { x: 1, y: 0 } };
    const g = P.collectCadLayoutGeometry({ layout: layoutTwist90, model: [ray], layers });
    const hit = g.segments.find((s) => Math.abs(s.x1 - 210) < 1e-9 && Math.abs(s.x2 - 210) < 1e-9 && Math.abs(s.y1 - 288.5) < 1e-9);
    assert.ok(hit, `twisted RAY segments: ${JSON.stringify(g.segments)}`);
    assert.ok(Math.abs(hit.y2 - 8.5) < 1e-9, `hit: ${JSON.stringify(hit)}`);
  });

  await t("2D-26: the plotter uses the shared viewport transform (twist-aware)", async () => {
    const src = fs.readFileSync(path.join(root, "src", "modules", "export", "cad-layout-plot.ts"), "utf8");
    assert.ok(/modelToSheet\(vp, p\)/.test(src), "collectCadLayoutGeometry must use modelToSheet");
    assert.ok(!/viewport twist: the view rotation is not applied/.test(src), "the twist follow-up note must be gone");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
