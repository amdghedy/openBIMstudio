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
  "test:architecture-map", "test:bim-gaps", "test:mep", "test:kb-bim-csd", "test:kb-bim-rules", "test:mep-plumbing", "test:mep-sizing-methods", "test:mep-equipment", "test:mep-network", "test:mep-hvac-loads", "test:stacked-wall", "test:constraint-autosolve", "test:mep-lighting", "test:mep-hosted-elements", "test:mep-demand-factors", "test:vertical-openings", "test:parametric-wiring", "test:join-advanced", "test:stack-heal", "test:curtain-grid-props", "test:constraint-persistence", "test:sloped-floor-authoring", "test:mep-flow-assignment", "test:mep-panel-wire", "test:mep-drainage", "test:mep-distribution", "test:mep-convert", "test:mep-fire", "test:mep-electrical-calc", "test:mep-insulation", "test:mep-run-tools", "test:mep-electrical", "test:mep-connectors", "test:mep-family-connectors", "test:family-connector-definitions", "test:family-connector-preview", "test:family-connector-orientation", "test:mep-lifecycle", "test:hip", "test:hatch", "test:stairs", "test:rebar",
  "test:v40", "test:collab", "test:p1-gaps", "test:view-crop", "test:selection-box", "test:selection-snapping", "test:history", "test:context-menu", "test:modify-registry",
  "test:dwg-isolation", "test:dwg-worker-lifecycle", "test:native-bim", "test:cad-link",
  "test:walk", "test:elbow", "test:props", "test:fitting-outline", "test:slope",
  "test:cad-viewer", "test:cad-context-menu", "test:cad-dimension-tools", "test:cad-dimension-system", "test:smart-perp", "test:cad-ribbon-layout", "test:cad-native-engine", "test:cad-save", "test:cad-dwg-export", "test:cad-styles", "test:cad-ribbon-collapse", "test:plan-commands", "test:cad-dwg-roundtrip", "test:cad-layout-save", "test:cad-hatch-save", "test:wall-reveal-cutter", "test:clash-review-dock", "test:door-window-place", "test:cad-clipboard", "test:cad-ray-xline", "test:cad-tools", "test:ocs", "test:dxf-features", "test:dwg-features", "test:dwg-convert-limits", "test:cad-acad-engine",
  "test:north", "test:nav-math", "test:controls-target", "test:cursor-zoom", "test:viewcube-pole", "test:ai-modeling",
  "test:native-twin-resize", "test:twin-dimensions", "test:twin-export", "test:mtext", "test:level-constraints", "test:mep-stretch", "test:linear-follow", "test:point-cloud", "test:ui-honesty", "test:wall-sweep-ifc", "test:wall-detect", "test:shortcut-keys", "test:shortcut-sequences", "test:magnet", "test:up-axis", "test:nwc-bridge", "test:section-handle-filter", "test:dimension-edit", "test:schedule-4d", "test:schedule-4d-ui", "test:schedule-import", "test:gis", "test:solids", "test:solid-kernel-weld", "test:solid-bvh", "test:csg-spatial-index", "test:seed-families", "test:standards-json-pack", "test:icu-lite", "test:family-sketch", "test:orbit-frame", "test:view-to-cad", "test:model-to-dxf3d", "test:export-cad-dwg", "test:pdf-to-dwg", "test:rtl-css", "test:region-format", "test:bulk-native-twin", "test:native-ifc-versions", "test:uniqueness", "test:boot-health", "test:ai-privacy", "test:anthropic", "test:ai-presets", "test:cad-insert", "test:ui-reachability", "test:rvt", "test:clash-engine", "test:clash-selection", "test:constraints", "test:structural", "test:structural-3d", "test:no-cdn", "test:parametric-closure",
  "test:mep-pressure", "test:work-planes", "test:adaptive", "test:adaptive-native", "test:project-crypto", "test:secret-crypto",
  "test:server-security", "test:safe-expr", "test:mep-connectivity", "test:boundary-edit",
  "test:project-file", "test:project-journal", "test:plan-tags", "test:filled-regions", "test:plan-poche", "test:section-elevation-doc", "test:section-authored-clip",
  "test:schedule-sheet", "test:schedule-totals", "test:dim-geometry", "test:auto-dim", "test:sheet-furniture",
  "test:section-plane", "test:snap-points", "test:plan-draw", "test:view-lock",
  "test:wheel-zoom", "test:section-box", "test:section-box-arrows", "test:cad-tables-fidelity",
  "test:cad-ui-wiring", "test:cad-ocs-absorb", "test:cad-native-annotation", "test:cad-tabs-compatibility",
  "test:v68-core", "test:v68-solids", "test:v68-interaction", "test:v68-acceptance",
  "test:v69", "test:v70", "test:v71", "test:v72",
  "test:v73-just", "test:v73-mag", "test:v73-panels", "test:v73-rel",
  "test:pdf-underlay-loader", "test:dep-safety", "test:webifc-abi", "test:ribbon-collapse", "test:server-hardening", "test:plugins", "test:feature-registry", "test:escape-all",
  "test:welcome-screen", "test:cad-ai", "test:walk-key-guard", "test:auth-ux", "test:modeling-depth",
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
