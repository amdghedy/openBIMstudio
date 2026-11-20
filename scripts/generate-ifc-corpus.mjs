#!/usr/bin/env node
/**
 * Generate the semantic IFC test corpus from the platform's own writer.
 *
 * Every fixture is either emitted by the project's own IFC writer
 * (src/modules/bim-gaps/authored-ifc.ts), derived from writer output by a
 * deterministic, documented STEP transform, or hand-authored for this
 * repository (the malformed/ regression fixtures). No third-party content:
 * licence is MIT throughout (the project licence).
 *
 * Valid fixtures (top level, scanned by scripts/golden-roundtrip.mjs):
 *   generated-small.ifc           IFC4  — 2 walls + 1 door (hosted opening) + 1 slab
 *   generated-2x3.ifc             IFC2X3 — same model, IFC2X3 schema
 *   generated-structural.ifc      IFC4  — 1 beam + 1 column
 *   mep-model.ifc                 IFC4  — duct/pipe/tray/conduit + equipment + walls
 *   arch-classified.ifc           IFC4  — walls + slab + door with Uniclass-style classifications
 *   spatial-hierarchy.ifc         IFC4  — 3 storeys, 4 IfcSpace rooms, site→building→storey tree
 *   structural-2x3.ifc            IFC2X3 — columns + beams + footings + brace + strip footing
 *   mep-systems.ifc               IFC4  — 3 ducts + 2 pipes + tray + conduit + 2 AHUs, 2 storeys
 *   property-sets.ifc             IFC4  — per-element properties + materials + quantities
 *   units-imperial.ifc            IFC4  — same model as the derived base, length unit FOOT
 *                                     (conversion-based, 0.3048 m) instead of SI METRE
 *   geometry-complex.ifc          IFC4  — L-stair, ramp, railing, curtain wall, gable roof,
 *                                     baseboard sweep, vertical opening voiding a slab
 *   relationships.ifc             IFC4  — voids/fills, space aggregate, materials, classification
 *   arch-2x3.ifc                  IFC2X3 — walls + door + window + slab + column + space
 *   scale-grid.ifc                IFC4  — 4 storeys x 8 bays, 100 elements
 *   model.ifczip                  IFC4  — STORE zip of spatial-hierarchy.ifc (fixed timestamp)
 *
 * Invalid fixtures (intentionally broken models; NOT scanned by the golden gate):
 *   invalid/bad-guid.ifc          GlobalId outside the base64 alphabet
 *   invalid/dangling-ref.ifc      relationship references a missing entity
 *   invalid/truncated.ifc         file cut mid-DATA (no ENDSEC)
 *   invalid/missing-units.ifc     IFCPROJECT without unit assignment, unit entities removed
 *   invalid/duplicate-guid.ifc    two walls share one GlobalId
 *
 * Malformed fixtures (parser-hang regressions, issue #231; rejected by the
 * structural pre-flight before they ever reach web-ifc):
 *   malformed/unterminated-string-min.ifc, malformed/truncated-in-string-min.ifc,
 *   malformed/broken-enum-min.ifc, malformed/broken-enum-shift-min.ifc
 *   (hand-authored; see malformed/README.md — the generator only verifies
 *   they are present and records their hashes in the manifest, it does not
 *   regenerate them.)
 *
 * The generator also writes tests/fixtures/ifc-corpus/manifest.json — the
 * machine-readable source of truth (source, licence, schema, expected
 * result, test purpose, coverage per fixture, plus bytes/sha256/entity
 * counts). tests/ifc-corpus-manifest.test.mjs reads the manifest and fails
 * on any drift between manifest and files. Re-run after any fixture change:
 *
 *   node scripts/generate-ifc-corpus.mjs
 *   node scripts/golden-roundtrip.mjs   (writes snapshots for the new valid fixtures — commit both)
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(path.join(tmpdir(), "obs-ifc-corpus-"));

console.log("Compiling authored-ifc.ts + ifc-guid.ts…");
const tsc = spawnSync(
  "npx",
  ["tsc", "--rootDir", "src", "--outDir", out, "--module", "commonjs", "--moduleResolution", "node",
   "--target", "ES2022", "--skipLibCheck", "--noCheck", "src/modules/bim-gaps/authored-ifc.ts"],
  { cwd: root, stdio: "inherit", shell: true },
);
if (tsc.status !== 0) process.exit(1);

const require = createRequire(import.meta.url);
const { exportAuthoredToIfc } = require(path.join(out, "modules/bim-gaps/authored-ifc.js"));

const CORPUS = path.join(root, "tests/fixtures/ifc-corpus");
const INVALID = path.join(CORPUS, "invalid");
const MALFORMED = path.join(CORPUS, "malformed");
mkdirSync(CORPUS, { recursive: true });
mkdirSync(INVALID, { recursive: true });
mkdirSync(MALFORMED, { recursive: true });

const TS = "2026-11-15T00:00:00Z";
const levels = [
  { id: "L0", name: "Ground", elevation: 0 },
  { id: "L1", name: "First", elevation: 3.2 },
];
const levels3 = [...levels, { id: "L2", name: "Second", elevation: 6.4 }];
const levels4 = [...levels3, { id: "L3", name: "Third", elevation: 9.6 }];

const written = [];

function emit(name, model, opts) {
  const res = exportAuthoredToIfc(model, { timestamp: TS, ...opts });
  if (res.stats.skipped.length) {
    console.error(`  ❌ ${name} — writer skipped elements: ${JSON.stringify(res.stats.skipped)}`);
    process.exit(1);
  }
  const file = path.join(CORPUS, name);
  writeFileSync(file, res.text);
  written.push(name);
  console.log(`  ✅ ${name} — ${res.stats.elements} elements, ${res.stats.openings} openings, ${(res.text.length / 1024).toFixed(1)} KB`);
  return res.text;
}

/* ── 1. MEP model (IFC4): linear MEP runs + equipment + host walls ─────── */
emit("mep-model.ifc", [
  { id: "w1", type: "wall", name: "Wall A", params: { start: [0, 0], end: [8, 0], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0" },
  { id: "w2", type: "wall", name: "Wall B", params: { start: [8, 0], end: [8, 6], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0" },
  { id: "d1", type: "duct", name: "Supply duct 01", params: { start: [0, 0.3], end: [8, 0.3], height: 3.0, thickness: 0.4, depth: 0.25, elevation: 2.9 }, levelId: "L0" },
  { id: "d2", type: "duct", name: "Return duct 01", params: { start: [0, 0.8], end: [8, 0.8], height: 3.0, thickness: 0.4, depth: 0.25, elevation: 2.9 }, levelId: "L0" },
  { id: "p1", type: "pipe", name: "Chilled water supply", params: { start: [8, 0.3], end: [8, 6], height: 3.0, thickness: 0.08, elevation: 2.6 }, levelId: "L0" },
  { id: "t1", type: "cable-tray", name: "Power tray 01", params: { start: [0, 5.4], end: [8, 5.4], height: 3.0, thickness: 0.3, depth: 0.1, elevation: 3.1 }, levelId: "L1" },
  { id: "c1", type: "conduit", name: "Conduit 01", params: { start: [0, 5.8], end: [8, 5.8], height: 3.0, thickness: 0.03, elevation: 3.1 }, levelId: "L1" },
  { id: "ahu1", type: "equipment", name: "AHU 01", params: { point: [1, 3], height: 1.8, thickness: 2.4, depth: 1.2, elevation: 0.4 }, levelId: "L0" },
], { schema: "IFC4", levels, projectName: "MEP Semantic Corpus" });

/* ── 2. Classified architecture model (IFC4) ──────────────────────────── */
emit("arch-classified.ifc", [
  { id: "w1", type: "wall", name: "Wall A", params: { start: [0, 0], end: [6, 0], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0", properties: { material: "Brick" } },
  { id: "w2", type: "wall", name: "Wall B", params: { start: [6, 0], end: [6, 4], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0" },
  { id: "d1", type: "door", name: "Door 1", hostId: "w1", params: { width: 0.9, height: 2.1, thickness: 0.2, elevation: 0, offsetAlongHost: 2, sillHeight: 0 } },
  { id: "s1", type: "slab", name: "Floor", params: { polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], height: 0.2, thickness: 0.2, elevation: -0.2 }, levelId: "L0" },
], {
  schema: "IFC4", levels,
  projectName: "Classified Arch Corpus",
  classifications: [{
    id: "uniclass-2015",
    name: "Uniclass 2015",
    source: "NBS",
    edition: "2015",
    location: "https://uc.nbs.co.uk",
    description: "Unified classification system example pack",
    items: [
      { elementId: "w1", code: "Ss_25_30_40", name: "External walls" },
      { elementId: "w2", code: "Ss_25_30_40", name: "External walls" },
      { elementId: "d1", code: "Do_07_10_20", name: "Single leaf doors" },
      { elementId: "s1", code: "Ss_25_10_30", name: "Ground slabs" },
    ],
  }],
});

/* ── 3. Spatial hierarchy (IFC4): 3 storeys + 4 IfcSpace rooms ────────── */
const spatialText = emit("spatial-hierarchy.ifc", [
  { id: "w1", type: "wall", name: "Wall A", params: { start: [0, 0], end: [10, 0], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0" },
  { id: "w2", type: "wall", name: "Wall B", params: { start: [10, 0], end: [10, 8], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0" },
  { id: "w3", type: "wall", name: "Wall C", params: { start: [0, 0], end: [10, 0], height: 3, thickness: 0.2, elevation: 3.2 }, levelId: "L1" },
  { id: "w4", type: "wall", name: "Wall D", params: { start: [0, 0], end: [10, 0], height: 3, thickness: 0.2, elevation: 6.4 }, levelId: "L2" },
  { id: "s1", type: "slab", name: "Floor L1", params: { polygon: [[0, 0], [10, 0], [10, 8], [0, 8]], height: 0.2, thickness: 0.2, elevation: 3.0 }, levelId: "L1" },
  { id: "s2", type: "slab", name: "Floor L2", params: { polygon: [[0, 0], [10, 0], [10, 8], [0, 8]], height: 0.2, thickness: 0.2, elevation: 6.2 }, levelId: "L2" },
], {
  schema: "IFC4", levels: levels3, projectName: "Spatial Hierarchy Corpus",
  spaces: [
    { id: "r1", name: "Lobby", number: "001", levelId: "L0", boundary: [{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 5, z: 8 }, { x: 0, z: 8 }], height: 3, department: "Circulation" },
    { id: "r2", name: "Office", number: "002", levelId: "L0", boundary: [{ x: 5, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 8 }, { x: 5, z: 8 }], height: 3, department: "Work" },
    { id: "r3", name: "Meeting", number: "101", levelId: "L1", boundary: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 8 }, { x: 0, z: 8 }], height: 3 },
    { id: "r4", name: "Roof plant", number: "201", levelId: "L2", boundary: [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 8 }, { x: 0, z: 8 }], height: 3 },
  ],
});

/* ── 4. Structural model, IFC2X3 ───────────────────────────────────────── */
emit("structural-2x3.ifc", [
  { id: "c1", type: "column", name: "C1", params: { point: [0, 0], height: 3.2, thickness: 0.4, depth: 0.4, elevation: 0 }, levelId: "L0" },
  { id: "c2", type: "column", name: "C2", params: { point: [6, 0], height: 3.2, thickness: 0.4, depth: 0.4, elevation: 0 }, levelId: "L0" },
  { id: "c3", type: "column", name: "C3", params: { point: [0, 0], height: 3.2, thickness: 0.4, depth: 0.4, elevation: 3.2 }, levelId: "L1" },
  { id: "b1", type: "beam", name: "B1", params: { start: [0, 0], end: [6, 0], height: 0.5, thickness: 0.3, elevation: 2.7 }, levelId: "L0" },
  { id: "b2", type: "beam", name: "B2", params: { start: [0, 0], end: [6, 0], height: 0.5, thickness: 0.3, elevation: 5.9 }, levelId: "L1" },
  { id: "f1", type: "footing", name: "F1", params: { point: [0, 0], height: 0.6, thickness: 1.2, depth: 1.2, elevation: 0 }, levelId: "L0" },
  { id: "f2", type: "footing", name: "F2", params: { point: [6, 0], height: 0.6, thickness: 1.2, depth: 1.2, elevation: 0 }, levelId: "L0" },
  { id: "br1", type: "brace", name: "BR1", params: { start: [0, 0], end: [6, 0], height: 3.2, thickness: 0.15, elevation: 0 }, levelId: "L0" },
  { id: "st1", type: "strip", name: "Strip footing", params: { start: [0, 0], end: [6, 0], height: 0.5, thickness: 0.6, elevation: -0.5 }, levelId: "L0" },
], { schema: "IFC2X3", levels, projectName: "Structural 2x3 Corpus" });

/* ── 5. MEP systems model (IFC4): more runs, 2 AHUs, 2 storeys ─────────── */
emit("mep-systems.ifc", [
  { id: "w1", type: "wall", name: "Wall A", params: { start: [0, 0], end: [12, 0], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0" },
  { id: "d1", type: "duct", name: "Supply duct", params: { start: [0, 0.3], end: [12, 0.3], height: 3.0, thickness: 0.5, depth: 0.3, elevation: 2.9 }, levelId: "L0" },
  { id: "d2", type: "duct", name: "Return duct", params: { start: [0, 0.9], end: [12, 0.9], height: 3.0, thickness: 0.5, depth: 0.3, elevation: 2.9 }, levelId: "L0" },
  { id: "d3", type: "duct", name: "First-floor duct", params: { start: [0, 0.3], end: [12, 0.3], height: 3.0, thickness: 0.4, depth: 0.25, elevation: 6.1 }, levelId: "L1" },
  { id: "p1", type: "pipe", name: "CHW supply", params: { start: [12, 0.3], end: [12, 8], height: 3.0, thickness: 0.1, elevation: 2.6 }, levelId: "L0" },
  { id: "p2", type: "pipe", name: "CHW return", params: { start: [12, 0.6], end: [12, 8], height: 3.0, thickness: 0.1, elevation: 2.6 }, levelId: "L0" },
  { id: "t1", type: "cable-tray", name: "Power tray", params: { start: [0, 7.4], end: [12, 7.4], height: 3.0, thickness: 0.3, depth: 0.1, elevation: 3.1 }, levelId: "L0" },
  { id: "c1", type: "conduit", name: "Conduit", params: { start: [0, 7.8], end: [12, 7.8], height: 3.0, thickness: 0.04, elevation: 3.1 }, levelId: "L0" },
  { id: "ahu1", type: "equipment", name: "AHU 01", params: { point: [1, 3], height: 1.8, thickness: 2.4, depth: 1.2, elevation: 0.4 }, levelId: "L0" },
  { id: "ahu2", type: "equipment", name: "AHU 02", params: { point: [1, 3], height: 1.8, thickness: 2.4, depth: 1.2, elevation: 3.6 }, levelId: "L1" },
], { schema: "IFC4", levels, projectName: "MEP Systems Corpus" });

/* ── 6. Property sets (IFC4): properties + materials + quantities ──────── */
emit("property-sets.ifc", [
  { id: "w1", type: "wall", name: "Wall A", params: { start: [0, 0], end: [6, 0], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0", properties: { material: "Brick", fireRating: "F60", acousticRating: 52, loadBearing: true, costCode: "W-01" } },
  { id: "w2", type: "wall", name: "Wall B", params: { start: [6, 0], end: [6, 4], height: 3, thickness: 0.15, elevation: 0 }, levelId: "L0", properties: { material: "Concrete", fireRating: "F90" } },
  { id: "d1", type: "door", name: "Door 1", hostId: "w1", params: { width: 0.9, height: 2.1, thickness: 0.2, elevation: 0, offsetAlongHost: 2, sillHeight: 0 }, properties: { material: "Timber", fireRating: "F30" } },
  { id: "s1", type: "slab", name: "Floor", params: { polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], height: 0.2, thickness: 0.2, elevation: -0.2 }, levelId: "L0", properties: { material: "Concrete C30/37", finish: "Polished" } },
  { id: "c1", type: "column", name: "C1", params: { point: [3, 2], height: 3, thickness: 0.3, depth: 0.3, elevation: 0 }, levelId: "L0", properties: { material: "Steel S355", section: "UC 203x203" } },
], { schema: "IFC4", levels, projectName: "Property Sets Corpus" });

/* ── 7. Geometry complexity (IFC4): M2 types + sweep + slab void ───────── */
emit("geometry-complex.ifc", [
  { id: "w1", type: "wall", name: "Wall A", params: { start: [0, 0], end: [10, 0], height: 3.2, thickness: 0.2, elevation: 0, sweeps: [{ wallId: "w1", profileId: "baseboard-100", height: 0.1, face: "interior" }] }, levelId: "L0" },
  { id: "w2", type: "wall", name: "Wall B", params: { start: [10, 0], end: [10, 8], height: 3.2, thickness: 0.2, elevation: 0 }, levelId: "L0" },
  { id: "st1", type: "stairs", name: "Stair L", params: { start: [1, 1], end: [4, 1], width: 1.2, height: 3.2, thickness: 0.3, elevation: 0 }, levelId: "L0", properties: { stairShape: "L" } },
  { id: "rp1", type: "ramp", name: "Ramp", params: { start: [6, 1], end: [9, 1], width: 1.5, height: 0.8, thickness: 0.15, elevation: 0 }, levelId: "L0" },
  { id: "rl1", type: "railing", name: "Railing", params: { polygon: [[0, 0], [10, 0], [10, 8]], height: 1.1, thickness: 0.05, elevation: 3.2 }, levelId: "L1" },
  { id: "cw1", type: "curtain-wall", name: "Curtain wall", params: { start: [0, 8], end: [10, 8], height: 3.2, thickness: 0.15, elevation: 0 }, levelId: "L0" },
  { id: "rf1", type: "roof", name: "Gable roof", params: { polygon: [[0, 0], [10, 0], [10, 8], [0, 8]], height: 1.5, thickness: 0.2, elevation: 3.2 }, levelId: "L1", properties: { slopeDeg: 30, roofType: "gable" } },
  { id: "s1", type: "slab", name: "Floor with stair void", params: { polygon: [[0, 0], [10, 0], [10, 8], [0, 8]], height: 0.2, thickness: 0.2, elevation: 3.0 }, levelId: "L1" },
  { id: "vo1", type: "vertical-opening", name: "Stair void", params: { point: [2.5, 1], width: 2, depth: 3, height: 3.2, elevation: 3.0 } },
], { schema: "IFC4", levels, projectName: "Geometry Complexity Corpus" });

/* ── 8. Relationships (IFC4): voids/fills, spaces, materials, classification */
emit("relationships.ifc", [
  { id: "w1", type: "wall", name: "Wall A", params: { start: [0, 0], end: [6, 0], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0", properties: { material: "Brick" } },
  { id: "w2", type: "wall", name: "Wall B", params: { start: [6, 0], end: [6, 4], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0", properties: { material: "Brick" } },
  { id: "d1", type: "door", name: "Door 1", hostId: "w1", params: { width: 0.9, height: 2.1, thickness: 0.2, elevation: 0, offsetAlongHost: 2, sillHeight: 0 } },
  { id: "wn1", type: "window", name: "Window 1", hostId: "w2", params: { width: 1.2, height: 1.4, thickness: 0.2, elevation: 0, offsetAlongHost: 2, sillHeight: 0.9 } },
  { id: "s1", type: "slab", name: "Floor", params: { polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], height: 0.2, thickness: 0.2, elevation: -0.2 }, levelId: "L0" },
], {
  schema: "IFC4", levels,
  projectName: "Relationships Corpus",
  spaces: [{ id: "r1", name: "Room", number: "001", levelId: "L0", boundary: [{ x: 0, z: 0 }, { x: 6, z: 0 }, { x: 6, z: 4 }, { x: 0, z: 4 }], height: 3 }],
  classifications: [{
    id: "uniclass-2015",
    name: "Uniclass 2015",
    source: "NBS",
    edition: "2015",
    location: "https://uc.nbs.co.uk",
    description: "Unified classification system example pack",
    items: [
      { elementId: "w1", code: "Ss_25_30_40", name: "External walls" },
      { elementId: "w2", code: "Ss_25_30_40", name: "External walls" },
      { elementId: "d1", code: "Do_07_10_20", name: "Single leaf doors" },
      { elementId: "s1", code: "Ss_25_10_30", name: "Ground slabs" },
    ],
  }],
});

/* ── 9. Architecture, IFC2X3 ───────────────────────────────────────────── */
emit("arch-2x3.ifc", [
  { id: "w1", type: "wall", name: "Wall A", params: { start: [0, 0], end: [8, 0], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0", properties: { material: "Brick" } },
  { id: "w2", type: "wall", name: "Wall B", params: { start: [8, 0], end: [8, 6], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0" },
  { id: "w3", type: "wall", name: "Wall C", params: { start: [0, 6], end: [8, 6], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0" },
  { id: "d1", type: "door", name: "Door 1", hostId: "w1", params: { width: 0.9, height: 2.1, thickness: 0.2, elevation: 0, offsetAlongHost: 3, sillHeight: 0 } },
  { id: "wn1", type: "window", name: "Window 1", hostId: "w2", params: { width: 1.2, height: 1.4, thickness: 0.2, elevation: 0, offsetAlongHost: 3, sillHeight: 0.9 } },
  { id: "s1", type: "slab", name: "Floor", params: { polygon: [[0, 0], [8, 0], [8, 6], [0, 6]], height: 0.2, thickness: 0.2, elevation: -0.2 }, levelId: "L0" },
  { id: "c1", type: "column", name: "C1", params: { point: [4, 3], height: 3, thickness: 0.3, depth: 0.3, elevation: 0 }, levelId: "L0" },
], {
  schema: "IFC2X3", levels, projectName: "Arch 2x3 Corpus",
  spaces: [{ id: "r1", name: "Hall", number: "001", levelId: "L0", boundary: [{ x: 0, z: 0 }, { x: 8, z: 0 }, { x: 8, z: 6 }, { x: 0, z: 6 }], height: 3 }],
});

/* ── 10. Scale grid (IFC4): 4 storeys x 8 bays = 100 elements ─────────── */
{
  const model = [];
  for (let s = 0; s < 4; s++) {
    const lv = `L${s}`, el = s * 3.2;
    for (let gx = 0; gx < 8; gx++) {
      model.push({ id: `w${s}x${gx}`, type: "wall", name: `Wall ${s}-${gx}`, params: { start: [gx * 4, 0], end: [gx * 4 + 4, 0], height: 3, thickness: 0.2, elevation: el }, levelId: lv });
      model.push({ id: `c${s}x${gx}`, type: "column", name: `C ${s}-${gx}`, params: { point: [gx * 4, 4], height: 3, thickness: 0.3, depth: 0.3, elevation: el }, levelId: lv });
      model.push({ id: `b${s}x${gx}`, type: "beam", name: `B ${s}-${gx}`, params: { start: [gx * 4, 0], end: [gx * 4 + 4, 0], height: 0.5, thickness: 0.25, elevation: el + 2.5 }, levelId: lv });
    }
    model.push({ id: `s${s}`, type: "slab", name: `Floor ${s}`, params: { polygon: [[0, 0], [32, 0], [32, 8], [0, 8]], height: 0.2, thickness: 0.2, elevation: el - 0.2 }, levelId: lv });
  }
  emit("scale-grid.ifc", model, { schema: "IFC4", levels: levels4, projectName: "Scale Grid Corpus" });
}

/* ── 11. Derived base model (writer output, reused by the transforms) ─── */
const derivedBase = exportAuthoredToIfc([
  { id: "w1", type: "wall", name: "Wall A", params: { start: [0, 0], end: [6, 0], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0", properties: { material: "Brick" } },
  { id: "w2", type: "wall", name: "Wall B", params: { start: [6, 0], end: [6, 4], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0" },
  { id: "s1", type: "slab", name: "Floor", params: { polygon: [[0, 0], [6, 0], [6, 4], [0, 4]], height: 0.2, thickness: 0.2, elevation: -0.2 }, levelId: "L0" },
], { schema: "IFC4", levels, timestamp: TS, projectName: "Derived Corpus Base" }).text;

/* ── 11a. Imperial units: SI METRE length unit replaced by a
 * conversion-based FOOT (0.3048 m). The METRE unit entity is kept — the
 * FOOT converts from it — and only the IFCUNITASSIGNMENT reference is
 * retargeted. New entities are appended inside the DATA section. */
function toImperialUnits(text) {
  const lines = text.split("\n");
  const maxId = lines.reduce((m, l) => { const x = /^#(\d+)=/.exec(l); return x ? Math.max(m, Number(x[1])) : m; }, 0);
  const lenUnit = lines.find((l) => /=IFCSIUNIT\(\*,\.LENGTHUNIT\.,\$,\.METRE\.\);$/.test(l));
  if (!lenUnit) throw new Error("length SI unit line not found");
  const lenId = Number(/^#(\d+)=/.exec(lenUnit)[1]);
  const mwu = maxId + 1, cbu = maxId + 2;
  const outLines = lines.map((l) => (/=IFCUNITASSIGNMENT\(/.test(l) ? l.replace(new RegExp(`#${lenId}\\b`), `#${cbu}`) : l));
  const dataAt = outLines.findIndex((l) => l.trim() === "DATA;");
  const endsec = outLines.findIndex((l, i) => i > dataAt && l.trim() === "ENDSEC;");
  outLines.splice(endsec, 0,
    `#${mwu}=IFCMEASUREWITHUNIT(0.3048,#${lenId});`,
    `#${cbu}=IFCCONVERSIONBASEDUNIT('FOOT',.LENGTHUNIT.,#${mwu},'FOOT');`);
  return outLines.join("\n");
}
writeFileSync(path.join(CORPUS, "units-imperial.ifc"), toImperialUnits(derivedBase));
written.push("units-imperial.ifc");
console.log("  ✅ units-imperial.ifc — length unit FOOT (0.3048 m), derived from writer output");

/* ── 12. Invalid fixtures (deliberately broken, per failure class) ─────── */
const validText = exportAuthoredToIfc([
  { id: "w1", type: "wall", name: "Wall A", params: { start: [0, 0], end: [6, 0], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0" },
], { schema: "IFC4", levels, timestamp: TS }).text;

// 12a. GlobalId outside the buildingSMART base64 alphabet (exactly 22 chars,
// none of which appear in "0-9A-Za-z_$", first char not 0-3). Sliced to 22
// because hand-counting punctuation is error-prone.
const BAD_GUID = "!@#%^&*()!@#%^&*()!@#%^&*()".slice(0, 22);
const badGuid = validText.replace(
  /=(IFCWALL|IFCPROJECT)\('([^']+?)'/,
  (m, cls) => `=${cls}('${BAD_GUID}'`,
);
writeFileSync(path.join(INVALID, "bad-guid.ifc"), badGuid);
written.push("invalid/bad-guid.ifc");
console.log(`  ✅ invalid/bad-guid.ifc — ${badGuid.length} bytes`);

// 12b. Dangling relationship reference (element replaced by a missing id).
const dangling = validText.replace(
  /=IFCRELCONTAINEDINSPATIALSTRUCTURE\('([^']+)',#[0-9]+,\$,\$,\(#([0-9]+)\)/,
  (m, g, first) => m.replace(`#${first}`, "#99999"),
);
writeFileSync(path.join(INVALID, "dangling-ref.ifc"), dangling);
written.push("invalid/dangling-ref.ifc");
console.log(`  ✅ invalid/dangling-ref.ifc — ${dangling.length} bytes`);

// 12c. Truncated file — cut 60% through the DATA section.
const cut = Math.floor(validText.length * 0.6);
const truncated = validText.slice(0, cut);
writeFileSync(path.join(INVALID, "truncated.ifc"), truncated);
written.push("invalid/truncated.ifc");
console.log(`  ✅ invalid/truncated.ifc — ${truncated.length} bytes`);

// 12d. Missing units — drop the unit entities and every reference to them.
const unitLines = validText.split("\n");
const removedIds = new Set();
const keptLines = unitLines.filter((l) => {
  if (/=IFCSIUNIT\(/.test(l) || /=IFCUNITASSIGNMENT\(/.test(l)) {
    const m = /^#(\d+)=/.exec(l);
    if (m) removedIds.add(Number(m[1]));
    return false;
  }
  return true;
});
const noUnits = keptLines
  .map((l) => l.replace(/#(\d+)/g, (m, d) => (removedIds.has(Number(d)) ? "$" : m)))
  .join("\n");
writeFileSync(path.join(INVALID, "missing-units.ifc"), noUnits);
written.push("invalid/missing-units.ifc");
console.log(`  ✅ invalid/missing-units.ifc — ${noUnits.length} bytes`);

// 12e. Duplicate GlobalId — the second wall reuses the first wall's GUID.
// The file stays structurally valid STEP; the semantic validator flags
// IFC-W-DUP-GUID and the model must not be trusted for identity joins.
{
  const wallGuids = [...derivedBase.matchAll(/=IFCWALL\('([^']+)'/g)].map((m) => m[1]);
  if (wallGuids.length < 2) throw new Error("derived base needs two walls for duplicate-guid");
  let n = 0;
  const dup = derivedBase.replace(/=IFCWALL\('([^']+)'/g, (m, g) => (++n === 2 ? m.replace(g, wallGuids[0]) : m));
  writeFileSync(path.join(INVALID, "duplicate-guid.ifc"), dup);
  written.push("invalid/duplicate-guid.ifc");
  console.log(`  ✅ invalid/duplicate-guid.ifc — ${dup.length} bytes (GUID ${wallGuids[0]} on two walls)`);
}

/* ── 13. .ifczip: deterministic STORE zip of spatial-hierarchy.ifc ───────
 * Minimal ZIP writer (no dependency): one stored entry, fixed DOS date
 * 2026-11-15 00:00:00, UTF-8 flag set. The app expands .ifczip with JSZip
 * (src/features/importer.ts); the corpus test re-opens it with JSZip. */
function storeZip(entryName, data) {
  const nameB = Buffer.from(entryName, "utf8");
  const dosDate = ((2026 - 1980) << 25) | (11 << 21) | (15 << 16);
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
  lh.writeUInt16LE(0, 8); lh.writeUInt32LE(dosDate, 10); lh.writeUInt32LE(0, 14);
  lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameB.length, 26); lh.writeUInt16LE(0, 28);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
  cd.writeUInt16LE(0, 10); cd.writeUInt32LE(dosDate, 12); cd.writeUInt32LE(0, 16);
  cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameB.length, 28); cd.writeUInt32LE(0, 38);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameB.length, 12);
  eocd.writeUInt32LE(30 + nameB.length + data.length, 16);
  return Buffer.concat([lh, nameB, data, cd, nameB, eocd]);
}
{
  const zip = storeZip("spatial-hierarchy.ifc", Buffer.from(spatialText, "utf8"));
  writeFileSync(path.join(CORPUS, "model.ifczip"), zip);
  written.push("model.ifczip");
  console.log(`  ✅ model.ifczip — STORE zip of spatial-hierarchy.ifc, ${zip.length} bytes`);
}

/* ── 14. Manifest: the machine-readable source of truth ──────────────────
 * Metadata (schema, purpose, coverage, expected result) is hand-maintained
 * below; bytes/sha256/entities are measured from the files on disk so the
 * manifest can never silently drift from the fixtures. The manifest test
 * re-measures and fails on any mismatch. */
const META = {
  "generated-small.ifc": { kind: "valid", schema: "IFC4", source: "project writer (scripts/generate-ifc.mjs)", testPurpose: "baseline arch model: 2 walls + 1 door in a hosted opening + 1 slab; semantic-model and golden-roundtrip reference", coverage: ["ifc4", "architecture", "spatial-hierarchy", "relationships", "property-sets"], expectedResult: "parse-ok" },
  "generated-2x3.ifc": { kind: "valid", schema: "IFC2X3", source: "project writer (scripts/generate-ifc.mjs)", testPurpose: "same model as generated-small.ifc under the IFC2X3 schema (IFCWALLSTANDARDCASE, 2x3 classifications)", coverage: ["ifc2x3", "architecture"], expectedResult: "parse-ok" },
  "generated-structural.ifc": { kind: "valid", schema: "IFC4", source: "project writer (scripts/generate-ifc.mjs)", testPurpose: "minimal structural model: 1 beam + 1 column", coverage: ["ifc4", "structural"], expectedResult: "parse-ok" },
  "mep-model.ifc": { kind: "valid", schema: "IFC4", source: "project writer (this script)", testPurpose: "MEP segments (duct/pipe/tray/conduit) + equipment + host walls across 2 storeys", coverage: ["ifc4", "mep", "spatial-hierarchy"], expectedResult: "parse-ok" },
  "arch-classified.ifc": { kind: "valid", schema: "IFC4", source: "project writer (this script)", testPurpose: "arch model + Uniclass 2015 classification references on 4 elements", coverage: ["ifc4", "architecture", "property-sets", "relationships"], expectedResult: "parse-ok" },
  "spatial-hierarchy.ifc": { kind: "valid", schema: "IFC4", source: "project writer (this script)", testPurpose: "spatial tree depth: site→building→3 storeys→4 IfcSpace rooms with departments", coverage: ["ifc4", "architecture", "spatial-hierarchy"], expectedResult: "parse-ok" },
  "structural-2x3.ifc": { kind: "valid", schema: "IFC2X3", source: "project writer (this script)", testPurpose: "structural model under IFC2X3: columns, beams, pad + strip footings, diagonal brace", coverage: ["ifc2x3", "structural"], expectedResult: "parse-ok" },
  "mep-systems.ifc": { kind: "valid", schema: "IFC4", source: "project writer (this script)", testPurpose: "extended MEP: 3 ducts, 2 pipes, tray + conduit, 2 AHUs across 2 storeys. NOTE: the writer emits no IfcSystem grouping, so system membership is not covered here", coverage: ["ifc4", "mep", "spatial-hierarchy"], expectedResult: "parse-ok" },
  "property-sets.ifc": { kind: "valid", schema: "IFC4", source: "project writer (this script)", testPurpose: "rich property sets on every element (incl. typed values: label, number, boolean), material associations, element quantities", coverage: ["ifc4", "architecture", "property-sets", "relationships"], expectedResult: "parse-ok" },
  "units-imperial.ifc": { kind: "valid", schema: "IFC4", source: "project writer + deterministic STEP transform (this script §11a)", testPurpose: "non-SI units: conversion-based FOOT length unit (0.3048 m); the independent reader must report factor 0.3048 and validation must stay error-free", coverage: ["ifc4", "units"], expectedResult: "parse-ok" },
  "geometry-complex.ifc": { kind: "valid", schema: "IFC4", source: "project writer (this script)", testPurpose: "geometry variety: L-stair, ramp, railing, curtain wall, gable roof (IfcSlab .ROOF.), baseboard sweep (IfcCovering), vertical opening voiding a slab", coverage: ["ifc4", "architecture", "geometry-complexity", "relationships"], expectedResult: "parse-ok" },
  "relationships.ifc": { kind: "valid", schema: "IFC4", source: "project writer (this script)", testPurpose: "relationship coverage in one file: voids/fills (door + window), space aggregate, material associations, Uniclass classification", coverage: ["ifc4", "architecture", "relationships", "spatial-hierarchy", "property-sets"], expectedResult: "parse-ok" },
  "arch-2x3.ifc": { kind: "valid", schema: "IFC2X3", source: "project writer (this script)", testPurpose: "architecture under IFC2X3: walls, hosted door + window, slab, column, one IfcSpace", coverage: ["ifc2x3", "architecture", "spatial-hierarchy"], expectedResult: "parse-ok" },
  "scale-grid.ifc": { kind: "valid", schema: "IFC4", source: "project writer (this script)", testPurpose: "scale: 4 storeys x 8 bays, 100 elements (walls, columns, beams, slabs); the corpus's largest fixture by element count", coverage: ["ifc4", "architecture", "structural", "scale", "geometry-complexity"], expectedResult: "parse-ok" },
  "model.ifczip": { kind: "archive", schema: "IFC4", source: "project writer output packaged by this script (§13, STORE zip, fixed timestamp)", testPurpose: ".ifczip packaging: exactly one .ifc entry (spatial-hierarchy.ifc) that parses identically to the loose file", coverage: ["ifc4", "architecture", "spatial-hierarchy", "ifczip"], expectedResult: "unzip-and-parse-ok", innerFile: "spatial-hierarchy.ifc" },
  "invalid/bad-guid.ifc": { kind: "invalid", schema: "IFC4", source: "project writer + deterministic STEP transform (this script §12a)", testPurpose: "GlobalId outside the base64 alphabet must be flagged, model stays readable", coverage: ["invalid"], expectedResult: "semantic-findings", expectedFindingCodes: ["IFC-E-BAD-GUID"] },
  "invalid/dangling-ref.ifc": { kind: "invalid", schema: "IFC4", source: "project writer + deterministic STEP transform (this script §12b)", testPurpose: "relationship references a missing entity (#99999) must be flagged with attribution", coverage: ["invalid"], expectedResult: "semantic-findings", expectedFindingCodes: ["IFC-E-DANGLING-REF"] },
  "invalid/truncated.ifc": { kind: "invalid", schema: "IFC4", source: "project writer output cut mid-DATA (this script §12c)", testPurpose: "truncated file: readable prefix preserved, truncation warned, no crash", coverage: ["invalid"], expectedResult: "graceful-prefix", expectedFindingCodes: [] },
  "invalid/missing-units.ifc": { kind: "invalid", schema: "IFC4", source: "project writer + deterministic STEP transform (this script §12d)", testPurpose: "IFCPROJECT without unit assignment: units honestly reported absent, never fabricated", coverage: ["invalid"], expectedResult: "semantic-findings", expectedFindingCodes: ["IFC-W-UNITS-MISSING"] },
  "invalid/duplicate-guid.ifc": { kind: "invalid", schema: "IFC4", source: "project writer + deterministic STEP transform (this script §12e)", testPurpose: "two walls share one GlobalId: flagged IFC-W-DUP-GUID; identity joins must not trust it", coverage: ["invalid"], expectedResult: "semantic-findings", expectedFindingCodes: ["IFC-W-DUP-GUID"] },
  "malformed/unterminated-string-min.ifc": { kind: "malformed", schema: "IFC4", source: "hand-authored for this repository, issue #231 (see malformed/README.md)", testPurpose: "closing quote missing in record #1: hangs raw web-ifc OpenModel; pre-flight must reject with a line number", coverage: ["invalid", "malformed"], expectedResult: "preflight-rejected", expectedReason: "Unterminated 'string'" },
  "malformed/truncated-in-string-min.ifc": { kind: "malformed", schema: "IFC4", source: "hand-authored for this repository, issue #231 (see malformed/README.md)", testPurpose: "file ends inside a string, no ENDSEC: hangs raw web-ifc OpenModel; pre-flight must reject", coverage: ["invalid", "malformed"], expectedResult: "preflight-rejected", expectedReason: "Unterminated 'string'" },
  "malformed/broken-enum-min.ifc": { kind: "malformed", schema: "IFC4", source: "hand-authored for this repository, issue #231 (see malformed/README.md)", testPurpose: "enumeration .MODEL_VIEW. with its leading dot flipped to '/': hangs raw web-ifc OpenModel; pre-flight must reject as a malformed enumeration", coverage: ["invalid", "malformed"], expectedResult: "preflight-rejected", expectedReason: "not an enumeration" },
  "malformed/broken-enum-shift-min.ifc": { kind: "malformed", schema: "IFC4", source: "hand-authored for this repository, issue #231 (see malformed/README.md)", testPurpose: "same broken enumeration plus quote flips shifting string boundaries (minimised fuzz failure-0463, seed 42 iter 463): pre-flight must reject", coverage: ["invalid", "malformed"], expectedResult: "preflight-rejected", expectedReason: "not an enumeration" },
};

function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }
function countEntities(buf) {
  const text = buf.toString("latin1");
  return (text.match(/^#\d+=/gm) || []).length;
}

const fixtures = [];
for (const [file, meta] of Object.entries(META)) {
  const p = path.join(CORPUS, file);
  if (!existsSync(p)) {
    console.error(`  ❌ manifest entry ${file} has no file on disk — refusing to write a manifest that lies`);
    process.exit(1);
  }
  const buf = readFileSync(p);
  let entities = 0;
  if (file.endsWith(".ifc")) entities = countEntities(buf);
  else if (file.endsWith(".ifczip")) {
    // entity count of the inner .ifc (verified by the corpus test with JSZip)
    const inner = readFileSync(path.join(CORPUS, meta.innerFile));
    entities = countEntities(inner);
  }
  fixtures.push({
    file, kind: meta.kind, schema: meta.schema, license: "MIT", source: meta.source,
    testPurpose: meta.testPurpose, coverage: meta.coverage, expectedResult: meta.expectedResult,
    ...(meta.expectedFindingCodes ? { expectedFindingCodes: meta.expectedFindingCodes } : {}),
    ...(meta.expectedReason ? { expectedReason: meta.expectedReason } : {}),
    ...(meta.innerFile ? { innerFile: meta.innerFile } : {}),
    bytes: buf.length, sha256: sha256(buf), entities,
  });
}

const manifest = {
  version: 1,
  generatedBy: "scripts/generate-ifc-corpus.mjs",
  license: "MIT — all fixtures generated by the project's own writer/tests or hand-authored for this repository; no third-party content. JSON snapshots under snapshots/ are derived artifacts and are NOT source fixtures.",
  sourceFixtureCount: fixtures.length,
  fixtures,
};
writeFileSync(path.join(CORPUS, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`\nCorpus generation complete: ${written.length} files (re)written in tests/fixtures/ifc-corpus/`);
console.log(`Manifest: ${fixtures.length} source fixtures (${fixtures.filter((f) => f.kind === "valid").length} valid .ifc, ${fixtures.filter((f) => f.kind === "archive").length} .ifczip, ${fixtures.filter((f) => f.kind === "invalid").length} invalid, ${fixtures.filter((f) => f.kind === "malformed").length} malformed)`);
console.log("Next: node scripts/golden-roundtrip.mjs (writes snapshots for the new valid fixtures — commit both).");
