#!/usr/bin/env node
/**
 * Deterministic extended IFC corpus (tests/fixtures/ifc-corpus/extended/*.ifc), written with the platform's own authored-IFC writer.
 * HONESTY: these are project-authored (MIT) files, so they exercise the READER paths for many entity classes / schemas /
 * unit and hierarchy shapes, but they are NOT independent third-party exports. Third-party licensed models are still needed
 * for real interoperability evidence (tracked in #96).
 * Re-run: node scripts/generate-ifc-corpus-extended.mjs   (then regenerate manifest expectations if you add files)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(path.join(tmpdir(), "obs-ifc-ext-"));
const tsc = spawnSync("npx", ["tsc", "--rootDir", "src", "--outDir", out, "--module", "commonjs", "--target", "ES2022", "--skipLibCheck", "--noCheck", ...(process.env.TSC_IGNORE_CONFIG ? ["--ignoreConfig"] : []), "src/modules/bim-gaps/authored-ifc.ts"], { cwd: root, stdio: "inherit", shell: true });
if (tsc.status !== 0) process.exit(1);
const { exportAuthoredToIfc } = createRequire(import.meta.url)(path.join(out, "modules/bim-gaps/authored-ifc.js"));
const DIR = path.join(root, "tests/fixtures/ifc-corpus/extended");
mkdirSync(DIR, { recursive: true });
const TS = "2026-11-21T00:00:00Z";
const L = (n) => Array.from({ length: n }, (_, i) => ({ id: "L" + i, name: "Level " + i, elevation: i * 3.2 }));
const wall = (id, a, b, lvl = "L0", extra = {}) => ({ id, type: "wall", name: id, params: { start: a, end: b, height: 3, thickness: 0.2, elevation: 0 }, levelId: lvl, ...extra });
const box = (id, type, [x, y], lvl = "L0", p = {}) => ({ id, type, name: id, params: { start: [x, y], end: [x + 4, y], height: 0.4, thickness: 0.3, depth: 0.3, elevation: 3, ...p }, levelId: lvl });
const rect = (w, d) => [[0, 0], [w, 0], [w, d], [0, d]];
const files = {};
const add = (name, model, opts) => { files[name] = exportAuthoredToIfc(model, { timestamp: TS, ...opts }).text; };

for (const schema of ["IFC4", "IFC2X3"]) {
  const s = schema === "IFC4" ? "ifc4" : "ifc2x3";
  add(`${s}-single-room.ifc`, [wall("w1", [0, 0], [5, 0]), wall("w2", [5, 0], [5, 4]), wall("w3", [5, 4], [0, 4]), wall("w4", [0, 4], [0, 0]),
    { id: "s1", type: "slab", name: "Floor", params: { polygon: rect(5, 4), height: 0.2, thickness: 0.2, elevation: -0.2 }, levelId: "L0" }], { schema, levels: L(1), projectName: `Single room ${schema}` });
  add(`${s}-multi-storey.ifc`, [...[0, 1, 2, 3].flatMap((i) => [wall(`a${i}`, [0, 0], [10, 0], "L" + i), wall(`b${i}`, [10, 0], [10, 8], "L" + i)]),
    ...[0, 1, 2, 3].map((i) => ({ id: "sl" + i, type: "slab", name: "Slab " + i, params: { polygon: rect(10, 8), height: 0.25, thickness: 0.25, elevation: i * 3.2 - 0.25 }, levelId: "L" + i }))], { schema, levels: L(4), projectName: `Four storeys ${schema}` });
  add(`${s}-structural-frame.ifc`, [
    ...[0, 6, 12].flatMap((x, i) => [0, 6].map((y, j) => ({ id: `c${i}${j}`, type: "column", name: `Col ${i}${j}`, params: { point: [x, y], height: 3, thickness: 0.4, depth: 0.4, elevation: 0 }, levelId: "L0" }))),
    ...[0, 6].map((y, j) => ({ id: "bm" + j, type: "beam", name: "Beam " + j, params: { start: [0, y], end: [12, y], height: 0.5, thickness: 0.3, depth: 0.5, elevation: 2.5 }, levelId: "L0" })),
    { id: "ft1", type: "footing", name: "Footing", params: { point: [0, 0], height: 0.6, thickness: 1.2, depth: 1.2, elevation: -0.6 }, levelId: "L0" }], { schema, levels: L(1), projectName: `Frame ${schema}` });
  add(`${s}-mep-systems.ifc`, [wall("w1", [0, 0], [12, 0]), box("d1", "duct", [0, 0.5]), box("d2", "duct", [0, 1.2]), box("p1", "pipe", [0, 2], "L0", { thickness: 0.1 }),
    box("t1", "cable-tray", [0, 3]), box("c1", "conduit", [0, 3.6], "L0", { thickness: 0.03 }),
    { id: "e1", type: "equipment", name: "AHU", params: { point: [2, 5], height: 1.8, thickness: 2, depth: 1, elevation: 0 }, levelId: "L0" }], { schema, levels: L(1), projectName: `MEP ${schema}` });
}
add("ifc4-vertical-circulation.ifc", [
  { id: "st1", type: "stairs", name: "Stair", params: { start: [1, 1], end: [5, 1], height: 3.2, thickness: 1.2, depth: 0.3, elevation: 0 }, levelId: "L0" },
  { id: "rl1", type: "railing", name: "Rail", params: { start: [1, 0.4], end: [5, 0.4], height: 1.0, thickness: 0.05, elevation: 0 }, levelId: "L0" },
  { id: "rp1", type: "ramp", name: "Ramp", params: { start: [6, 1], end: [12, 1], height: 0.5, thickness: 1.5, elevation: 0 }, levelId: "L0" }], { schema: "IFC4", levels: L(2), projectName: "Vertical circulation" });
add("ifc4-envelope-roof-curtain.ifc", [
  { id: "cw1", type: "curtain-wall", name: "Curtain wall", params: { start: [0, 0], end: [9, 0], height: 3.5, thickness: 0.15, elevation: 0 }, levelId: "L0" },
  { id: "rf1", type: "roof", name: "Roof", params: { polygon: rect(9, 6), height: 0.3, thickness: 0.3, elevation: 3.5 }, levelId: "L0" },
  { id: "cg1", type: "ceiling", name: "Ceiling", params: { polygon: rect(9, 6), height: 0.05, thickness: 0.05, elevation: 3.2 }, levelId: "L0" }], { schema: "IFC4", levels: L(1), projectName: "Envelope" });
add("ifc4-openings-doors-windows.ifc", [wall("w1", [0, 0], [10, 0]),
  { id: "d1", type: "door", name: "Door", hostId: "w1", params: { width: 0.9, height: 2.1, thickness: 0.2, elevation: 0, offsetAlongHost: 1.5, sillHeight: 0 } },
  { id: "d2", type: "door", name: "Door 2", hostId: "w1", params: { width: 1.2, height: 2.4, thickness: 0.2, elevation: 0, offsetAlongHost: 4, sillHeight: 0 } },
  { id: "wn1", type: "window", name: "Window", hostId: "w1", params: { width: 1.5, height: 1.2, thickness: 0.2, elevation: 0, offsetAlongHost: 7, sillHeight: 0.9 } }], { schema: "IFC4", levels: L(1), projectName: "Openings" });
add("ifc4-spaces-rooms.ifc", [wall("w1", [0, 0], [8, 0]), wall("w2", [8, 0], [8, 5]), wall("w3", [8, 5], [0, 5]), wall("w4", [0, 5], [0, 0])],
  { schema: "IFC4", levels: L(1), projectName: "Spaces", spaces: [{ id: "sp1", name: "Office 101", levelId: "L0", polygon: rect(4, 5), number: "101" }, { id: "sp2", name: "Meeting 102", levelId: "L0", polygon: [[4, 0], [8, 0], [8, 5], [4, 5]], number: "102" }] });
add("ifc4-unicode-and-quotes.ifc", [wall("w1", [0, 0], [5, 0], "L0", { name: "Owner's wall é ع 你" })], { schema: "IFC4", levels: L(1), projectName: "Owner's \"project\" \\ é" });
add("ifc4-stress-400-walls.ifc", Array.from({ length: 400 }, (_, i) => wall("w" + i, [(i % 20) * 3, Math.floor(i / 20) * 3], [(i % 20) * 3 + 2.5, Math.floor(i / 20) * 3], "L" + (i % 2))), { schema: "IFC4", levels: L(2), projectName: "Stress 400 walls" });
add("ifc2x3-classified.ifc", [wall("w1", [0, 0], [6, 0]), wall("w2", [6, 0], [6, 4])], { schema: "IFC2X3", levels: L(1), projectName: "Classified 2x3",
  classifications: [{ id: "u", name: "Uniclass 2015", source: "NBS", edition: "2015", items: [{ elementId: "w1", code: "Ss_25_30_40" }, { elementId: "w2", code: "Ss_25_30_40" }] }] });
for (const [n, text] of Object.entries(files)) { writeFileSync(path.join(DIR, n), text); console.log("  ✅", n, (text.length / 1024).toFixed(1) + " KB"); }
console.log(`\n${Object.keys(files).length} files in tests/fixtures/ifc-corpus/extended/`);
