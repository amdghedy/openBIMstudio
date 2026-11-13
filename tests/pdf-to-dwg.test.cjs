/* PDF -> DWG in one step, with the REAL pdf.js extractor and the REAL committed CAD WASM (Node, no mocks).
 * Builds a 3-page vector PDF (page 3 is empty), converts it, reads the produced DWGs back with the real reader.
 * Proves OUR conversion keeps the content; it does not prove AutoCAD opens the file. */
const fs = require("fs"), path = require("path"), assert = require("assert");
const repo = path.join(__dirname, "..");
const wasmPath = path.join(repo, "public", "cad-engine", "obim-cad-engine.wasm");
if (!fs.existsSync(wasmPath)) { console.log("SKIP: CAD engine wasm missing"); process.exit(0); }
const outDir = path.join(repo, ".tmp-pdf-to-dwg-test");

function buildPdf() {
  const streams = [
    ["0 0 0 RG 1 w", "100 100 m 300 100 l 300 200 l S", "0 0 1 RG", "100 300 m 400 300 l S", "BT /F1 12 Tf 100 500 Td (HELLO PAGE ONE) Tj ET"].join("\n"),
    ["1 0 0 RG 2 w", "50 50 200 100 re S"].join("\n"),
    "",
  ];
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>";
  const page = (cid) => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 9 0 R >> >> /Contents ${cid} 0 R >>`;
  objs[3] = page(4); objs[4] = `<< /Length ${streams[0].length} >>\nstream\n${streams[0]}\nendstream`;
  objs[5] = page(6); objs[6] = `<< /Length ${streams[1].length} >>\nstream\n${streams[1]}\nendstream`;
  objs[7] = page(8); objs[8] = `<< /Length 0 >>\nstream\n\nendstream`;
  objs[9] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let pdf = "%PDF-1.4\n"; const off = [0];
  for (let i = 1; i < objs.length; i++) { off[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const x = pdf.length;
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) pdf += `${String(off[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

(async () => {
  fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
  const entry = path.join(outDir, "entry.ts");
  fs.writeFileSync(entry, `export * from "../src/modules/drawings/pdf-to-dwg";\nexport { setAcadEngineForTests, parseWithAcadEngine } from "../src/modules/drawings/acad-engine";\n`);
  const { rolldown } = require("rolldown");
  const b = await rolldown({ input: entry, platform: "node", external: (id) => id === "pdfjs-dist" || id.startsWith("pdfjs-dist/") });
  await b.write({ format: "cjs", dir: outDir, entryFileNames: "bundle.cjs", chunkFileNames: "chunk-[hash].cjs" }); await b.close();
  const M = require(path.join(outDir, "bundle.cjs"));
  let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
  try {
    const wasm = fs.readFileSync(wasmPath);
    ok(await M.setAcadEngineForTests(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)), "engine loads");

    // page specs
    assert.deepStrictEqual(M.parsePageSpec("all", 3), [1, 2, 3]); n++;
    assert.deepStrictEqual(M.parsePageSpec("", 3), [1, 2, 3]); n++;
    assert.deepStrictEqual(M.parsePageSpec("3, 1-2", 3), [1, 2, 3]); n++;
    assert.deepStrictEqual(M.parsePageSpec("2,2,2", 3), [2]); n++;
    for (const bad of ["4", "0", "2-1", "x", "1-9"]) { assert.throws(() => M.parsePageSpec(bad, 3), bad); n++; }

    const pdf = buildPdf();
    const res = await M.convertPdfToDwg(pdf, "My Plan.pdf", { format: "dwg" });
    ok(res.pageCount === 3, "page count " + res.pageCount);
    ok(res.files.length === 2, "two pages produce files: " + res.files.map((f) => f.name));
    ok(res.files[0].name === "My Plan-p1.dwg" && res.files[1].name === "My Plan-p2.dwg", "names per page: " + res.files.map((f) => f.name));
    ok(res.skipped.length === 1 && res.skipped[0].page === 3 && /no vector content/.test(res.skipped[0].reason), "empty page 3 is reported, not silently dropped: " + JSON.stringify(res.skipped));
    for (const f of res.files) ok(Buffer.from(f.data.subarray(0, 6)).toString().startsWith("AC10"), f.name + " has a binary DWG signature");

    const p1 = (await M.parseWithAcadEngine(res.files[0].data, "p1.dwg")).doc;
    const cnt = (d, t) => d.entities.filter((e) => e.type === t).length;
    ok(cnt(p1, "LINE") + cnt(p1, "LWPOLYLINE") + cnt(p1, "POLYLINE") >= 2, `page 1 lines/polylines survive the DWG (LINE ${cnt(p1, "LINE")}, LWPOLYLINE ${cnt(p1, "LWPOLYLINE")})`);
    ok(p1.entities.some((e) => e.type === "TEXT" && /HELLO PAGE ONE/.test(e.value || "")), "page 1 text survives the DWG");
    const xs = p1.entities.flatMap((e) => e.type === "LINE" ? [e.start.x, e.end.x] : []);
    ok(xs.length === 0 || Math.max(...xs) > 100 && Math.max(...xs) < 200, "true-size mm: x=400 pt is about 141 mm (" + Math.max(...xs) + ")");
    const p2 = (await M.parseWithAcadEngine(res.files[1].data, "p2.dwg")).doc;
    ok(p2.entities.length >= 1, "page 2 has content in its DWG");

    const only2 = await M.convertPdfToDwg(pdf, "My Plan.pdf", { pages: [2] });
    ok(only2.files.length === 1 && only2.files[0].page === 2 && only2.skipped.length === 0, "only the requested page");
    const dxf = await M.convertPdfToDwg(pdf, "My Plan.pdf", { pages: [1], format: "dxf" });
    ok(dxf.files[0].name.endsWith(".dxf") && Buffer.from(dxf.files[0].data).toString().includes("SECTION"), "DXF output is text DXF");
    let threw = false; try { await M.convertPdfToDwg(pdf, "x.pdf", { pages: [9] }); } catch { threw = true; }
    ok(threw, "an out-of-range page list is an error, not an empty success");
    console.log(`pdf-to-dwg: ${n} assertions passed`);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
})().catch((e) => { fs.rmSync(outDir, { recursive: true, force: true }); console.error("FAIL", e && e.stack || e); process.exit(1); });
