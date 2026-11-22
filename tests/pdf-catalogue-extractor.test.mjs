import assert from "node:assert/strict";
import { parsePdfCatalogueLines } from "../src/modules/families/pdf-catalogue-extractor.ts";

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
console.log("PDF catalogue table parser tests passed");
