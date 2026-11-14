/**
 * Deterministic IFC fixture generator for OpenBIMStudio performance benchmarks.
 *
 * Uses the production IFC writer (src/modules/bim-gaps/authored-ifc.ts,
 * exportAuthoredToIfc) compiled to CommonJS with tsc — exactly the same
 * pipeline as scripts/generate-ifc.mjs, so fixtures are real production
 * output, not synthetic mocks.
 *
 * Sizes (representative model tiers):
 *   small.ifc    ~ 1 storey,  ≈ 40 elements
 *   medium.ifc   ~ 3 storeys, ≈ 450 elements
 *   large.ifc    ~ 8 storeys, ≈ 2000 elements
 *   fed-a..d.ifc 4 separate medium buildings (federation corpus)
 *
 * Output: bench/fixtures/*.ifc + bench/fixtures/manifest.json
 * Deterministic: fixed grid layout, fixed names, fixed timestamp.
 *
 * Run: node bench/gen-fixtures.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "bench", "fixtures");
mkdirSync(outDir, { recursive: true });

console.log("[fixtures] compiling authored-ifc.ts ...");
const tmpOut = mkdtempSync(path.join(tmpdir(), "obs-bench-ifc-"));
writeFileSync(path.join(tmpOut, "package.json"), '{"type":"commonjs"}');
const tsc = spawnSync(
  "npx",
  [
    "tsc", "--rootDir", "src", "--outDir", tmpOut,
    "--module", "commonjs", "--moduleResolution", "node",
    "--target", "ES2022", "--skipLibCheck", "--noCheck",
    "src/modules/bim-gaps/authored-ifc.ts",
  ],
  { cwd: root, stdio: "inherit", shell: true },
);
if (tsc.status !== 0) process.exit(1);

const require = createRequire(import.meta.url);
const { exportAuthoredToIfc } = require(path.join(tmpOut, "modules/bim-gaps/authored-ifc.js"));

const TIMESTAMP = "2026-01-01T00:00:00Z";
const FLOOR_H = 3.2;
const WALL_H = 3.0;
const WALL_T = 0.2;

/** One rectangular room-grid building. Returns elements + levels. */
function building({ name, floors, colsX, colsY, roomW = 4, roomD = 3, offsetX = 0, offsetY = 0 }) {
  const elements = [];
  const levels = [];
  let n = 0;
  const id = (k) => `${name}-${k}-${n++}`;

  for (let f = 0; f < floors; f++) {
    const z = f * FLOOR_H;
    levels.push({ id: `L${f}`, name: `Level ${f}`, elevation: z });

    // Slab per room
    for (let i = 0; i < colsX; i++) {
      for (let j = 0; j < colsY; j++) {
        elements.push({
          id: id("slab"),
          type: "slab",
          name: `Slab L${f} ${i}-${j}`,
          levelId: `L${f}`,
          params: {
            polygon: [
              [offsetX + i * roomW, offsetY + j * roomD],
              [offsetX + (i + 1) * roomW, offsetY + j * roomD],
              [offsetX + (i + 1) * roomW, offsetY + (j + 1) * roomD],
              [offsetX + i * roomW, offsetY + (j + 1) * roomD],
            ],
            height: 0.2,
            thickness: 0.2,
            elevation: z - 0.2,
          },
        });
      }
    }

    // Walls along vertical grid lines (X const), with doors / windows
    for (let i = 0; i <= colsX; i++) {
      for (let j = 0; j < colsY; j++) {
        const x0 = offsetX + i * roomW, y0 = offsetY + j * roomD;
        const wid = id("wall");
        const exterior = i === 0 || i === colsX;
        elements.push({
          id: wid,
          type: "wall",
          name: `Wall V${i} L${f} ${j}`,
          levelId: `L${f}`,
          params: { start: [x0, y0], end: [x0, y0 + roomD], height: WALL_H, thickness: WALL_T, elevation: z },
        });
        if (exterior && j % 2 === 0) {
          elements.push({
            id: id("win"),
            type: "window",
            name: `Window L${f} V${i}-${j}`,
            hostId: wid,
            params: { width: 1.2, height: 1.4, thickness: WALL_T, elevation: z, offsetAlongHost: roomD / 2, sillHeight: 0.9 },
          });
        } else if (!exterior && j % 3 === 1) {
          elements.push({
            id: id("door"),
            type: "door",
            name: `Door L${f} V${i}-${j}`,
            hostId: wid,
            params: { width: 0.9, height: 2.1, thickness: WALL_T, elevation: z, offsetAlongHost: roomD / 2, sillHeight: 0 },
          });
        }
      }
    }
    // Walls along horizontal grid lines (Y const)
    for (let j = 0; j <= colsY; j++) {
      for (let i = 0; i < colsX; i++) {
        const x0 = offsetX + i * roomW, y0 = offsetY + j * roomD;
        const wid = id("wall");
        const exterior = j === 0 || j === colsY;
        elements.push({
          id: wid,
          type: "wall",
          name: `Wall H${j} L${f} ${i}`,
          levelId: `L${f}`,
          params: { start: [x0, y0], end: [x0 + roomW, y0], height: WALL_H, thickness: WALL_T, elevation: z },
        });
        if (exterior && i % 2 === 1) {
          elements.push({
            id: id("win"),
            type: "window",
            name: `Window L${f} H${j}-${i}`,
            hostId: wid,
            params: { width: 1.4, height: 1.4, thickness: WALL_T, elevation: z, offsetAlongHost: roomW / 2, sillHeight: 0.9 },
          });
        } else if (!exterior && i % 4 === 2) {
          elements.push({
            id: id("door"),
            type: "door",
            name: `Door L${f} H${j}-${i}`,
            hostId: wid,
            params: { width: 0.9, height: 2.1, thickness: WALL_T, elevation: z, offsetAlongHost: roomW / 2, sillHeight: 0 },
          });
        }
      }
    }

    // Columns at grid intersections
    for (let i = 0; i <= colsX; i++) {
      for (let j = 0; j <= colsY; j++) {
        if ((i === 0 || i === colsX) && (j === 0 || j === colsY) && f > 0) continue;
        elements.push({
          id: id("col"),
          type: "column",
          name: `Column L${f} ${i}-${j}`,
          levelId: `L${f}`,
          params: { point: [offsetX + i * roomW, offsetY + j * roomD], depth: 0.35, thickness: 0.35, height: FLOOR_H, elevation: z },
        });
      }
    }

    // Beams along interior vertical grid lines at ceiling height
    for (let i = 1; i < colsX; i++) {
      for (let j = 0; j < colsY; j++) {
        elements.push({
          id: id("beam"),
          type: "beam",
          name: `Beam L${f} V${i}-${j}`,
          levelId: `L${f}`,
          params: {
            start: [offsetX + i * roomW, offsetY + j * roomD],
            end: [offsetX + i * roomW, offsetY + (j + 1) * roomD],
            height: 0.5, thickness: 0.25, elevation: z + FLOOR_H - 0.5,
          },
        });
      }
    }
  }

  return { elements, levels };
}

