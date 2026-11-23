import assert from "node:assert/strict";
import { SharedParameterManager, parseSharedParameterText } from "../src/modules/families/shared-parameters.ts";
import { parseDelimitedCatalogue, buildCatalogueFamilyDefinition, validateCatalogueRows, mapCatalogueHeader, suggestCatalogueMappings, parseCatalogueMappingProfile, normalizeCatalogueRowsWithUnits } from "../src/modules/families/catalogue-intake.ts";

assert.equal(mapCatalogueHeader("Overall Width (mm)"), "width");
assert.equal(mapCatalogueHeader("Air Flow Rate (m3/h)"), "airflow");
assert.equal(mapCatalogueHeader("ESP (Pa)"), "staticPressure");
assert.equal(mapCatalogueHeader("Rated Power (kW)"), "power");
assert.equal(mapCatalogueHeader("Supply Voltage (V)"), "voltage");
const suggestions = suggestCatalogueMappings(["Type Ref", "Nominal Width (mm)", "External Static Pressure", "Vendor Part Number", "Unrecognized Note"]);
assert.equal(suggestions[0].suggestedField, "model");
assert.equal(suggestions[0].confidence, "medium");
assert.equal(suggestions[1].suggestedField, "width");
assert.equal(suggestions[2].suggestedField, "staticPressure");
assert.equal(suggestions[3].suggestedField, "productCode");
assert.equal(suggestions[4].suggestedField, null);
const profile = parseCatalogueMappingProfile({
  schemaVersion: 1,
  name: "Example AHU",
  manufacturer: "Example Manufacturer",
  mappings: { "Type Ref": "model", "Nominal W": "width", "Unused": null },
  updatedAt: "2026-11-23T00:00:00.000Z",
});
assert.equal(profile.mappings["Nominal W"], "width");
assert.equal(profile.manufacturer, "Example Manufacturer");
assert.equal(Object.getPrototypeOf(profile.mappings), null, "mapping dictionaries must not inherit attacker-controlled keys");
const hostileProfile = parseCatalogueMappingProfile(JSON.parse('{"schemaVersion":1,"name":"Hostile","mappings":{"__proto__":"model","constructor":"width"},"updatedAt":"2026-11-23T00:00:00.000Z"}'));
assert.equal(Object.hasOwn(hostileProfile.mappings, "__proto__"), true);
assert.equal(Object.getPrototypeOf(hostileProfile.mappings), null);
const hostileHeader = parseDelimitedCatalogue("Model,__proto__,Depth,Height\\nFAN-1,unsafe,300,600");
assert.equal(Object.getPrototypeOf(hostileHeader.rows[0]), Object.prototype);
assert.equal(Object.hasOwn(hostileHeader.rows[0], "__proto__"), true);

assert.throws(() => parseCatalogueMappingProfile({
  schemaVersion: 99, name: "Bad", mappings: {}, updatedAt: "2026-11-23T00:00:00.000Z",
}), /Unsupported mapping profile schema version/);
assert.throws(() => parseCatalogueMappingProfile({
  schemaVersion: 1, name: "Bad", mappings: { Width: "not-a-field" }, updatedAt: "2026-11-23T00:00:00.000Z",
}), /unsupported target/);

const manuallyMapped = parseDelimitedCatalogue(
  "Type Ref,Nominal W,Overall W,Overall D,Overall H\\nFAN-X,450,999,300,600",
  undefined,
  { "Type Ref": "model", "Nominal W": "width", "Overall W": null, "Overall D": "depth", "Overall H": "height" },
);
assert.equal(manuallyMapped.errors.length, 0);
assert.equal(manuallyMapped.rows[0].width, 450);
assert.equal(manuallyMapped.rows[0].depth, 300);


