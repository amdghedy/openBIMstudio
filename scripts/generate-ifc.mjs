import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(path.join(tmpdir(), "obs-ifc-gen-"));

console.log("Compiling authored-ifc.ts...");
const tsc = spawnSync(
  "npx",
  ["tsc", "--rootDir", "src", "--outDir", out, "--module", "commonjs", "--target", "ES2022", "--skipLibCheck", "--noCheck", "src/modules/bim-gaps/authored-ifc.ts"],
  { cwd: root, stdio: "inherit", shell: true },
);
if (tsc.status !== 0) process.exit(1);

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { exportAuthoredToIfc } = require(path.join(out, "modules/bim-gaps/authored-ifc.js"));

// Create a sample model: 2 walls, 1 door, 1 slab
const model = [
  { id: "w1", type: "wall", name: "Wall A", params: { start: [0, 0], end: [6, 0], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0", properties: { material: "Brick" } },
  { id: "w2", type: "wall", name: "Wall B", params: { start: [6, 0], end: [6, 4], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0" },
  { id: "d1", type: "door", name: "Door 1", hostId: "w1", params: { width: 0.9, height: 2.1, thickness: 0.2, elevation: 0, offsetAlongHost: 2, sillHeight: 0 } },
  { id: "s1", type: "slab", name: "Floor", params: { polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], height: 0.2, thickness: 0.2, elevation: -0.2 }, levelId: "L0" }
];

const levels = [{ id: "L0", name: "Ground", elevation: 0 }];

// Optional env overrides so CI/ops can emit corpus variants:
//   SCHEMA=IFC2X3 OUT=corpus/x.ifc PROJ="Name" MODEL='[...]' LEVELS='[...]'
const schema = process.env.SCHEMA || "IFC4";
const projectName = process.env.PROJ || "Sample Project";
const outName = process.env.OUT || "sample-project.ifc";
const modelSrc = process.env.MODEL ? JSON.parse(process.env.MODEL) : model;
const levelsSrc = process.env.LEVELS ? JSON.parse(process.env.LEVELS) : levels;

console.log(`Generating ${schema} file...`);
const res = exportAuthoredToIfc(modelSrc, { schema, levels: levelsSrc, projectName, timestamp: new Date().toISOString() });

const outFile = path.join(root, outName);
writeFileSync(outFile, res.text);
console.log(`✅ Success! Generated ${outFile}`);
console.log(`   Size: ${(res.text.length / 1024).toFixed(1)} KB`);
console.log(`   Elements: ${res.stats.elements}, Openings: ${res.stats.openings}`);
