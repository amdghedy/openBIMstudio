/**
 * tests/family-creator-pdf.test.cjs
 *
 * Family creator PDF text intake: real pdf.js (legacy build under Node, the
 * same path the browser uses) reads a generated PDF, and the cut-sheet
 * reader finds the size with the right page and line. Text PDFs only: a PDF
 * with no text layer is reported as such, never guessed at.
 *
 * Run: `node tests/family-creator-pdf.test.cjs`
 */
const fs = require("fs"), path = require("path"), assert = require("assert");
const buildTextPdf = require("./helpers/text-pdf.cjs");
const repo = path.join(__dirname, "..");
const outDir = path.join(repo, ".tmp-creator-pdf-test");
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok - ${name}`); }
  catch (e) { fail++; console.log(`  FAIL - ${name}`); console.error(`    ${e.message}`); }
}
process.on("exit", () => { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* */ } });

(async () => {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { rolldown } = require("rolldown");
  for (const entry of ["pdf-text", "cutsheet"]) {
    const b = await rolldown({
      input: path.join(repo, "src/modules/families/creator", `${entry}.ts`),
      platform: "node",
      external: (id) => id === "pdfjs-dist" || id.startsWith("pdfjs-dist/"),
    });
    await b.write({ format: "cjs", dir: outDir, entryFileNames: `${entry}.cjs`, chunkFileNames: `${entry}-[hash].cjs` });
    await b.close();
  }
  const { extractPdfPages, itemsToLines, MAX_PDF_BYTES } = require(path.join(outDir, "pdf-text.cjs"));
  const { pickOverallSize } = require(path.join(outDir, "cutsheet.cjs"));

  await t("T1 reads a two-page text PDF line by line", async () => {
    const pdf = buildTextPdf([["Display Cabinet DC-100", "Manufacturer: Example"], ["Specifications", "Overall size: 1200 x 700 x 2000 mm", "Power: 230 V"]]);
    const r = await extractPdfPages(pdf);
    assert.strictEqual(r.pageCount, 2); assert.strictEqual(r.noText, false); assert.strictEqual(r.truncated, false);
    assert.deepStrictEqual(r.pages[0].split("\n"), ["Display Cabinet DC-100", "Manufacturer: Example"]);
    assert.deepStrictEqual(r.pages[1].split("\n"), ["Specifications", "Overall size: 1200 x 700 x 2000 mm", "Power: 230 V"]);
  });

  await t("T2 the size is found with its real page and line, and the exact source text", async () => {
    const pdf = buildTextPdf([["Cover"], ["Specifications", "Overall size: 1200 x 700 x 2000 mm"]]);
    const r = await extractPdfPages(pdf);
    const size = pickOverallSize(r.pages);
    assert.ok(size, "size found");
    assert.deepStrictEqual([size.widthM, size.depthM, size.heightM], [1.2, 0.7, 2]);
    assert.strictEqual(size.sources[0].page, 2); assert.strictEqual(size.sources[0].line, 2);
    assert.ok(size.sources[0].sourceText.includes("1200 x 700 x 2000 mm"));
  });

  await t("T3 conflicting sizes across pages are not guessed", async () => {
    const r = await extractPdfPages(buildTextPdf([["Size: 1200 x 700 x 2000 mm"], ["Size: 1300 x 700 x 2000 mm"]]));
    assert.strictEqual(pickOverallSize(r.pages), null);
  });

  await t("T4 a PDF with no text layer reports noText instead of inventing text", async () => {
    const r = await extractPdfPages(buildTextPdf([[]]));
    assert.strictEqual(r.noText, true);
    assert.strictEqual(pickOverallSize(r.pages), null);
  });

  await t("T5 junk bytes and oversize files are refused", async () => {
    await assert.rejects(() => extractPdfPages(new TextEncoder().encode("not a pdf")));
    await assert.rejects(() => extractPdfPages(new Uint8Array(MAX_PDF_BYTES + 1)), /larger than/);
  });

  await t("T6 items on one visual line are joined left to right with gap spaces", async () => {
    const lines = itemsToLines([
      { str: "Width:", x: 72, y: 700, w: 30 }, { str: "1150", x: 110, y: 700.4, w: 20 }, { str: "mm", x: 132, y: 700, w: 14 },
      { str: "Depth: 700 mm", x: 72, y: 686, w: 80 },
    ]);
    assert.deepStrictEqual(lines, ["Width: 1150 mm", "Depth: 700 mm"]);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