const mapped = parseDelimitedCatalogue("Model,Overall Width (mm),Overall Depth (mm),Overall Height (mm),Air Flow Rate (m3/h)\\nAHU-01,1200,800,650,4200");
assert.equal(mapped.rows[0].width, 1200);
assert.equal(mapped.rows[0].airflow, 4200);
const converted = parseDelimitedCatalogue("Model,Airflow (L/s),Static Pressure (kPa),Rated Power (W),Supply Voltage (kV)\\nUNIT-01,100,2.5,750,0.4");
assert.equal(converted.rows[0].airflow, 360);
assert.equal(converted.rows[0].staticPressure, 2500);
assert.equal(converted.rows[0].power, 0.75);
assert.equal(converted.rows[0].voltage, 400);
const overrideAfterCsvParse = normalizeCatalogueRowsWithUnits(converted.rows.map((row) => ({ ...row })), {
  airflow: "L/s", staticPressure: "kPa", power: "W", voltage: "kV",
});
assert.equal(overrideAfterCsvParse[0].airflow, 360, "unit overrides must use original CSV values, not already-normalized values");
assert.equal(overrideAfterCsvParse[0].staticPressure, 2500);
assert.equal(overrideAfterCsvParse[0].power, 0.75);
assert.equal(overrideAfterCsvParse[0].voltage, 400);
const convertedM3s = parseDelimitedCatalogue("Model,Airflow (m3/s)\\nUNIT-02,1.2");
assert.equal(convertedM3s.rows[0].airflow, 4320);
const unitReviewed = normalizeCatalogueRowsWithUnits([
  { model: "UNIT-OVERRIDE", width: 10, depth: 2, height: 3, airflow: 100, staticPressure: 2.5, power: 750, voltage: 0.4 },
], { width: "in", depth: "ft", height: "cm", airflow: "L/s", staticPressure: "kPa", power: "W", voltage: "kV" }, "mm");
assert.ok(Math.abs(unitReviewed[0].width - 254) < 1e-9);
assert.ok(Math.abs(unitReviewed[0].depth - 609.6) < 1e-9);
assert.ok(Math.abs(unitReviewed[0].height - 30) < 1e-9);
assert.equal(unitReviewed[0].airflow, 360);
assert.equal(unitReviewed[0].staticPressure, 2500);
assert.equal(unitReviewed[0].power, 0.75);
assert.equal(unitReviewed[0].voltage, 400);
assert.equal(Object.hasOwn(unitReviewed[0], "__unitNormalization"), false, "normalization metadata must not leak into catalogue records");
const whitespaceUnits = normalizeCatalogueRowsWithUnits([
  { model: "UNIT-WHITESPACE", airflow: 10, staticPressure: 1, power: 1000, voltage: 1 },
], { airflow: " L / s ", staticPressure: " kPa ", power: " W ", voltage: " kV " });
assert.equal(whitespaceUnits[0].airflow, 36);
assert.equal(whitespaceUnits[0].staticPressure, 1000);
assert.equal(whitespaceUnits[0].power, 1);
assert.equal(whitespaceUnits[0].voltage, 1000);
assert.throws(() => normalizeCatalogueRowsWithUnits([{ model: "BAD", width: 1 }], { width: "yards" }), /Unsupported width source unit/);


const parsed = parseDelimitedCatalogue('Model,Manufacturer,Width,Depth,Height,Airflow\nFAN-300,Acme,300,300,450,1200\nFAN-500,Acme,500,500,650,2500');
assert.equal(parsed.rows.length, 2);
assert.equal(parsed.rows[1].model, "FAN-500");
assert.equal(parsed.rows[1].airflow, 2500);

const quoted = parseDelimitedCatalogue('Model,Description,Width,Depth,Height\nP-1,"Pump, inline",200,300,400');
assert.equal(quoted.rows.length, 1);
assert.equal(quoted.rows[0].description, "Pump, inline");

const invalid = parseDelimitedCatalogue("Manufacturer,Width\nAcme,300");
assert.ok(invalid.errors.some((e) => e.includes("Model")));

const ambiguous = parseDelimitedCatalogue("Model,Width,Overall Width,Depth,Height\\nAHU-01,1200,1250,800,650");
assert.ok(ambiguous.errors.some((e) => e.includes('Multiple columns map to "width"')));
assert.equal(ambiguous.rows[0].width, undefined, "ambiguous values must not silently overwrite one another");

