// AutoCAD 2D parity A9 — DWG geometry-baking fix: space-aware add targeting
// (node test).
//
// Proved fail-without-fix against the base: `cad-space-add.ts` is new here,
// so the tsc compile below fails there (TS6053) and the suite never runs.
// The paper-space test also fails on the old viewer semantics: `addEntities`
// pushed into both the sheet list and `modelEnts` with no space guard, so a
// DWG re-import while a layout was on screen baked the model into the layout
// AND the model — QSAVE then wrote 24 LINE records for an 8-LINE drawing
// (16 model + 8 layout) with the dimension text tripled.
//
// The stage-level loop test is a regression pin, not fail-without-fix: the
// node path (writer -> WASM converter -> parseWithAcadEngine -> merge ->
// save) was already clean — the probe re-run on this branch gives stage 5
// exactly 16 LINE records (9 ENTITIES + 7 in the *D1 block), 2 TEXTs,
// 1 DIMENSION and '100.00 mm' x3 (plain TEXT + *D TEXT + DIMENSION group 1:
// merge semantics, two copies of the drawing, not baking). The browser spec
// cad-dwg-baking-a9.spec.ts carries the fail-without-fix for the viewer side
// (24 LINEs on base, 16 after the fix, layouts empty).
//
// No mocks: the real writer, reader, dimension builders and the committed
// acadrust WASM under test are the shipped ones. One converter limit is
// asserted as observed behaviour with its follow-up named, not hidden: the
// converter carries no DIMENSION entity — only the dimension's drawn geometry
// survives as plain LINEs + TEXT, so a merged drawing's QSAVE has 1 DIMENSION
// (the live one) and the incoming dimension arrives as plain geometry. That
// needs a Rust-side change.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-space-add-a9-"));
try { fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* zod is a runtime dep of compiled safeLoad (PE-20) */ }
const wasmPath = path.join(root, "public", "cad-engine", "obim-cad-engine.wasm");
if (!fs.existsSync(wasmPath)) { console.log("SKIP: public/cad-engine/obim-cad-engine.wasm is missing (build cad-engine-rust first)"); process.exit(0); }
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const P = (x, y) => ({ x, y, z: 0 });
execSync(
  "npx tsc src/modules/cad-viewer/cad-space-add.ts src/modules/drawings/acad-engine.ts src/modules/drawings/dxf-writer.ts src/modules/drawings/dxf-reader.ts " +
    "src/modules/cad-viewer/dimension-system.ts src/modules/cad-viewer/dimension-tools.ts " +
    "--outDir " + out + " --module commonjs --target es2020 --skipLibCheck --esModuleInterop",
  { cwd: root, stdio: "pipe" },
);
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const S = require(find(out, "cad-space-add.js"));
const A = require(find(out, "acad-engine.js"));
const W = require(find(out, "dxf-writer.js"));
const R = require(find(out, "dxf-reader.js"));
const sys = require(find(out, "dimension-system.js"));

