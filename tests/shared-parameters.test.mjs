import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function importTypeScript(path) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(output).toString("base64")}`);
}

const sharedModule = await importTypeScript("../src/modules/families/shared-parameters.ts");
const catalogModule = await importTypeScript("../src/modules/families/type-catalog.ts");
const validCatalog = [
  "##TYPE",
  "Door,Width##length,Count##integer,Operable##yesno,Label##string",
  "Single,0.9,10,Yes,Main entry",
  "Double,1.8,2,No," ,
].join("\n");

test("creates a shared parameter with a valid RFC4122 v4 UUID", () => {
  const manager = new sharedModule.SharedParameterManager(null);
  const parameter = manager.create({ name: "Width", group: "Dimensions", type: "length", defaultValue: 0.9, isInstance: false });
  assert.match(parameter.guid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
});

test("persists parameters and reloads them from storage", () => {
  const data = new Map();
  const storage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const first = new sharedModule.SharedParameterManager(storage);
  const saved = first.create({ name: "FireRating", group: "Identity", type: "string", defaultValue: "2h", isInstance: true });
  const reloaded = new sharedModule.SharedParameterManager(storage);
  assert.deepEqual(reloaded.get(saved.guid), saved);
});

test("finds parameters by name and group and deletes by GUID", () => {
  const manager = new sharedModule.SharedParameterManager(null);
  const created = manager.create({ name: "Area", group: "Dimensions", type: "area", defaultValue: 10, isInstance: false });
  assert.equal(manager.findByName("area")?.guid, created.guid);
  assert.equal(manager.listByGroup("dimensions").length, 1);
  assert.equal(manager.delete(created.guid), true);
  assert.equal(manager.get(created.guid), null);
});

test("parses a typed type catalog into family parameters and rows", () => {
  const catalog = catalogModule.TypeCatalogManager.parseCSV(validCatalog);
  assert.equal(catalog.familyName, "Door");
  assert.deepEqual(catalog.parameters.map((parameter) => parameter.name), ["Width", "Count", "Operable", "Label"]);
  assert.deepEqual(catalog.types[0], {
    typeName: "Single",
    values: { Width: 0.9, Count: 10, Operable: true, Label: "Main entry" },
  });
});

test("infers number, boolean, and string values from CSV cells", () => {
  const csv = "##TYPE\nWindow,Width##number,Enabled##yesno,Note##string\nW1,10.5,true,hello";
  const entry = catalogModule.TypeCatalogManager.parseCSV(csv).types[0];
  assert.equal(entry.values.Width, 10.5);
  assert.equal(entry.values.Enabled, true);
  assert.equal(entry.values.Note, "hello");
  assert.equal(typeof entry.values.Width, "number");
  assert.equal(typeof entry.values.Enabled, "boolean");
  assert.equal(typeof entry.values.Note, "string");
});

test("rejects catalog input without the ##TYPE marker", () => {
  assert.throws(() => catalogModule.TypeCatalogManager.parseCSV("Door,Width##number\nSingle,10"), /must start with "##TYPE"/);
});

test("round trips quoted commas and CSV boolean values", () => {
  const original = catalogModule.TypeCatalogManager.parseCSV("##TYPE\n\"Window, Type\",Label##string,Enabled##yesno\n\"W,1\",\"North, glazed\",Yes");
  const roundTrip = catalogModule.TypeCatalogManager.parseCSV(catalogModule.TypeCatalogManager.toCSV(original));
  assert.deepEqual(roundTrip, original);
});

test("reports malformed rows and unclosed CSV quotes", () => {
  assert.throws(() => catalogModule.TypeCatalogManager.parseCSV("##TYPE\nDoor,Width##length\nSingle,1,extra"), /expected 2/);
  assert.throws(() => catalogModule.TypeCatalogManager.parseCSV('##TYPE\nDoor,Label##string\nSingle,"broken'), /not closed/);
});