const def = buildCatalogueFamilyDefinition(parsed.rows, { name: "Acme Fan", dimensionUnit: "mm" });
assert.equal(def.types.length, 2);
assert.equal(def.types[1].name, "FAN-500");
assert.equal(def.types[1].values.Width, 0.5);
assert.equal(def.geometry.kind, "box");
assert.equal(def.parameters.find((parameter) => parameter.name === "Description").default, "Pump, inline");
assert.equal(def.types[0].values.Description, "Pump, inline");
const scopedGuidFamily = buildCatalogueFamilyDefinition(parsed.rows, {
  name: "Scoped Fan",
  dimensionUnit: "mm",
  parameterScopes: { Manufacturer: "instance" },
  parameterGuids: { Width: "550e8400-e29b-41d4-a716-446655440000" },
});
const sharedStore = new Map();
const sharedManager = new SharedParameterManager({
  getItem: (key) => sharedStore.get(key) ?? null,
  setItem: (key, value) => sharedStore.set(key, value),
});
sharedManager.import(scopedGuidFamily.parameters.filter((parameter) => parameter.guid).map((parameter) => ({
  guid: parameter.guid, name: parameter.name, group: parameter.group ?? "General",
  type: parameter.type, defaultValue: parameter.default, isInstance: parameter.scope === "instance",
})));
const revitSharedParameterFile = sharedManager.exportText();
assert.ok(revitSharedParameterFile.includes("550e8400-e29b-41d4-a716-446655440000"));
assert.equal(parseSharedParameterText(revitSharedParameterFile)[0].guid, "550e8400-e29b-41d4-a716-446655440000");

assert.equal(scopedGuidFamily.parameters.find((parameter) => parameter.name === "Manufacturer").scope, "instance");
assert.equal(scopedGuidFamily.parameters.find((parameter) => parameter.name === "Width").scope, "type");
assert.equal(scopedGuidFamily.parameters.find((parameter) => parameter.name === "Width").guid, "550e8400-e29b-41d4-a716-446655440000");
assert.throws(() => buildCatalogueFamilyDefinition(parsed.rows, {
  name: "Unsafe instance scope", parameterScopes: { Width: "instance" },
}), /catalogue variants contain different values/);
assert.throws(() => buildCatalogueFamilyDefinition(parsed.rows, {
  name: "Bad GUID", parameterGuids: { Width: "not-a-guid" },
}), /valid RFC 4122 UUID/);
assert.throws(() => buildCatalogueFamilyDefinition(parsed.rows, {
  name: "Duplicate GUIDs",
  parameterGuids: {
    Width: "550e8400-e29b-41d4-a716-446655440000",
    Depth: "550e8400-e29b-41d4-a716-446655440000",
  },
}), /assigned more than once/);

const typePorts = buildCatalogueFamilyDefinition([
  { model: "AHU-A", width: 1000, depth: 800, height: 600,
    "Connector 1 Name": "Supply", "Connector 1 X": 500, "Connector 1 Y": 0, "Connector 1 Z": 300,
    "Connector 1 Direction X": 1, "Connector 1 Direction Y": 0, "Connector 1 Direction Z": 0,
    "Connector 1 Domain": "duct", "Connector 1 Shape": "round", "Connector 1 Diameter": 400,
    "Connector 1 Flow Direction": "out", "Connector 1 System Classification": "supply-air" },
  { model: "AHU-B", width: 1200, depth: 900, height: 700,
    "Connector 1 Name": "Supply", "Connector 1 X": 600, "Connector 1 Y": 0, "Connector 1 Z": 350,
    "Connector 1 Direction X": 1, "Connector 1 Direction Y": 0, "Connector 1 Direction Z": 0,
    "Connector 1 Domain": "duct", "Connector 1 Shape": "round", "Connector 1 Diameter": 500,
    "Connector 1 Flow Direction": "out", "Connector 1 System Classification": "supply-air",
    "Connector 2 Name": "Return", "Connector 2 X": -600, "Connector 2 Y": 0, "Connector 2 Z": 350,
    "Connector 2 Direction X": -1, "Connector 2 Direction Y": 0, "Connector 2 Direction Z": 0,
    "Connector 2 Domain": "duct", "Connector 2 Shape": "round", "Connector 2 Diameter": 450,
    "Connector 2 Flow Direction": "in", "Connector 2 System Classification": "return-air" }
], { name: "AHU Series", dimensionUnit: "mm" });
assert.equal(typePorts.types[0].connectorDefs.length, 1);
assert.equal(typePorts.types[1].connectorDefs.length, 2);
assert.equal(typePorts.connectorDefs, undefined);

