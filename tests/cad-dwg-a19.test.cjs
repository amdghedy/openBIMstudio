// AutoCAD 2D parity A19 — DWG write: layouts, DIMENSION + bulge inheritance,
// native blocks save-back, binary DXF + ASCII fallback (node test).
//
// Proved fail-without-fix against the base: the writer saved only the first
// layout (layoutsNotSaved = 1, no LAYOUT objects), so the two-layout DWG test
// fails there; clip had no writer/reader support, so the clip tests fail
// there; and the *D-block reorder fix (extra-sheet viewports dropped when a
// DIMENSION was present) is new here — the two-layout + DIMENSION test fails
// on base AND on the pre-reorder code.
//
// No mocks: the real writer, reader, dimension builders and the committed
// acadrust WASM under test are the shipped ones. The two converter limits
// below are asserted as observed behaviour with their follow-ups named, not
// hidden: (a) the converter carries no DIMENSION entity — only the dimension's
// drawn geometry survives as plain LINEs + TEXT; (b) the converter keeps a
// clip boundary as a plain sheet LWPOLYLINE and drops the viewport <->
// boundary link (no clip on the DWG viewport). Both need a Rust-side change.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-dwg-a19-"));
try { fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* zod is a runtime dep of compiled safeLoad (PE-20) */ }
const wasmPath = path.join(root, "public", "cad-engine", "obim-cad-engine.wasm");
if (!fs.existsSync(wasmPath)) { console.log("SKIP: public/cad-engine/obim-cad-engine.wasm is missing (build cad-engine-rust first)"); process.exit(0); }
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const P = (x, y) => ({ x, y, z: 0 });
execSync(
  "npx tsc src/modules/drawings/acad-engine.ts src/modules/drawings/dxf-writer.ts src/modules/drawings/dxf-reader.ts " +
    "src/modules/drawings/block-refs.ts src/modules/cad-viewer/dimension-system.ts src/modules/cad-viewer/dimension-tools.ts " +
    "--outDir " + out + " --module commonjs --target es2020 --skipLibCheck --esModuleInterop",
  { cwd: root, stdio: "pipe" },
);
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const A = require(find(out, "acad-engine.js"));
const W = require(find(out, "dxf-writer.js"));
const R = require(find(out, "dxf-reader.js"));
const sys = require(find(out, "dimension-system.js"));

// ── The A19 drawing: a line, a bulged polyline, a linear DIMENSION, and two
//    sheets — the first with a locked clipped viewport, the second with a
//    clipped viewport (the extra-sheet clip path through the legacy blocks).
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
    { name: "Sheet-A", entities: [], viewports: [{ center: P(148, 210), width: 277, height: 400, viewCenter: P(50, 25), viewHeight: 20000, scale: 0.02, locked: true, clip: { minX: 20, minY: 20, maxX: 200, maxY: 300 } }] },
    { name: "Sheet-B", entities: [], viewports: [{ center: P(148, 210), width: 277, height: 400, viewCenter: P(50, 25), viewHeight: 1600, scale: 0.25, clip: { minX: 30, minY: 30, maxX: 250, maxY: 350 } }] },
  ],
};
const dxf = W.writeDxf(doc);

// ── Native-blocks fixture (same DXF as tests/cad-engine-native-blocks.test.cjs).
const D = (...a) => a.flat().join("\n") + "\n";
const nativeDxf = D(0, "SECTION", 2, "HEADER", 9, "$ACADVER", 1, "AC1015", 0, "ENDSEC",
  0, "SECTION", 2, "TABLES", 0, "TABLE", 2, "LAYER", 70, 1, 0, "LAYER", 2, "0", 70, 0, 62, 7, 6, "CONTINUOUS", 0, "ENDTAB", 0, "ENDSEC",
  0, "SECTION", 2, "BLOCKS",
  0, "BLOCK", 8, "0", 2, "IN", 70, 0, 10, 0, 20, 0, 30, 0, 3, "IN", 0, "LINE", 8, "0", 10, 0, 20, 0, 30, 0, 11, 1, 21, 0, 31, 0, 0, "ENDBLK", 8, "0",
  0, "BLOCK", 8, "0", 2, "TAGB", 70, 2, 10, 0, 20, 0, 30, 0, 3, "TAGB", 0, "LINE", 8, "0", 10, 0, 20, 0, 30, 0, 11, 1, 21, 0, 31, 0,
  0, "INSERT", 8, "0", 2, "IN", 10, 3, 20, 0, 30, 0,
  0, "ATTDEF", 8, "0", 10, 1, 20, 1, 30, 0, 40, 2, 1, "dflt", 3, "Prompt?", 2, "NAME", 70, 0, 0, "ENDBLK", 8, "0", 0, "ENDSEC",
  0, "SECTION", 2, "ENTITIES", 0, "INSERT", 8, "0", 66, 1, 2, "TAGB", 10, 10, 20, 10, 30, 0, 41, 2, 42, 2, 43, 2, 50, 30, 70, 3, 71, 2, 44, 5, 45, 6,
  0, "ATTRIB", 8, "0", 10, 11, 20, 11, 30, 0, 40, 2, 1, "Val", 2, "NAME", 70, 0, 0, "SEQEND", 8, "0", 0, "ENDSEC", 0, "EOF");

