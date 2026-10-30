#!/usr/bin/env node
/**
 * Run the CI unit-test battery as one process so GitHub Actions shows a
 * single step result instead of 70 separate red/green rows.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const scripts = [
  "test:bim-gaps", "test:mep", "test:mep-electrical", "test:mep-connectors", "test:mep-lifecycle", "test:hip", "test:hatch", "test:stairs", "test:rebar",
  "test:v40", "test:collab", "test:p1-gaps", "test:view-crop", "test:selection-box", "test:history",
  "test:dwg-isolation", "test:dwg-worker-lifecycle", "test:native-bim", "test:cad-link",
  "test:walk", "test:elbow", "test:props", "test:fitting-outline", "test:slope",
  "test:cad-viewer", "test:ocs", "test:dxf-features", "test:dwg-features",
  "test:north", "test:nav-math", "test:controls-target", "test:cursor-zoom",
  "test:native-twin-resize", "test:twin-dimensions", "test:twin-export", "test:mtext", "test:level-constraints", "test:bulk-native-twin", "test:ai-privacy", "test:constraints", "test:structural",
  "test:mep-pressure", "test:adaptive", "test:project-crypto", "test:secret-crypto",
  "test:server-security", "test:safe-expr", "test:mep-connectivity", "test:boundary-edit",
  "test:project-file", "test:plan-tags", "test:dim-geometry", "test:auto-dim",
  "test:section-plane", "test:snap-points", "test:plan-draw", "test:view-lock",
  "test:wheel-zoom", "test:section-box",
  "test:v68-core", "test:v68-solids", "test:v68-interaction", "test:v68-acceptance",
  "test:v69", "test:v70", "test:v71", "test:v72",
  "test:v73-just", "test:v73-mag", "test:v73-panels", "test:v73-rel",
  "test:dep-safety", "test:server-hardening", "test:plugins", "test:feature-registry",
  "verify:v70", "verify:v71", "verify:v72", "verify:v73", "verify:v68",
];

const failed = [];
const passed = [];
const skipped = [];

for (const name of scripts) {
  if (!pkg.scripts?.[name]) {
    skipped.push(name);
    console.log(`SKIP  ${name}`);
    continue;
  }
  process.stdout.write(`RUN   ${name} ... `);
  const r = spawnSync("npm", ["run", "-s", name], {
    cwd: root,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 20 * 1024 * 1024,
    shell: true,
  });
  if (r.status === 0) {
    passed.push(name);
    console.log("ok");
  } else {
    failed.push(name);
    console.log("FAIL");
    const out = `${r.stdout || ""}\n${r.stderr || ""}`.trim();
    if (out) console.log(out.slice(-4000));
    if (process.env.GITHUB_ACTIONS) {
      // Annotation: visible on the run page and through the check-runs API even when raw logs are restricted.
      const esc = (t) => t.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
      const fails = out.split("\n").filter((l) => /FAIL|Error|error TS|Cannot find|AssertionError/.test(l)).slice(0, 12).join("\n");
      console.log(`::error title=${name} failed::${esc((fails || out.slice(-1500)).slice(0, 3500))}`);
    }
  }
}

console.log("\n======== CI unit summary ========");
console.log(`passed:  ${passed.length}`);
console.log(`failed:  ${failed.length}`);
console.log(`skipped: ${skipped.length}`);
if (failed.length) {
  console.log("failed scripts:");
  for (const f of failed) console.log("  -", f);
  process.exit(1);
}
console.log("All CI unit scripts passed.");
