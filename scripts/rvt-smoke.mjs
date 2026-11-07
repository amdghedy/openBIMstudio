// Runs the BUILT Revit decoder (public/rvt/) in Node on a real file and prints what it found.
//   node scripts/rvt-smoke.mjs path/to/file.rvt [--expect-glb]
// Same call sequence as src/modules/rvt/rvt-core.ts decodeRevit(). Exit 1 when decoding throws
// or (with --expect-glb) when no glTF binary comes out. Used by the "Build Revit reader" workflow.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2];
if (!file) { console.error("usage: node scripts/rvt-smoke.mjs file.rvt [--expect-glb]"); process.exit(2); }
const api = await import(pathToFileURL(path.join(root, "public/rvt/rvt.js")).href);
await api.default({ module_or_path: fs.readFileSync(path.join(root, "public/rvt/rvt_bg.wasm")) });
const bytes = new Uint8Array(fs.readFileSync(file));
const t0 = Date.now();
const stages = new Set();
const res = api.openRvtBytesWithDiagnosticsModeAndOpenLimits(bytes, "scaffold", null, (s) => stages.add(s));
const glb = api.modelToGlb(res.model);
const d = res.diagnostics ?? {};
const magic = Buffer.from(glb.slice(0, 4)).toString("latin1");
console.log(JSON.stringify({
  file: path.basename(file), bytes: bytes.length, ms: Date.now() - t0,
  revitVersion: d.input?.revit_version, releaseSupport: d.input?.release_support,
  confidence: d.confidence, elements: d.exported?.building_elements, withGeometry: d.exported?.building_elements_with_geometry,
  warnings: (d.warnings ?? []).length, stages: [...stages], glbBytes: glb.length, glbMagic: magic,
}, null, 1));
if (process.argv.includes("--expect-glb") && magic !== "glTF") { console.error("no glTF binary produced"); process.exit(1); }
