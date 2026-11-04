// Native DWG export acceptance test. CI builds the acadrust WASM first.
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execSync } = require("child_process");
const root = path.join(__dirname, "..");
const viewerSource = fs.readFileSync(path.join(root, "src", "features", "cad-viewer.ts"), "utf8");
for (const required of ['name: "SAVEAS"', 'name: "DWGSAVE"', 'async function saveDwg()', 'exportDxfToDwg(dxf)', "DWG export cancelled to prevent data loss"]) {
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
const acad = require(find(out, "acad-engine.js"));
const { writeDxf } = require(find(out, "dxf-writer.js"));

(async () => {
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
  const dwg = await acad.exportDxfToDwg(writeDxf(doc));
  assert.ok(dwg instanceof Uint8Array && dwg.length > 100, "DWG output is empty");
  const signature = new TextDecoder().decode(dwg.subarray(0, 6));
  assert.ok(/^AC10(?:09|12|14|15|18|21|24|27|32)$/.test(signature), "invalid DWG signature: " + signature);
  const parsed = await acad.parseWithAcadEngine(dwg, "roundtrip.dwg");
  assert.ok(parsed && parsed.format === "dwg", "exported file did not parse as DWG");
  assert.strictEqual(parsed.entityCount, doc.entities.length, "entity count changed during DWG round-trip");
  assert.ok(parsed.doc.layers.some((l) => l.name === "WALLS"), "layer table did not survive DWG round-trip");
  let emptyFailed = false;
  try { await acad.exportDxfToDwg(""); } catch { emptyFailed = true; }
  assert.ok(emptyFailed, "empty input must be rejected");
  console.log("cad-dwg-export: native DWG signature, entity count, layer table and empty-input guard passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
