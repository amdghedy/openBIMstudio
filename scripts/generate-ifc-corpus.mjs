#!/usr/bin/env node
/**
 * Generate the semantic IFC test corpus from the platform's own writer.
 *
 * Output (all deterministic — fixed timestamp + stableIfcGuid):
 *   tests/fixtures/ifc-corpus/mep-model.ifc          IFC4  — duct/pipe/tray/conduit + equipment + walls
 *   tests/fixtures/ifc-corpus/arch-classified.ifc    IFC4  — walls + slab + door with Uniclass-style classifications
 *   tests/fixtures/ifc-corpus/invalid/bad-guid.ifc         GlobalId outside the base64 alphabet
 *   tests/fixtures/ifc-corpus/invalid/dangling-ref.ifc     relationship references a missing entity
 *   tests/fixtures/ifc-corpus/invalid/truncated.ifc        file cut mid-DATA (no ENDSEC)
 *   tests/fixtures/ifc-corpus/invalid/missing-units.ifc    IFCPROJECT without unit assignment, unit entities removed
 *
 * Valid fixtures get golden snapshots via scripts/golden-roundtrip.mjs
 * (commit .ifc + snapshots/<name>.ifc.json together). The invalid/ subtree is
 * intentionally NOT scanned by the golden gate — these files must stay invalid.
 *
 * Re-run: node scripts/generate-ifc-corpus.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
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
mkdirSync(CORPUS, { recursive: true });
mkdirSync(INVALID, { recursive: true });

const TS = "2026-11-15T00:00:00Z";
const levels = [
  { id: "L0", name: "Ground", elevation: 0 },
  { id: "L1", name: "First", elevation: 3.2 },
];

const written = [];

function emit(name, model, opts) {
  const res = exportAuthoredToIfc(model, { timestamp: TS, ...opts });
  const file = path.join(CORPUS, name);
  writeFileSync(file, res.text);
  written.push({ name, bytes: res.text.length, stats: res.stats });
  console.log(`  ✅ ${name} — ${res.stats.elements} elements, ${res.stats.openings} openings, ${(res.text.length / 1024).toFixed(1)} KB`);
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

/* ── 3. Invalid fixtures (deliberately broken, per failure class) ─────── */
const validText = exportAuthoredToIfc([
  { id: "w1", type: "wall", name: "Wall A", params: { start: [0, 0], end: [6, 0], height: 3, thickness: 0.2, elevation: 0 }, levelId: "L0" },
], { schema: "IFC4", levels, timestamp: TS }).text;

// 3a. GlobalId outside the buildingSMART base64 alphabet (exactly 22 chars,
// none of which appear in "0-9A-Za-z_$", first char not 0-3). Sliced to 22
// because hand-counting punctuation is error-prone.
const BAD_GUID = "!@#%^&*()!@#%^&*()!@#%^&*()".slice(0, 22);
const badGuid = validText.replace(
  /=(IFCWALL|IFCPROJECT)\('([^']+?)'/,
  (m, cls) => `=${cls}('${BAD_GUID}'`,
);
writeFileSync(path.join(INVALID, "bad-guid.ifc"), badGuid);
written.push({ name: "invalid/bad-guid.ifc", bytes: badGuid.length, kind: "invalid-globalid" });
console.log(`  ✅ invalid/bad-guid.ifc — ${badGuid.length} bytes`);

// 3b. Dangling relationship reference (element replaced by a missing id).
const dangling = validText.replace(
  /=IFCRELCONTAINEDINSPATIALSTRUCTURE\('([^']+)',#[0-9]+,\$,\$,\(#([0-9]+)\)/,
  (m, g, first) => m.replace(`#${first}`, "#99999"),
);
writeFileSync(path.join(INVALID, "dangling-ref.ifc"), dangling);
written.push({ name: "invalid/dangling-ref.ifc", bytes: dangling.length, kind: "dangling-ref" });
console.log(`  ✅ invalid/dangling-ref.ifc — ${dangling.length} bytes`);

// 3c. Truncated file — cut 60% through the DATA section.
const cut = Math.floor(validText.length * 0.6);
const truncated = validText.slice(0, cut);
writeFileSync(path.join(INVALID, "truncated.ifc"), truncated);
written.push({ name: "invalid/truncated.ifc", bytes: truncated.length, kind: "truncated" });
console.log(`  ✅ invalid/truncated.ifc — ${truncated.length} bytes`);

// 3d. Missing units — drop the unit entities and every reference to them.
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
written.push({ name: "invalid/missing-units.ifc", bytes: noUnits.length, kind: "missing-units" });
console.log(`  ✅ invalid/missing-units.ifc — ${noUnits.length} bytes`);

console.log(`\nCorpus generation complete: ${written.length} files in tests/fixtures/ifc-corpus/`);
console.log("Next: node scripts/golden-roundtrip.mjs (writes snapshots for the new valid fixtures — commit both).");
