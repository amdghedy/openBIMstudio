/* Real DXF -> DWG -> read-back round trip.
 * Runs the committed acadrust WASM (public/cad-engine/obim-cad-engine.wasm) in Node:
 * what the CAD editor's DXF writer produces is converted to a binary DWG by the real
 * writer and read back by the real reader. No mocks. This proves the subset below
 * survives OUR converter; it does not prove Drafting opens the file. */
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const { execSync } = require("child_process");
const root = path.join(__dirname, "..");
const wasmPath = path.join(root, "public", "cad-engine", "obim-cad-engine.wasm");
if (!fs.existsSync(wasmPath)) { console.log("SKIP: public/cad-engine/obim-cad-engine.wasm is missing (build cad-engine-rust first)"); process.exit(0); }
const out = fs.mkdtempSync(path.join(os.tmpdir(), "cad-dwg-rt-"));
execSync(`npx tsc src/modules/drawings/acad-engine.ts src/modules/drawings/dxf-writer.ts src/modules/drawings/dxf-reader.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop`, { cwd: root, stdio: "pipe" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const A = require(find(out, "acad-engine.js")), W = require(find(out, "dxf-writer.js"));

let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const P = (x, y) => ({ x, y, z: 0 });
const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]].map(([a, b]) => P(a, b));
const doc = () => ({
  units: "mm",
  layers: [{ name: "0", color: 7 }, { name: "WALLS", color: 1, lineType: "DASHED", lineweight: 0.35 }, { name: "OFF", color: 3, off: true }],
  entities: [
    { type: "LINE", layer: "WALLS", start: P(0, 0), end: P(100, 0), lineType: "CENTER", lineweight: 0.5, rgb: 0xff8800 },
    { type: "CIRCLE", layer: "0", center: P(50, 50), radius: 20 },
    { type: "TEXT", layer: "0", position: P(0, 120), height: 5, value: "Hello", style: "Arial", font: "Arial" },
    { type: "LWPOLYLINE", layer: "0", points: sq(200, 0, 50), closed: true, hatch: { solid: true, loops: [sq(200, 0, 50), sq(210, 10, 20)] } },
    { type: "LWPOLYLINE", layer: "0", points: sq(300, 0, 50), closed: true, hatch: { solid: false, pattern: "ANSI31", angle: 0, scale: 1, loops: [sq(300, 0, 50)], patternLines: [{ angle: Math.PI / 4, base: [0, 0], offset: [-2, 2], dashes: [] }] } },
  ],
  layouts: [{ name: "Sheet", entities: [{ type: "LINE", layer: "0", start: P(0, 0), end: P(420, 0) }], viewports: [{ center: P(210, 148), width: 400, height: 280, viewCenter: P(100, 50), viewHeight: 300 }] }],
});