(async () => {
  await t("addTargets: model space, ents IS modelEnts — one target, no double push", async () => {
    const model = [{ id: 1 }];
    const targets = S.addTargets(-1, model, model);
    assert.strictEqual(targets.length, 1);
    assert.strictEqual(targets[0], model);
    S.pushToTargets(targets, [{ id: 2 }]);
    assert.strictEqual(model.length, 2, "entity pushed once, not twice");
  });

  await t("addTargets: model space, ents rebound away from modelEnts — both stay in sync", async () => {
    const model = [{ id: 1 }];
    const rebound = [{ id: 1 }];
    const targets = S.addTargets(-1, model, rebound);
    assert.strictEqual(targets.length, 2);
    S.pushToTargets(targets, [{ id: 2 }]);
    assert.strictEqual(model.length, 2);
    assert.strictEqual(rebound.length, 2);
  });

  await t("addTargets: paper space — the sheet only, the model is never touched (the baking bug)", async () => {
    const model = [{ id: 1 }];
    const sheet = [];
    const targets = S.addTargets(0, model, sheet);
    assert.strictEqual(targets.length, 1, "old code returned [sheet, model]");
    assert.strictEqual(targets[0], sheet);
    S.pushToTargets(targets, [{ id: 2 }, { id: 3 }]);
    assert.strictEqual(sheet.length, 2);
    assert.strictEqual(model.length, 1, "model list unpolluted by a paper-space add");
    const targets1 = S.addTargets(1, model, sheet);
    assert.strictEqual(targets1.length, 1);
  });

  await t("mergeTargets: an import merge lands in the model list only, whatever is on screen", async () => {
    const model = [{ id: 1 }];
    const sheet = [];
    const targets = S.mergeTargets(model);
    assert.strictEqual(targets.length, 1);
    assert.strictEqual(targets[0], model);
    S.pushToTargets(targets, [{ id: 2 }]);
    assert.strictEqual(model.length, 2);
    assert.strictEqual(sheet.length, 0);
  });

  // ── Stage-level DWG loop pin (A19 fixture shape) ──────────────────────
  const wasm = fs.readFileSync(wasmPath);
  if (!(await A.setAcadEngineForTests(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)))) { console.log("  SKIP engine unavailable"); return; }

  const style = sys.defaultDimStyles()[0];
  const dimRec = { id: "dim-linear", styleName: "ISO-25", mode: "linear", layer: "DIMS", p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, placement: { x: 50, y: 20 } };
  const dimGeom = sys.buildDimEntities(dimRec, style, "100.00");
  const dimEnt = { type: "DIMENSION", layer: "DIMS", dimId: "dim-linear", dimType: 0, styleName: "ISO-25", defPoint: { x: 50, y: 20 }, textPoint: { x: 50, y: 20 }, extOrigin1: { x: 0, y: 0 }, extOrigin2: { x: 100, y: 0 }, text: "100.00" };
  const doc = {
    units: "mm",
    layers: [{ name: "0", color: 7 }, { name: "DIMS", color: 3 }],
    entities: [
      { type: "LINE", layer: "0", start: P(0, 0), end: P(100, 0) },
      { type: "LWPOLYLINE", layer: "0", points: [P(0, 0), P(50, 0), P(50, 50)], bulges: [0, 1, 0] },
      ...dimGeom, dimEnt,
    ],
    layouts: [
      { name: "Layout1", entities: [], viewports: [{ center: P(148, 210), width: 277, height: 400, viewCenter: P(50, 25), viewHeight: 20000, scale: 0.02 }] },
      { name: "Layout2", entities: [], viewports: [{ center: P(148, 210), width: 277, height: 400, viewCenter: P(50, 25), viewHeight: 1600, scale: 0.25 }] },
    ],
  };
  const countType = (text, type) => (text.match(new RegExp(`^0\\n${type}$`, "gm")) || []).length;

  await t("DWG loop: writer -> converter -> parse -> model merge -> save is exactly 2x, layouts empty", async () => {
    const dxf1 = W.writeDxf(doc);
    assert.strictEqual(countType(dxf1, "LINE"), 8, "stage 1: 1 ENTITIES LINE + 7 in the *D1 block");
    const dwg = await A.exportDxfToDwg(dxf1);
    assert.ok(dwg && dwg.length > 0);
    const res = await A.parseWithAcadEngine(dwg, "a9.dwg");
    const parsed = res.doc;
    const incoming = parsed.entities.filter((e) => e.type !== "DIMENSION");
    assert.strictEqual(incoming.filter((e) => e.type === "LINE").length, 8, "stage 3: converter returns 8 model LINEs");
    assert.strictEqual(incoming.filter((e) => e.type === "DIMENSION").length, 0, "converter drops DIMENSION (Rust follow-up)");
    assert.strictEqual((parsed.layouts ?? []).length, 2);
    for (const l of parsed.layouts) assert.strictEqual((l.entities ?? []).length, 0, `stage 3: ${l.name} carries no entities`);
    // The merge targets the model list only (mergeTargets), never the sheet
    // on screen — the viewer-side half of the fix; here it is the list the
    // QSAVE below serialises from.
    const model = doc.entities.slice();
    S.pushToTargets(S.mergeTargets(model), incoming);
    assert.strictEqual(model.filter((e) => e.type === "LINE").length, 16, "stage 4: merged model has 16 LINEs (8 + 8)");
    const saved = W.writeDxf({ ...doc, entities: model });
    assert.strictEqual(countType(saved, "LINE"), 16, "stage 5: QSAVE writes 16 LINE records, not 24");
    assert.strictEqual(countType(saved, "TEXT"), 2, "stage 5: 2 TEXT records (live + merged plain copy)");
    assert.strictEqual(countType(saved, "DIMENSION"), 1, "stage 5: 1 DIMENSION (the live record; the incoming one arrived as plain geometry)");
    assert.strictEqual((saved.match(/100\.00/g) || []).length, 3, "stage 5: '100.00' x3 is merge semantics (plain TEXT + *D TEXT + DIMENSION group 1)");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
