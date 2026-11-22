import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractPdfCatalogue, parsePdfCatalogueLines } from "../src/modules/families/pdf-catalogue-extractor.ts";
import { mapCatalogueHeader } from "../src/modules/families/catalogue-intake.ts";

const lines = [
  "Model    Manufacturer    Width    Depth    Height    Airflow",
  "FAN-300    Acme    300    300    450    1200",
  "FAN-500    Acme    500    500    650    2500",
];
const rows = parsePdfCatalogueLines(lines, 4);
assert.equal(rows.length, 2);
assert.equal(rows[0].model, "FAN-300");
assert.equal(rows[0].manufacturer, "Acme");
assert.equal(rows[0].width, 300);
assert.equal(rows[1].airflow, 2500);
assert.equal(rows[0].sourcePage, 4);

const missingHeader = parsePdfCatalogueLines(["Acme Fan", "Overall dimensions 300 x 400 x 500 mm"], 1);
assert.equal(missingHeader.length, 0);

assert.equal(mapCatalogueHeader("Width (mm)"), "width");
assert.equal(mapCatalogueHeader("Airflow (m3/h)"), "airflow");

const pdf = await PDFDocument.create();
const page = pdf.addPage([595, 842]);
const font = await pdf.embedFont(StandardFonts.Helvetica);
page.drawText("Model    Manufacturer    Width    Depth    Height    Airflow", { x: 40, y: 760, size: 10, font });
page.drawText("FAN-300    Acme    300    300    450    1200", { x: 40, y: 740, size: 10, font });
page.drawText("FAN-500    Acme    500    500    650    2500", { x: 40, y: 720, size: 10, font });
const pdfBytes = new Uint8Array(await pdf.save());
const extracted = await extractPdfCatalogue(pdfBytes);
assert.equal(extracted.pageCount, 1);
assert.equal(extracted.textPages.length, 1);
assert.equal(extracted.rows.length, 2);
assert.equal(extracted.rows[0].model, "FAN-300");
assert.equal(extracted.rows[1].width, 500);
assert.equal(extracted.rows[1].sourcePage, 1);
console.log("PDF catalogue extraction tests passed");