(async () => {
  const wasm = fs.readFileSync(wasmPath);
  assert.ok(await A.setAcadEngineForTests(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)), "engine failed to load");
  const d = doc();
  const dxf = W.writeDxf(d);
  const dwg = await A.exportDxfToDwg(dxf);
  const back = (await A.parseWithAcadEngine(dwg, "rt.dwg")).doc;

  await t("the output is a real DWG (AC1024) and re-reads", () => { assert.strictEqual(Buffer.from(dwg.subarray(0, 6)).toString(), "AC1024"); assert.ok(back.entities.length >= 5); });
  await t("entity kinds survive", () => {
    const n = (f) => back.entities.filter(f).length;
    assert.strictEqual(n((e) => e.type === "LINE"), 1); assert.strictEqual(n((e) => e.type === "CIRCLE"), 1); assert.strictEqual(n((e) => e.type === "TEXT"), 1);
  });
  await t("solid and patterned hatches survive as fills, not outlines", () => {
    const h = back.entities.filter((e) => e.hatch);
    assert.strictEqual(h.length, 2);
    assert.ok(h.some((e) => e.hatch.solid)); assert.ok(h.some((e) => !e.hatch.solid));
  });
  await t("a solid hatch keeps its hole", () => assert.strictEqual(back.entities.find((e) => e.hatch && e.hatch.solid).hatch.loops.length, 2));
  await t("entity linetype, true colour and lineweight survive", () => {
    const l = back.entities.find((e) => e.type === "LINE");
    assert.strictEqual(l.lineType, "CENTER"); assert.strictEqual(l.rgb, 0xff8800); assert.strictEqual(l.lineweight, 0.5);
  });
  await t("layer linetype, lineweight and off state survive, with the linetype definitions", () => {
    const w = back.layers.find((x) => x.name === "WALLS");
    assert.strictEqual(w.lineType, "DASHED"); assert.strictEqual(w.lineweight, 0.35);
    assert.ok(back.layers.find((x) => x.name === "OFF").off);
    assert.ok(back.linetypes.DASHED && back.linetypes.CENTER);
  });
  await t("text keeps its content, height and style", () => {
    const x = back.entities.find((e) => e.type === "TEXT");
    assert.strictEqual(x.value, "Hello"); assert.strictEqual(x.height, 5); assert.strictEqual(x.style, "Arial");
  });
  await t("the first paper-space sheet and its viewport survive", () => {
    const L = (back.layouts || []).find((l) => l.viewports && l.viewports.length);
    assert.ok(L, "a layout with a viewport");
    const v = L.viewports[0]; assert.deepStrictEqual([v.width, v.height, v.viewHeight], [400, 280, 300]);
    assert.ok(L.entities.length >= 1);
  });

  await t("a single sheet comes back as one sheet, not two", async () => {
    const one = (await A.parseWithAcadEngine(await A.exportDxfToDwg(W.writeDxf(doc())), "one.dwg")).doc;
    assert.strictEqual((one.layouts || []).length, 1);
  });
  await t("several sheets survive DWG export with their entities and viewports", async () => {
    const d3 = doc();
    const vp = (w) => ({ center: P(10, 10), width: w, height: 50, viewCenter: P(0, 0), viewHeight: 100 });
    const ln = (x) => ({ type: "LINE", layer: "0", start: P(0, 0), end: P(x, 0) });
    d3.layouts = [
      { name: "A1", entities: [ln(100)], viewports: [vp(50)] },
      { name: "B", entities: [ln(200), ln(210)], viewports: [vp(60), vp(70)] },
      { name: "C", entities: [ln(300)], viewports: [] },
    ];
    const back3 = (await A.parseWithAcadEngine(await A.exportDxfToDwg(W.writeDxf(d3, { allLayouts: true })), "ml.dwg")).doc;
    assert.strictEqual(back3.layouts.length, 3);
    assert.deepStrictEqual(back3.layouts.map((l) => l.entities.length), [1, 2, 1]);
    assert.deepStrictEqual(back3.layouts.map((l) => l.viewports.length), [1, 2, 0]);
    assert.strictEqual(back3.entities.length, 5, "model space is not polluted by sheet content: " + back3.entities.map((e) => e.type).join());
  });
  await t("plain DXF still writes only the first sheet (no unverified block structure)", () => {
    const d2 = doc(); d2.layouts.push({ name: "B", entities: [], viewports: [] });
    const text = W.writeDxf(d2);
    assert.ok(!/\*Paper_Space1/.test(text));
    assert.strictEqual(W.layoutsNotSaved(d2), 1);
  });

  // Every DWG version the editor offers, through the real writer and reader.
  for (const v of W.DWG_VERSIONS) {
    await t(`version ${v.code} (${v.label}) writes a DWG of that version and keeps the content`, async () => {
      const dwgV = await A.exportDxfToDwg(W.writeDxf(doc(), { version: v.code }));
      assert.strictEqual(Buffer.from(dwgV.subarray(0, 6)).toString(), v.code);
      const b = (await A.parseWithAcadEngine(dwgV, "v.dwg")).doc;
      assert.strictEqual(b.entities.filter((e) => e.hatch).length, 2, "hatch fills");
      const l = b.entities.find((e) => e.type === "LINE");
      assert.strictEqual(l.lineType, "CENTER"); assert.strictEqual(l.lineweight, 0.5);
      if (v.code === "AC1015") assert.strictEqual(l.rgb, undefined, "no true colour before 2004");
      else assert.strictEqual(l.rgb, 0xff8800);
    });
  }
  await t("the default version is Drafting 2010 and every option has a label", () => {
    assert.strictEqual(W.DEFAULT_DWG_VERSION, "AC1024");
    assert.strictEqual(W.DWG_VERSIONS.length, 6);
    assert.strictEqual(W.dwgVersionLabel("AC1018"), "Drafting 2004 / 2005 / 2006");
  });

  // Real DWG files from the repo: DWG -> DXF -> DWG loses nothing we can see.
  for (const f of ["r11_entities_2d.dwg", "sample_2000.dwg", "sample_2018.dwg"]) {
    await t(`fixture ${f}: read, re-export and read back keeps every entity and layer`, async () => {
      const src = (await A.parseWithAcadEngine(new Uint8Array(fs.readFileSync(path.join(root, "tests", "fixtures", f))), f)).doc;
      const again = (await A.parseWithAcadEngine(await A.exportDxfToDwg(W.writeDxf(src)), "again.dwg")).doc;
      const kinds = (D) => D.entities.map((e) => e.type + (e.hatch ? "+hatch" : "")).sort().join(",");
      assert.strictEqual(kinds(again), kinds(src));
      assert.deepStrictEqual(again.layers.map((l) => l.name).sort(), src.layers.map((l) => l.name).sort());
    });
  }
  await t("the converter's own check rejects an empty drawing", async () => {
    let threw = false; try { await A.exportDxfToDwg(""); } catch { threw = true; } assert.ok(threw);
  });
  console.log(`=== Result: ${pass} passed, ${fail} failed ===`); process.exit(fail ? 1 : 0);
})();
