#!/usr/bin/env node
/**
 * Compiles the revit-gaps modules with the project's own TypeScript and runs
 * the Node tests. Works on Windows, macOS and Linux:
 *
 *   node tests/run-tests.mjs
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = mkdtempSync(path.join(tmpdir(), "obs-revit-gaps-"));
const tsc = spawnSync(
  "npx",
  ["tsc", "--ignoreConfig", "--rootDir", "src", "--outDir", out, "--module", "nodenext", "--moduleResolution", "nodenext",
    "--target", "ES2022", "--skipLibCheck", "--noCheck",
    "src/modules/revit-gaps/ifc-guid.ts", "src/modules/revit-gaps/room-detect.ts",
    "src/modules/revit-gaps/authored-ifc.ts", "src/modules/revit-gaps/visibility-bridge.ts", "src/modules/revit-gaps/m2-geometry.ts", "src/modules/revit-gaps/m2-register.ts", "src/modules/revit-gaps/m2-tools.ts", "src/modules/revit-gaps/m3-solids.ts", "src/modules/revit-gaps/m3-project.ts", "src/modules/revit-gaps/m3-plan.ts", "src/modules/revit-gaps/m3-register.ts", "src/modules/revit-gaps/m3-pdf-fill.ts", "src/modules/views/store.ts"],
  { cwd: root, stdio: "inherit", shell: true },
);
if (tsc.status !== 0) { console.error("tsc failed"); process.exit(1); }

let failed = false;
for (const f of readdirSync(path.join(root, "tests")).filter((n) => n.endsWith(".test.cjs"))) {
  console.log("== tests/" + f);
  const r = spawnSync(process.execPath, [path.join(root, "tests", f)], {
    stdio: "inherit",
    env: { ...process.env, OUT_DIR: path.join(out, "modules", "revit-gaps") },
  });
  if (r.status !== 0) failed = true;
}
console.log(failed ? "\nSOME TESTS FAILED" : "\nALL TESTS PASSED");
process.exit(failed ? 1 : 0);
