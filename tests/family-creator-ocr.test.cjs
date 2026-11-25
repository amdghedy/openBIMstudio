/**
 * tests/family-creator-ocr.test.cjs
 *
 * Family creator OCR: a real raster image (made in the test, no binary
 * fixture) is read by the real Tesseract engine running as WebAssembly with
 * the pinned English model, from the same files the app serves (public/ocr).
 * The text then goes through the normal size reader, so page, line and source
 * text are kept. OCR can misread: the app labels this text "check it".
 *
 * Needs `node scripts/sync-ocr-assets.mjs` (done by prebuild/predev).
 * Run: `node tests/family-creator-ocr.test.cjs`
 */
const fs = require("fs"), path = require("path"), assert = require("assert");
const fixture = require("./helpers/ocr-sheet-fixture.cjs");
const repo = path.join(__dirname, "..");
const outDir = path.join(repo, ".tmp-creator-ocr-test");
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}`); console.error(`    ${e.message}`); }
}
process.on("exit", () => { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* */ } });

(async () => {
  const assetDir = path.join(repo, "public", "ocr");
  if (!fs.existsSync(path.join(assetDir, "eng.traineddata.gz"))) {
    require("child_process").execSync("node scripts/sync-ocr-assets.mjs", { cwd: repo, stdio: "inherit" });
  }
  fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
  const { rolldown } = require("rolldown");
  for (const entry of ["ocr", "cutsheet"]) {
    const b = await rolldown({
      input: path.join(repo, "src/modules/families/creator", `${entry}.ts`), platform: "node", logLevel: "silent",
      external: (id) => id === "tesseract.js" || id.startsWith("tesseract.js/"),
    });
    await b.write({ format: "cjs", dir: outDir, entryFileNames: `${entry}.cjs`, chunkFileNames: `${entry}-[hash].cjs` });
    await b.close();
  }
  const O = require(path.join(outDir, "ocr.cjs")), C = require(path.join(outDir, "cutsheet.cjs"));

  await t("T1 tidyOcrText only tidies: multiplication sign and spacing, never digits", () => {
    assert.strictEqual(O.tidyOcrText("Size:  1200 \u00D7 700 \u00D7 2000 mm\n\n  \nPower 230 V "), "Size: 1200 x 700 x 2000 mm\nPower 230 V");
  });

  await t("T2 a raster image is read by real Tesseract and the size keeps page, line and source", async () => {
    const png = fixture.png();
    const r = await O.recognizeImage(png, { assetDir });
    const text = O.tidyOcrText(r.text);
    console.log("    OCR read: " + JSON.stringify(text) + " confidence " + Math.round(r.confidence));
    const size = C.pickOverallSize([text]);
    assert.ok(size, "size found in OCR text");
    assert.deepStrictEqual([size.widthM, size.depthM, size.heightM], [1.2, 0.7, 2]);
    assert.strictEqual(size.sources[0].page, 1);
    assert.strictEqual(size.sources[0].line, 2, "size is on line 2 of the sheet");
    assert.ok(r.confidence > 50);
  });

  await t("T3 a blank image gives no text and no size", async () => {
    const zlib = require("zlib");
    const w = 200, h = 60, raw = Buffer.alloc((w + 1) * h, 255); for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
    const crc = (buf) => { let c, k = -1; for (let n = 0; n < buf.length; n++) { c = (k ^ buf[n]) & 0xff; for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; k = (k >>> 8) ^ c; } return (k ^ -1) >>> 0; };
    const ck = (type, data) => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), ck("IHDR", ihdr), ck("IDAT", zlib.deflateSync(raw)), ck("IEND", Buffer.alloc(0))]);
    const r = await O.recognizeImage(png, { assetDir });
    assert.strictEqual(C.pickOverallSize([O.tidyOcrText(r.text)]), null);
  });

  await O.stopOcr();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
