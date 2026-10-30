#!/usr/bin/env node
/**
 * Compiles the bim-gaps modules with the project's own TypeScript and runs
 * only the tests that consume that compiled OUT_DIR.
 *
 * This runner must not discover every *.test.cjs in the repository: doing so
 * accidentally executes unrelated suites (DWG worker, dependency safety,
 * navigation, etc.) inside test:bim-gaps and makes that script fail for
 * reasons unrelated to the BIM-gaps modules.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(path.join(tmpdir(), "obs-bim-gaps-"));
writeFileSync(path.join(out, "package.json"), '{"type": "commonjs"}');

const tsc = spawnSync(
  "npx",
  ["tsc", "--rootDir", "src", "--outDir", out, "--module", "commonjs", "--moduleResolution", "node", "--target", "ES2022", "--skipLibCheck", "--noCheck",
    "src/modules/bim-gaps/ifc-guid.ts", "src/modules/bim-gaps/room-detect.ts",
    "src/modules/bim-gaps/authored-ifc.ts", "src/modules/bim-gaps/visibility-bridge.ts",
    "src/modules/bim-gaps/m2-geometry.ts", "src/modules/bim-gaps/m2-register.ts",
    "src/modules/bim-gaps/m2-tools.ts", "src/modules/bim-gaps/m3-solids.ts",
    "src/modules/bim-gaps/m3-project.ts", "src/modules/bim-gaps/m3-plan.ts",
    "src/modules/bim-gaps/m3-register.ts", "src/modules/bim-gaps/m3-pdf-fill.ts",
    "src/modules/views/store.ts", "src/core/context.ts", "src/features/history.ts"],
  { cwd: root, stdio: "inherit", shell: true },
);
if (tsc.status !== 0) { console.error("tsc failed"); process.exit(1); }

const BIM_GAP_TESTS = [
  "geometry.test.cjs",
  "visibility.test.cjs",
  "ifc.test.cjs",
  "m2-geometry.test.cjs",
  "m2-tools.test.cjs",
  "m3-views.test.cjs",
  "m3-register.test.cjs",
];

let failed = false;
for (const name of BIM_GAP_TESTS) {
  const file = path.join(root, "tests", name);
  if (!readdirSync(path.join(root, "tests")).includes(name)) {
    console.error("Missing BIM-gaps test: " + name);
    failed = true;
    continue;
  }
  console.log("== tests/" + name);
  const r = spawnSync(process.execPath, [file], {
    stdio: "inherit",
    env: { ...process.env, OUT_DIR: path.join(out, "modules", "bim-gaps") },
  });
  if (r.status !== 0) failed = true;
}
console.log(failed ? "\nBIM-GAPS TESTS FAILED" : "\nBIM-GAPS TESTS PASSED");
process.exit(failed ? 1 : 0);
