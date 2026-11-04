// Native DWG export acceptance test. CI builds the acadrust WASM first.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execSync } = require("child_process");
const { pathToFileURL } = require("url");
const root = path.join(__dirname, "..");
const viewerSource = fs.readFileSync(path.join(root, "src", "features", "cad-viewer.ts"), "utf8");
for (const required of ['name: "SAVEAS"', 'name: "DWGSAVE"', 'async function saveDwg()', 'exportDxfToDwg(dxf)', 'validateDxfForDwgExport(dxf, entities.length', "DWG export cancelled to prevent data loss", "dimensionStyleCount", "customTextStyles", "layoutCount"]) {
  assert.ok(viewerSource.includes(required), "CAD editor DWG export wiring missing: " + required);
}
const wasmPath = path.join(root, "public", "cad-engine", "obim-cad-engine.wasm");
assert.ok(fs.existsSync(wasmPath), "DWG writer WASM is missing; build cad-engine-rust first");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "cad-dwg-export-"));
execSync("npx tsc src/modules/drawings/acad-engine.ts src/modules/drawings/dxf-writer.ts src/modules/drawings/dxf-reader.ts --outDir " + out + " --module commonjs --target es2020 --skipLibCheck --esModuleInterop", { cwd: root, stdio: "pipe" });
const find = (dir, name) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { const found = find(p, name); if (found) return found; }
    else if (entry.name === name) return p;
  }
};
// Compile the independent LibreDWG reader as ESM in a repository-local
// temp directory so Node resolves the installed @mlightcad package.
const outEsm = fs.mkdtempSync(path.join(root, ".cad-dwg-export-independent-"));
fs.writeFileSync(path.join(outEsm, "package.json"), JSON.stringify({ type: "module" }));
execSync(
  "npx tsc src/modules/cad-link/dwg-parse-core.ts --outDir " + outEsm +
  " --module es2020 --target es2020 --moduleResolution node --skipLibCheck --esModuleInterop",
  { cwd: root, stdio: "pipe" },
);
const addJsExt = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) addJsExt(p);
    else if (entry.name.endsWith(".js")) {
      const src = fs.readFileSync(p, "utf8");
      const fixed = src.replace(/(from\s*"(\.\.?\/[^"*]+))"/g, (m, a, spec) =>
        spec.endsWith(".js") ? m : `${a}.js"`);
      if (fixed !== src) fs.writeFileSync(p, fixed);
    }
  }
};
addJsExt(outEsm);
const findEsm = (dir, name) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) { const found = findEsm(p, name); if (found) return found; }
    else if (entry.name === name) return p;
  }
};
const acad = require(find(out, "acad-engine.js"));
const { writeDxf } = require(find(out, "dxf-writer.js"));

(async () => {
  const independentReader = await import(pathToFileURL(findEsm(outEsm, "dwg-parse-core.js")).href);
  const wasm = fs.readFileSync(wasmPath);
  assert.ok(await acad.setAcadEngineForTests(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)), "DWG writer WASM failed to instantiate");
  const doc = {
    units: "mm",
    layers: [{ name: "0", color: 7 }, { name: "WALLS", color: 1 }],
    entities: [
      { type: "LINE", layer: "WALLS", start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
      { type: "CIRCLE", layer: "0", center: { x: 20, y: 30 }, radius: 5 },
      { type: "ARC", layer: "0", center: { x: 40, y: 30 }, radius: 8, startAngle: 0, endAngle: 90 },
      { type: "LWPOLYLINE", layer: "WALLS", points: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }], closed: false },
      { type: "TEXT", layer: "0", position: { x: 10, y: 50 }, height: 2.5, value: "DWG export acceptance" },
      { type: "POINT", layer: "0", position: { x: 5, y: 5 } },
    ],
  };
  const dxf = writeDxf(doc);
  await acad.validateDxfForDwgExport(dxf, doc.entities.length, doc.layers.map((layer) => layer.name));
  let countMismatchRejected = false;
  try { await acad.validateDxfForDwgExport(dxf, doc.entities.length + 1, doc.layers.map((layer) => layer.name)); } catch { countMismatchRejected = true; }
  assert.ok(countMismatchRejected, "preflight must reject entities lost by DXF serialization");
  let missingLayerRejected = false;
  try { await acad.validateDxfForDwgExport(dxf, doc.entities.length, [...doc.layers.map((layer) => layer.name), "MISSING_LAYER"]); } catch { missingLayerRejected = true; }
  assert.ok(missingLayerRejected, "preflight must reject missing layers");
  const dwg = await acad.exportDxfToDwg(dxf);
  assert.ok(dwg instanceof Uint8Array && dwg.length > 100, "DWG output is empty");
  const signature = new TextDecoder().decode(dwg.subarray(0, 6));
  assert.ok(/^AC10(?:09|12|14|15|18|21|24|27|32)$/.test(signature), "invalid DWG signature: " + signature);
  // Keep the writer's own read-back as a fast smoke check, but do not treat
  // it as interoperability evidence. The decisive check below bypasses
  // acadrust and parses the exact bytes with the separate LibreDWG codebase.
  const parsed = await acad.parseWithAcadEngine(dwg, "roundtrip.dwg");
  assert.ok(parsed && parsed.format === "dwg", "acadrust self-read did not parse the output");
  assert.strictEqual(parsed.entityCount, doc.entities.length, "acadrust self-read entity count changed");
  assert.ok(parsed.doc.layers.some((l) => l.name === "WALLS"), "acadrust self-read lost the WALLS layer");

  const independentBuffer = dwg.buffer.slice(dwg.byteOffset, dwg.byteOffset + dwg.byteLength);
  const independent = await independentReader.parseDwgBytesWithLibreDwg(independentBuffer, "independent-roundtrip.dwg");
  assert.strictEqual(independent.version, signature, "LibreDWG reported a different DWG version");
  assert.strictEqual(independent.entityCount, doc.entities.length,
    "independent LibreDWG entity count differs from the source drawing: " + independent.summary);
  assert.ok(independent.doc.layers.some((l) => l.name === "WALLS"), "independent LibreDWG lost the WALLS layer");
  const independentTypes = independent.doc.entities.map((e) => e.type);
  for (const type of ["LINE", "CIRCLE", "ARC", "LWPOLYLINE", "TEXT", "POINT"]) {
    assert.ok(independentTypes.includes(type), "independent LibreDWG did not recover " + type + ": " + independentTypes.join(", "));
  }
  const independentLine = independent.doc.entities.find((e) => e.type === "LINE" && e.layer === "WALLS");
  assert.ok(independentLine, "independent LibreDWG did not recover the WALLS line");
  assert.ok(Math.abs(independentLine.start.x) < 1e-6 && Math.abs(independentLine.end.x - 100) < 1e-6,
    "independent LibreDWG changed line coordinates");
  const independentCircle = independent.doc.entities.find((e) => e.type === "CIRCLE");
  assert.ok(independentCircle && Math.abs(independentCircle.radius - 5) < 1e-6,
    "independent LibreDWG changed circle radius");
  const independentText = independent.doc.entities.find((e) => e.type === "TEXT");
  assert.ok(independentText && independentText.value.includes("DWG export acceptance"),
    "independent LibreDWG did not preserve the text entity");
  let emptyFailed = false;
  try { await acad.exportDxfToDwg(""); } catch { emptyFailed = true; }
  assert.ok(emptyFailed, "empty input must be rejected");
  console.log("cad-dwg-export: preflight, DWG signature, acadrust smoke read, independent LibreDWG entity/layer/geometry/text validation and empty-input guard passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