(async () => {
  const wasm = fs.readFileSync(wasmPath);
  if (!(await A.setAcadEngineForTests(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)))) { console.log("  SKIP engine unavailable"); return; }

  await t("DWG round-trip: two layouts + both viewports survive with a DIMENSION present", async () => {
    // Pre-reorder this came back [1, 0]: the conformant *D block before the
    // legacy paper blocks made the converter drop the extra sheet's viewport.
    const dwg = await A.exportDxfToDwg(dxf);
    const res = await A.parseWithAcadEngine(dwg, "a19.dwg");
    assert.strictEqual((res.doc.layouts || []).length, 2);
    assert.deepStrictEqual(res.doc.layouts.map((l) => l.name), ["Paper Space", "Paper Space1"]);
    assert.deepStrictEqual(res.doc.layouts.map((l) => l.viewports.length), [1, 1]);
    assert.strictEqual(res.doc.layouts[0].viewports[0].viewHeight, 20000);
    assert.strictEqual(res.doc.layouts[1].viewports[0].viewHeight, 1600);
  });

  await t("DWG round-trip: bulge survives; DIMENSION entity does not, its geometry does", async () => {
    const dwg = await A.exportDxfToDwg(dxf);
    const res = await A.parseWithAcadEngine(dwg, "a19.dwg");
    const pl = res.doc.entities.find((e) => e.type === "LWPOLYLINE");
    assert.ok(pl, "bulged polyline lost in DWG");
    assert.deepStrictEqual(pl.bulges, [0, 1, 0]);
    // Converter limit (Rust follow-up): the converter's document model has no
    // DIMENSION entity — the dimension's drawn geometry survives as plain
    // LINEs + the TEXT "100.00", but the DIMENSION record itself is dropped.
    // The DXF writer DOES write a real DIMENSION record (A5 suite proves it).
    assert.ok(!res.doc.entities.some((e) => e.type === "DIMENSION"), "converter unexpectedly kept a DIMENSION");
    assert.ok(res.doc.entities.some((e) => e.type === "TEXT" && e.value === "100.00"), "dimension text lost in DWG");
  });

  await t("DXF stage: clip survives on both sheets and is not a drawn entity", () => {
    const back = R.parseDxf(dxf);
    assert.deepStrictEqual(back.layouts.map((l) => l.name), ["Sheet-A", "Sheet-B"]);
    assert.deepStrictEqual(back.layouts[0].viewports[0].clip, { minX: 20, minY: 20, maxX: 200, maxY: 300 });
    assert.deepStrictEqual(back.layouts[1].viewports[0].clip, { minX: 30, minY: 30, maxX: 250, maxY: 350 });
    assert.strictEqual(back.layouts[0].viewports[0].locked, true);
    assert.deepStrictEqual(back.layouts[0].entities, [], "clip boundary leaked into sheet entities");
    assert.deepStrictEqual(back.layouts[1].entities, [], "clip boundary leaked into sheet entities");
  });

  await t("DWG stage: clip boundary arrives as sheet geometry, the viewport link is not carried", async () => {
    const dwg = await A.exportDxfToDwg(dxf);
    const res = await A.parseWithAcadEngine(dwg, "a19.dwg");
    // Converter limit (Rust follow-up): the converter keeps the clip boundary
    // LWPOLYLINE as a plain entity on each sheet but has no viewport clip in
    // its model, so the 340 link is dropped. The DXF stage above is the clip
    // proof; the DWG stage keeps the sheets, viewports and the boundary
    // geometry, not the link.
    for (const l of res.doc.layouts) {
      assert.deepStrictEqual(l.entities.map((e) => e.type), ["LWPOLYLINE"], `${l.name}: clip boundary missing`);
      assert.strictEqual(l.viewports[0].clip, undefined, `${l.name}: converter unexpectedly kept a clip`);
    }
  });

  await t("native blocks: INSERT + ATTRIBs save back with attribute identity", async () => {
    const nat = await A.parseWithAcadEngine(new TextEncoder().encode(nativeDxf), "n.dxf", { nativeBlocks: true });
    const ins = nat.doc.entities.find((e) => e.type === "INSERT");
    assert.ok(ins && ins.name === "TAGB", "INSERT missing on native import");
    assert.strictEqual(ins.attributes[0].tag, "NAME");
    assert.strictEqual(ins.attributes[0].value, "Val");
    const saved = W.writeDxf(nat.doc);
    assert.ok(/0\nATTRIB/.test(saved) && saved.includes("Val"), "written DXF has no ATTRIB Val");
    const back = await A.parseWithAcadEngine(new TextEncoder().encode(saved), "n2.dxf", { nativeBlocks: true });
    const ins2 = back.doc.entities.find((e) => e.type === "INSERT");
    assert.ok(ins2 && ins2.name === "TAGB", "INSERT missing after save-back");
    assert.strictEqual(ins2.attributes[0].tag, "NAME");
    assert.strictEqual(ins2.attributes[0].value, "Val");
    assert.strictEqual(back.doc.blocks.TAGB.attdefs[0].tag, "NAME");
    assert.strictEqual(back.doc.blocks.TAGB.attdefs[0].defaultValue, "dflt");
  });

  await t("binary DXF reads via the WASM engine", async () => {
    const fp = path.join(root, "tests", "fixtures", "binary-dxf-a19.dxf");
    const bytes = new Uint8Array(fs.readFileSync(fp));
    assert.ok(bytes[0] === 65 && String.fromCharCode(...bytes.slice(0, 18)) === "AutoCAD Binary DXF", "fixture is not a binary DXF");
    const res = await A.parseWithAcadEngine(bytes, "binary-dxf-a19.dxf");
    assert.ok(res.doc.entities.some((e) => e.type === "LINE"), "LINE lost from binary DXF");
    const pl = res.doc.entities.find((e) => e.type === "LWPOLYLINE");
    assert.ok(pl, "bulged polyline lost from binary DXF");
    assert.deepStrictEqual(pl.bulges, [0, 1, 0]);
    assert.strictEqual((res.doc.layouts || []).length, 2, "binary DXF layouts lost");
  });

  await t("ASCII DXF reads via the pure-TS reader (WASM-free fallback)", () => {
    const smoke = {
      units: "mm",
      layers: [{ name: "0", color: 7 }],
      entities: [
        { type: "LINE", layer: "0", start: P(0, 0), end: P(100, 0) },
        { type: "LWPOLYLINE", layer: "0", points: [P(0, 0), P(50, 0), P(50, 50)], bulges: [0, 1, 0] },
      ],
      layouts: [
        { name: "Sheet-A", entities: [], viewports: [{ center: P(148, 210), width: 277, height: 400, viewCenter: P(50, 25), viewHeight: 20000, scale: 0.02, locked: true }] },
        { name: "Sheet-B", entities: [], viewports: [{ center: P(148, 210), width: 277, height: 400, viewCenter: P(50, 25), viewHeight: 100, scale: 4 }] },
      ],
    };
    const back = R.parseDxf(W.writeDxf(smoke));
    assert.deepStrictEqual(back.layouts.map((l) => l.name), ["Sheet-A", "Sheet-B"]);
    assert.ok(back.entities.some((e) => e.type === "LINE"));
    const pl = back.entities.find((e) => e.type === "LWPOLYLINE");
    assert.ok(pl && JSON.stringify(pl.bulges) === JSON.stringify([0, 1, 0]), "bulge lost in ASCII fallback");
    assert.strictEqual(back.layouts[0].viewports[0].locked, true);
  });

  console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