const roundCatalogue = parseDelimitedCatalogue("Model,Width,Depth,Height,Geometry Profile\nPUMP-01,300,300,500,cylinder");
const roundFamily = buildCatalogueFamilyDefinition(roundCatalogue.rows, { name: "Pump", dimensionUnit: "mm" });
assert.equal(roundFamily.geometry.kind, "cylinder");
assert.deepEqual(roundFamily.geometry.r, { expr: "Width / 2" });
assert.equal(roundFamily.types[0].values.Width, 0.3);
assert.throws(() => buildCatalogueFamilyDefinition([
  { model: "A", width: 100, depth: 100, height: 100, geometryProfile: "box" }, { model: "B", width: 120, depth: 100, height: 100, geometryProfile: "cylinder" }
], { name: "Mixed" }), /same explicit geometry profile/);
assert.throws(() => buildCatalogueFamilyDefinition([
  { model: "A", width: 100, depth: 100, height: 100, geometryProfile: "mesh-import" }
], { name: "Unsupported" }), /Unsupported catalogue geometry profile/);
assert.equal(def.parameters.find((p) => p.name === "Airflow").default, 1200);
assert.equal(validateCatalogueRows(parsed.rows).length, 0);
assert.ok(validateCatalogueRows([{ model: "MISSING" }]).some((e) => e.includes("Width")));
assert.ok(validateCatalogueRows([{ model: "AHU-INCOMPLETE", width: 1200, height: 900 }]).some((e) => e.includes("depth is missing")));
assert.ok(validateCatalogueRows([{ model: "AHU-ZERO", width: 0, depth: 800, height: 900 }]).some((e) => e.includes("width must be a finite value greater than zero")));
assert.ok(validateCatalogueRows([{ model: "AHU-INFINITE", width: Number.POSITIVE_INFINITY, depth: 800, height: 900 }]).some((e) => e.includes("width must be a finite value greater than zero")));
assert.deepEqual(validateCatalogueRows([{ model: "AHU-VALID", width: 1200, depth: 800, height: 900 }]), []);
assert.ok(validateCatalogueRows([
  { model: "AHU-DUP", width: 1200, depth: 800, height: 900 },
  { model: "ahu-dup", width: 1400, depth: 900, height: 1000 },
]).some((issue) => issue.includes("duplicate model identifier")));

assert.throws(() => buildCatalogueFamilyDefinition([], { name: "Empty" }), /At least one/);
assert.throws(() => buildCatalogueFamilyDefinition([{ model: "NO-WIDTH", depth: 100, height: 100 }], { name: "Incomplete" }), /width is missing/);
assert.throws(() => buildCatalogueFamilyDefinition([{ model: "ZERO-WIDTH", width: 0, depth: 100, height: 100 }], { name: "Invalid dimensions" }), /width must be a finite value greater than zero/);
assert.throws(() => buildCatalogueFamilyDefinition([{ model: " " , width: 100, depth: 100, height: 100 }], { name: "Missing model" }), /model identifier is required/);
assert.throws(() => buildCatalogueFamilyDefinition([{ model: "A" }, { model: "a" }], { name: "Duplicate" }), /duplicate model identifier/);
console.log("catalogue family generator tests passed");
