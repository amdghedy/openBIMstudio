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

"test:architecture-map", "test:cad-constraint-solver", "test:cad-constraint-bridge", "test:cad-constraint-store", "test:bim-gaps", "test:critical-workflow-pack", "test:critical-workflow-packs-34567", "test:critical-workflow-pack-8", "test:project-auto-reopen", "test:qto-property-filters", "test:ifc-interop-report", "test:ifc-per-entity-report", "test:ifc-per-entity-roundtrip", "test:ifc-per-entity-corpus", "test:step-preflight", "test:import-timeout", "test:ifc-link-limits", "test:file-guard", "test:file-import-boundaries", "test:file-import-hostile", "test:camera-fitall-bounded", "test:offline-icons", "test:catalog-type-ids", "test:ifc-type-objects", "test:dxf-malformed", "test:ifc-corpus-manifest", "test:property-invariants", "test:property", "test:property-palette-type-selector", "test:tool-catalog-gate", "test:cad-ribbon-asi", "test:cad-ribbon-wiring", "test:cad-2d-extras", "test:native-curves", "test:native-twin-ifc-entities", "test:perf-budget-gate", "test:safe-load", "test:safe-load-audit", "test:zod-boundaries", "test:qto-classification-rollup", "test:bcf21", "test:open-audit", "test:publish-web", "test:model-timeline", "test:clash-scenarios", "test:mep", "test:kb-bim-csd", "test:kb-bim-rules", "test:mep-plumbing", "test:mep-sizing-methods", "test:mep-equipment", "test:mep-network", "test:mep-hvac-loads", "test:stacked-wall", "test:constraint-autosolve", "test:mep-lighting", "test:mep-hosted-elements", "test:mep-demand-factors", "test:vertical-openings", "test:parametric-wiring", "test:join-advanced", "test:stack-heal", "test:curtain-grid-props", "test:constraint-persistence", "test:sloped-floor-authoring", "test:mep-flow-assignment", "test:mep-panel-wire", "test:mep-drainage", "test:mep-distribution", "test:mep-convert", "test:mep-fire", "test:mep-electrical-calc", "test:mep-insulation", "test:mep-run-tools", "test:mep-electrical", "test:mep-connectors", "test:mep-family-connectors", "test:family-connector-definitions", "test:family-connector-preview", "test:family-connector-orientation", "test:mep-lifecycle", "test:hip", "test:hatch", "test:stairs", "test:rebar", "test:cad-index-append", "test:cad-engine-native-blocks", "test:cad-block-edit", "test:cad-block-refs", "test:cad-imperial", "test:units-imperial-roundtrip", "test:cad-xref-engine", "test:dxf-complete",
  "test:v40", "test:collab", "test:p1-gaps", "test:view-crop", "test:selection-box", "test:selection-semantics", "test:selection-snapping", "test:history", "test:context-menu", "test:modify-registry", "test:central-model", "test:central-sync", "test:central-binding", "test:selection-generations",
  "test:dwg-isolation", "test:solid-reader-isolation", "test:dwg-worker-lifecycle", "test:native-bim", "test:cad-link",
  "test:walk", "test:elbow", "test:props", "test:fitting-outline", "test:slope",

  "test:cad-viewer", "test:cad-context-menu", "test:cad-dimension-tools", "test:cad-dimension-system", "test:cad-drafting-completions", "test:cad-drafting-aids-2d2", "test:smart-perp", "test:cad-ribbon-layout", "test:cad-native-engine", "test:cad-layer-visibility", "test:cad-save", "test:cad-visibility-persistence", "test:cad-dwg-export", "test:cad-styles", "test:cad-ribbon-collapse", "test:plan-commands", "test:revit-g3-tab-cycle", "test:cad-dwg-roundtrip", "test:cad-layout-save", "test:cad-layouts", "test:cad-hatch-save", "test:wall-reveal-cutter", "test:clash-review-dock", "test:door-window-place", "test:cad-clipboard", "test:cad-ray-xline", "test:cad-tools", "test:ocs", "test:dxf-features", "test:dxf-independent-validation", "test:dwg-features", "test:dwg-convert-limits", "test:cad-acad-engine",
  "test:north", "test:nav-math", "test:controls-target", "test:cursor-zoom", "test:viewcube-pole", "test:ai-modeling", "test:nl-model", "test:nl-query-authored",
  "test:native-twin-resize", "test:twin-dimensions", "test:twin-export", "test:mtext", "test:level-constraints", "test:mep-stretch", "test:linear-follow", "test:point-cloud", "test:ui-honesty", "test:wall-sweep-ifc", "test:wall-detect", "test:shortcut-keys", "test:shortcut-sequences", "test:revit-g5-double-click", "test:revit-g8-keyboard", "test:magnet", "test:up-axis", "test:nwc-bridge", "test:section-handle-filter", "test:dimension-edit", "test:schedule-4d", "test:schedule-4d-ui", "test:schedule-import", "test:gis", "test:gis-crs", "test:ifc-georef", "test:paper-sizes", "test:solids", "test:solid-kernel-weld", "test:validation-gate", "test:validator-holes", "test:boolean-postcondition", "test:solid-bvh", "test:csg-spatial-index", "test:perf-harness", "test:seed-families", "test:seed-catalog-dedup", "test:family-gallery", "test:builtin-family-data", "test:standards-json-pack", "test:icu-lite", "test:block-library-store", "test:i18n-dropdown", "test:icu-catalog", "test:i18n-audit", "test:region-dir", "test:family-sketch", "test:snap-freshness", "test:parameter-scope", "test:formula-scientific-notation", "test:families-in-project", "test:orbit-frame", "test:view-to-cad", "test:model-to-dxf3d", "test:hidden-line", "test:no-gpl-shipped", "test:reference-tracking", "test:session-state", "test:gradient-hatch", "test:acad-byblock", "test:acad-engine-identity", "test:wasm-staleness-guard", "test:acad-solid-entities", "test:stroke-font", "test:acad-extra-entities", "test:export-cad-dwg", "test:live-ifc-link", "test:pdf-to-dwg", "test:rtl-css", "test:region-format", "test:bulk-native-twin", "test:native-ifc-versions", "test:undo-transaction", "test:uniqueness", "test:boot-health", "test:boot-architecture", "test:ai-privacy", "test:anthropic", "test:ai-presets", "test:cad-insert", "test:ui-reachability", "test:rvt", "test:rfa-import", "test:clash-engine", "test:clash-selection", "test:constraints", "test:structural", "test:structural-3d", "test:no-cdn", "test:parametric-closure", "test:parametric-loft", "test:parametric-nested-families", "test:parametric-voids-sweeps-lofts", "test:sketch-arcs-constraints", "test:catalog-shared-parameters", "test:shared-parameters", "test:parametric-type-propagation", "test:parametric-manual-sync", "test:parametric-type-swap", "test:parametric-rectangular-family", "test:family-creator", "test:parametric-family-hosting", "test:parametric-revolve", "test:mass-to-elements", "test:family-migration", "test:family-store-bridge",
  "test:mep-pressure", "test:work-planes", "test:adaptive", "test:adaptive-native", "test:project-crypto", "test:secret-crypto", "test:element-store", "test:cad-store-adapter",

  "test:server-security", "test:server-backup", "test:server-backup-on-load", "test:safe-expr", "test:formula-engine", "test:dimensional-analysis", "test:mep-connectivity", "test:boundary-edit",
  "test:grip-axis-lock", "test:universal-3d-grips", "test:grips-engine",
  "test:project-file", "test:project-journal", "test:core-journal", "test:journal-replay", "test:checkpoint-quarantine", "test:project-persistence", "test:plan-tags", "test:filled-regions", "test:plan-poche", "test:section-elevation-doc", "test:section-authored-clip",
  "test:schedule-sheet", "test:schedule-totals", "test:schedule-classification", "test:dim-geometry", "test:auto-dim", "test:annotate-distinctions", "test:sheet-furniture", "test:documentation-2d", "test:view-templates", "test:revisions",
  "test:section-plane", "test:snap-points", "test:plan-draw", "test:plan-snap-override-g14", "test:plan-temp-dims", "test:plan-dock-live-sync-g12", "test:view-lock",
  "test:wheel-zoom", "test:section-box", "test:section-box-arrows", "test:cad-tables-fidelity",
  "test:cad-ui-wiring", "test:cad-ocs-absorb", "test:cad-native-annotation", "test:cad-tabs-compatibility",
  "test:v68-core", "test:v68-solids", "test:v68-interaction", "test:v68-acceptance",
  "test:v69", "test:v70", "test:tolerance-policy", "test:v71", "test:v72",
  "test:v73-just", "test:v73-mag", "test:v73-panels", "test:v73-rel",


  "test:ifc-semantics", "test:native-ifc-entities", "test:native-ifc-independent-validation", "test:ifc-corpus-manifest", "test:malformed-generators", "test:ifc-exchange", "test:fuzz-ifc", "test:fuzz-dxf", "test:fuzz-bcf", "test:fuzz-capture", "test:fuzz-kind", "test:pdf-underlay-loader", "test:dep-safety", "test:webifc-abi", "test:ribbon-collapse", "test:project-browser-g11", "test:project-browser-menu-g11", "test:ribbon-tab-order", "test:ribbon-draw-order", "test:ribbon-a12", "test:modify-tab-completion", "test:server-hardening", "test:share-links", "test:service-worker", "test:plugins", "test:feature-registry", "test:review-links", "test:escape-all", "test:multi-move-copy", "test:layer-lock-enforcement", "test:dimension-writer", "test:grid-snap", "test:fillet-chamfer", "test:cad-snap-override", "test:cad-snap-a15", "test:cad-layer-manager-a16", "test:cad-annotation-a10", "test:cad-polyline-a7", "test:cad-selection-a11", "test:cad-selection-a18", "test:autocad-parity", "test:dead-code-a14", "test:cad-viewport-a8", "test:cad-dwg-a19", "test:revit-g9-view-controls",
  "test:welcome-screen", "test:cad-ai", "test:walk-key-guard", "test:auth-ux", "test:user-state", "test:local-scope", "test:secure-scope", "test:modeling-depth",
  // X-12: previously unwired suites, each verified green standalone.
  // Deliberately NOT wired: the 8 OUT_DIR tests (geometry, ifc, m2-geometry,
  // m2-tools, m3-plan, m3-register, m3-views, visibility) — they require a
  // pre-compiled OUT_DIR no script sets up; and test:native-twin-linear,
  // a duplicate subset of test:native-twin (same file).
  "test:browser-recovery", "test:cad-dimension", "test:classification", "test:critical-workflow-pack-2", "test:digital-twin-capabilities", "test:family-creator-elevation", "test:family-creator-outline", "test:linkedin-publishing-config", "test:mep-calculation-basis", "test:mep-connectivity-index", "test:mep-ifc-reconstruction", "test:mep-protection-coordination", "test:mep-system-tree", "test:mesh-plan-deform", "test:native-twin-preserve-geometry", "test:param-geometry-sync", "test:qto-rules", "test:source-archive", "test:workflow-pack-11", "test:workflow-pack-12", "test:workflow-pack-13-14",
  "test:ai-agent", "test:ai-embeddings", "test:ai-evidence", "test:cad-block-edit-a9", "test:cad-dim-tools", "test:cad-draw-order", "test:cad-dynblock-a9", "test:cad-dynvalues-xdata", "test:cad-layout-plot-a20", "test:cad-space-add-a9", "test:cad-workspace", "test:critical-workflow-pack-10", "test:hatch-engine", "test:libredwg-toolkit", "test:mep-code-reference-checks", "test:mep-stored-connectors", "test:native-twin", "test:openings-chain", "test:pdf-svg-fill", "test:pdf-vector", "test:pick-arbiter", "test:worker-audit-x3",
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
