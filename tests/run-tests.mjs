#!/usr/bin/env node
/**
 * Compiles the bim-gaps modules with the project's own TypeScript and runs
 * the Node tests. Works on Windows, macOS and Linux:
 *
 *   node tests/run-tests.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(path.join(tmpdir(), "obs-bim-gaps-"));

// Force Node to treat the compiled .js files as CommonJS
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

let failed = false;
for (const f of readdirSync(path.join(root, "tests")).filter((n) => n.endsWith(".test.cjs"))) {
  console.log("== tests/" + f);
  const r = spawnSync(process.execPath, [path.join(root, "tests", f)], {
    stdio: "inherit",
    env: { ...process.env, OUT_DIR: path.join(out, "modules", "bim-gaps") },
  });
  if (r.status !== 0) failed = true;
}
console.log(failed ? "\nSOME TESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);