const fixtures = {
  small: building({ name: "s", floors: 1, colsX: 3, colsY: 2 }),
  medium: building({ name: "m", floors: 3, colsX: 5, colsY: 4 }),
  large: building({ name: "l", floors: 8, colsX: 8, colsY: 5 }),
  "fed-a": building({ name: "fa", floors: 3, colsX: 4, colsY: 3, offsetX: 0, offsetY: 0 }),
  "fed-b": building({ name: "fb", floors: 3, colsX: 4, colsY: 3, offsetX: 80, offsetY: 0 }),
  "fed-c": building({ name: "fc", floors: 3, colsX: 4, colsY: 3, offsetX: 0, offsetY: 80 }),
  "fed-d": building({ name: "fd", floors: 3, colsX: 4, colsY: 3, offsetX: 80, offsetY: 80 }),
};

const manifest = { generated: TIMESTAMP, schema: "IFC4", fixtures: {} };

for (const [key, { elements, levels }] of Object.entries(fixtures)) {
  const res = exportAuthoredToIfc(elements, {
    schema: "IFC4",
    levels,
    projectName: `OBS perf fixture ${key}`,
    timestamp: TIMESTAMP,
  });
  const file = path.join(outDir, `${key}.ifc`);
  writeFileSync(file, res.text, "utf8");
  manifest.fixtures[key] = {
    file: `fixtures/${key}.ifc`,
    bytes: Buffer.byteLength(res.text, "utf8"),
    elements: res.stats.elements,
    openings: res.stats.openings,
    storeys: res.stats.storeys,
    byClass: res.stats.byClass,
  };
  console.log(`[fixtures] ${key}.ifc  ${(manifest.fixtures[key].bytes / 1024).toFixed(1)} KB  elements=${res.stats.elements}`);
}

// SHA-256 checksums for budget gating (scripts/budget.json interface)
const { createHash } = await import("node:crypto");
for (const key of Object.keys(fixtures)) {
  const bytes = await import("node:fs").then((m) => m.readFileSync(path.join(outDir, `${key}.ifc`)));
  manifest.fixtures[key].sha256 = createHash("sha256").update(bytes).digest("hex");
}
const largeRef = path.join(outDir, "large-reference.ifc");
writeFileSync(largeRef, readIfc("large"), "utf8");
writeFileSync(
  path.join(outDir, "large-reference.ifc.checksum"),
  `${manifest.fixtures.large.sha256}  large-reference.ifc\n`,
  "utf8",
);

function readIfc(key) {
  // re-read from disk to avoid holding all texts in memory twice
  const { readFileSync } = require("node:fs");
  return readFileSync(path.join(outDir, `${key}.ifc`), "utf8");
}

writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
console.log("[fixtures] manifest written:", path.join(outDir, "manifest.json"));
if (!existsSync(largeRef)) process.exit(1);
