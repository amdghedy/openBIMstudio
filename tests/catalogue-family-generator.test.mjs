import assert from "node:assert/strict";
import { parseDelimitedCatalogue, buildCatalogueFamilyDefinition, validateCatalogueRows, mapCatalogueHeader } from "../src/modules/families/catalogue-intake.ts";

assert.equal(mapCatalogueHeader("Overall Width (mm)"), "width");
assert.equal(mapCatalogueHeader("Air Flow Rate (m3/h)"), "airflow");
assert.equal(mapCatalogueHeader("ESP (Pa)"), "staticPressure");
assert.equal(mapCatalogueHeader("Rated Power (kW)"), "power");
assert.equal(mapCatalogueHeader("Supply Voltage (V)"), "voltage");

const mapped = parseDelimitedCatalogue("Model,Overall Width (mm),Overall Depth (mm),Overall Height (mm),Air Flow Rate (m3/h)\\nAHU-01,1200,800,650,4200");
assert.equal(mapped.rows[0].width, 1200);
assert.equal(mapped.rows[0].airflow, 4200);

const parsed = parseDelimitedCatalogue('Model,Manufacturer,Width,Depth,Height,Airflow\nFAN-300,Acme,300,300,450,1200\nFAN-500,Acme,500,500,650,2500');
assert.equal(parsed.rows.length, 2);
assert.equal(parsed.rows[1].model, "FAN-500");
assert.equal(parsed.rows[1].airflow, 2500);

const quoted = parseDelimitedCatalogue('Model,Description,Width,Depth,Height\nP-1,"Pump, inline",200,300,400');
assert.equal(quoted.rows.length, 1);
assert.equal(quoted.rows[0].description, "Pump, inline");

const invalid = parseDelimitedCatalogue("Manufacturer,Width\nAcme,300");
assert.ok(invalid.errors.some((e) => e.includes("Model")));

const def = buildCatalogueFamilyDefinition(parsed.rows, { name: "Acme Fan", dimensionUnit: "mm" });
assert.equal(def.types.length, 2);
assert.equal(def.types[1].name, "FAN-500");
assert.equal(def.types[1].values.Width, 0.5);
assert.equal(def.geometry.kind, "box");
const roundCatalogue = parseDelimitedCatalogue("Model,Width,Depth,Height,Geometry Profile\nPUMP-01,300,300,500,cylinder");
const roundFamily = buildCatalogueFamilyDefinition(roundCatalogue.rows, { name: "Pump", dimensionUnit: "mm" });
assert.equal(roundFamily.geometry.kind, "cylinder");
assert.deepEqual(roundFamily.geometry.r, { expr: "Width / 2" });
assert.equal(roundFamily.types[0].values.Width, 0.3);
assert.throws(() => buildCatalogueFamilyDefinition([
  { model: "A", geometryProfile: "box" }, { model: "B", geometryProfile: "cylinder" }
], { name: "Mixed" }), /same explicit geometry profile/);
assert.throws(() => buildCatalogueFamilyDefinition([
  { model: "A", geometryProfile: "mesh-import" }
], { name: "Unsupported" }), /Unsupported catalogue geometry profile/);
assert.equal(def.parameters.find((p) => p.name === "Airflow").default, 1200);
assert.equal(validateCatalogueRows(parsed.rows).length, 0);
assert.ok(validateCatalogueRows([{ model: "MISSING" }]).some((e) => e.includes("Width")));

assert.throws(() => buildCatalogueFamilyDefinition([], { name: "Empty" }), /At least one/);
assert.throws(() => buildCatalogueFamilyDefinition([{ model: "A" }, { model: "a" }], { name: "Duplicate" }), /Duplicate model/);
console.log("catalogue family generator tests passed");
