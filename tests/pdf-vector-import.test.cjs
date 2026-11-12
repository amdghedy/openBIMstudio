/**
 * PDF Vector Import tests — "Convert PDF to Drawing" (PDFIN).
 *
 * Builds a minimal vector PDF in-memory (strokes, fill, cubic, text), runs the
 * real pdf.js extraction (legacy build under Node — the same code path the
 * browser uses), and checks the produced entities and the DXF round trip
 * through the standard writer.
 *
 * Run: npm run test:pdf-vector
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const repo = path.join(__dirname, "..");
const outDir = path.join(repo, ".tmp-pdf-vector-test");
let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}: ${err && err.message ? err.message : err}`);
  }
}

/* ── build the minimal vector PDF ──────────────────────────────────────────── */

function buildTestPdf() {
  const content = [
    "q",
    "1 0 0 1 72 72 cm",
    "0 0 0 RG 1 w",
    "10 10 m 110 10 l 110 60 l S", // 3-pt stroke -> LWPOLYLINE (black, BYLAYER)
    "0 0 1 RG",
    "0 40 m 40 90 l S", // 2-pt stroke -> LINE (blue true colour)
    "1 0 0 rg",
    "200 200 50 50 re f", // filled rect -> closed boundary on PDF Fill (red)
    "0 1 0 RG",
    "300 300 m 320 340 340 340 360 300 c S", // cubic -> flattened polyline (green)
    "Q",
    "BT /F1 12 Tf 100 400 Td (HELLO PDF) Tj ET",
  ].join("\n");
  const objs = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>";
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  objs[5] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/* ── bundle the TS modules (rolldown — the repo's bundler — repo-local outDir
   so the pdfjs-dist dynamic import resolves against the installed package) ── */

const K = 25.4 / 72; // default: true-size millimetres

(async () => {
  const outDirPrepared = (() => {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    return outDir;
  })();
  const { rolldown } = require("rolldown");
  for (const entry of ["pdf-vector", "dxf-writer"]) {
    const bundle = await rolldown({
      input: path.join(repo, "src/modules/drawings", `${entry}.ts`),
      platform: "node",
      external: (id) => id === "pdfjs-dist" || id.startsWith("pdfjs-dist/"),
    });
    await bundle.write({
      format: "cjs",
      dir: outDirPrepared,
      entryFileNames: `${entry}.cjs`,
      chunkFileNames: `${entry}-[hash].cjs`,
    });
    await bundle.close();
  }
  const { pdfToDxfDocument } = require(path.join(outDirPrepared, "pdf-vector.cjs"));
  const { writeDxf } = require(path.join(outDirPrepared, "dxf-writer.cjs"));

  console.log("pdf-vector import (Convert PDF to Drawing):");

  const bytes = buildTestPdf();
  const res = await pdfToDxfDocument(bytes);
  const doc = res.doc;

  check("page metadata: 1 page, 612x792 pt, converted page 1", () => {
    if (res.pageCount !== 1) throw new Error(`pageCount ${res.pageCount}`);
    if (Math.abs(res.pageSize.width - 612) > 0.01 || Math.abs(res.pageSize.height - 792) > 0.01)
      throw new Error(`pageSize ${res.pageSize.width}x${res.pageSize.height}`);
    if (res.page !== 1) throw new Error(`page ${res.page}`);
  });

  check("default scale: units are true-size millimetres (unitsPerInch 25.4)", () => {
    if (res.unitsPerInch !== 25.4) throw new Error(`unitsPerInch ${res.unitsPerInch}`);
    if (doc.units !== "mm") throw new Error(`units ${doc.units}`);
  });

  check("layers: 0, PDF, PDF Text, PDF Fill created", () => {
    const names = doc.layers.map((l) => l.name);
    for (const n of ["0", "PDF", "PDF Text", "PDF Fill"]) {
      if (!names.includes(n)) throw new Error(`missing layer ${n} (got ${names.join(", ")})`);
    }
  });

  check("3-pt black stroke -> open LWPOLYLINE on PDF, BYLAYER, true-size mm", () => {
    const poly = doc.entities.find((e) => e.type === "LWPOLYLINE" && e.layer === "PDF" && e.points.length === 3);
    if (!poly) throw new Error("no 3-point PDF polyline");
    if (poly.rgb !== undefined) throw new Error(`near-black should be BYLAYER, got rgb ${poly.rgb}`);
    if (poly.closed) throw new Error("stroke polyline must be open");
    const expect = (v) => Math.abs(poly.points[0].x - v) < 1e-3;
    if (!expect(82 * K)) throw new Error(`x ${poly.points[0].x} != ${82 * K}`);
    if (Math.abs(poly.points[0].y - 82 * K) > 1e-3) throw new Error(`y ${poly.points[0].y} != ${82 * K}`);
    if (Math.abs(poly.points[2].x - 182 * K) > 1e-3 || Math.abs(poly.points[2].y - 132 * K) > 1e-3)
      throw new Error(`last point ${poly.points[2].x},${poly.points[2].y}`);
  });

  check("2-pt blue stroke -> LINE with true colour 0x0000ff", () => {
    const line = doc.entities.find((e) => e.type === "LINE");
    if (!line) throw new Error("no LINE entity");
    if (line.rgb !== 0x0000ff) throw new Error(`rgb ${line.rgb}`);
    if (Math.abs(line.start.x - 72 * K) > 1e-3 || Math.abs(line.start.y - 112 * K) > 1e-3)
      throw new Error(`start ${line.start.x},${line.start.y}`);
    if (Math.abs(line.end.x - 112 * K) > 1e-3 || Math.abs(line.end.y - 162 * K) > 1e-3)
      throw new Error(`end ${line.end.x},${line.end.y}`);
  });

  check("filled rect -> closed boundary on PDF Fill with true colour 0xff0000", () => {
    const fill = doc.entities.find((e) => e.type === "LWPOLYLINE" && e.layer === "PDF Fill");
    if (!fill) throw new Error("no PDF Fill boundary");
    if (!fill.closed) throw new Error("fill boundary must be closed");
    if (fill.rgb !== 0xff0000) throw new Error(`rgb ${fill.rgb}`);
    if (fill.points.length !== 4) throw new Error(`points ${fill.points.length}`);
    if (Math.abs(fill.points[0].x - 272 * K) > 1e-3 || Math.abs(fill.points[0].y - 272 * K) > 1e-3)
      throw new Error(`corner ${fill.points[0].x},${fill.points[0].y}`);
  });

  check("cubic Bézier -> flattened polyline (1 + 16 segments), green", () => {
    const curve = doc.entities.find((e) => e.type === "LWPOLYLINE" && e.points.length === 17);
    if (!curve) throw new Error("no 17-point flattened curve");
    if (curve.rgb !== 0x00ff00) throw new Error(`rgb ${curve.rgb}`);
    if (Math.abs(curve.points[0].x - 372 * K) > 1e-3 || Math.abs(curve.points[0].y - 372 * K) > 1e-3)
      throw new Error(`start ${curve.points[0].x},${curve.points[0].y}`);
    if (Math.abs(curve.points[16].x - 432 * K) > 1e-3 || Math.abs(curve.points[16].y - 372 * K) > 1e-3)
      throw new Error(`end ${curve.points[16].x},${curve.points[16].y}`);
  });

  check("text: HELLO PDF at (100,400) pt, height 12 pt scaled, no rotation", () => {
    const text = doc.entities.find((e) => e.type === "TEXT");
    if (!text) throw new Error("no TEXT entity");
    if (text.value !== "HELLO PDF") throw new Error(`value ${text.value}`);
    if (text.layer !== "PDF Text") throw new Error(`layer ${text.layer}`);
    if (Math.abs(text.position.x - 100 * K) > 1e-3 || Math.abs(text.position.y - 400 * K) > 1e-3)
      throw new Error(`position ${text.position.x},${text.position.y}`);
    if (Math.abs(text.height - 12 * K) > 1e-3) throw new Error(`height ${text.height}`);
    if (text.rotation !== undefined) throw new Error(`rotation ${text.rotation}`);
  });

  check("counts and extents are consistent", () => {
    const { lines, polylines, fills, texts, imagesSkipped } = res.counts;
    if (lines !== 1 || fills !== 1 || texts !== 1 || imagesSkipped !== 0) {
      throw new Error(`counts ${lines}/${polylines}/${fills}/${texts}/${imagesSkipped}`);
    }
    if (polylines !== 3) throw new Error(`polylines ${polylines}`);
    if (!doc.extents) throw new Error("no extents");
    if (doc.extents.min.x > doc.extents.max.x) throw new Error("extents inverted");
  });

  await check("raw PDF points mode: 72 units per inch keeps user-space coordinates (1 pt = 1 unit)", async () => {
    const raw = await pdfToDxfDocument(bytes, { unitsPerInch: 72 });
    if (raw.doc.units !== "unitless") throw new Error(`units ${raw.doc.units}`);
    if (raw.unitsPerInch !== 72) throw new Error(`unitsPerInch ${raw.unitsPerInch}`);
    const line = raw.doc.entities.find((e) => e.type === "LINE");
    if (Math.abs(line.start.x - 72) > 1e-6 || Math.abs(line.start.y - 112) > 1e-6)
      throw new Error(`start ${line.start.x},${line.start.y}`);
  });

  await check("page range: page 2 of a 1-page PDF throws with an explicit message", async () => {
    let msg = "";
    try {
      await pdfToDxfDocument(bytes, { page: 2 });
    } catch (err) {
      msg = err.message;
    }
    if (!/out of range/.test(msg)) throw new Error(`unexpected error: ${msg || "no error"}`);
  });

  await check("DXF round trip: writeDxf produces a loadable drawing", () => {
    const text = writeDxf(doc);
    if (!text.includes("LWPOLYLINE")) throw new Error("no LWPOLYLINE in DXF");
    if (!text.includes("HELLO PDF")) throw new Error("text lost in DXF");
    if (!text.includes("PDF Text")) throw new Error("PDF Text layer missing in DXF");
    if (!text.includes("PDF Fill")) throw new Error("PDF Fill layer missing in DXF");
  });

  fs.rmSync(outDir, { recursive: true, force: true });
  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("pdf-vector test crashed:", err);
  fs.rmSync(outDir, { recursive: true, force: true });
  process.exit(1);
});
