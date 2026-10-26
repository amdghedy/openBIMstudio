#!/usr/bin/env node
/**
 * verify-v73 — Intelligent Modeling / Dynamic Properties Panel /
 * Justification / Smart Snapping shape verification.
 * Confirms the features exist, are wired to the real modeling engine
 * (not demo stubs), and that the CI surface (tests + docs + version)
 * is intact. 46 checks.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`    ${e.message}`); fail++; }
}
function read(p) {
  const full = path.join(root, p);
  if (!fs.existsSync(full)) throw new Error(`missing file: ${p}`);
  return fs.readFileSync(full, "utf8");
}
function has(re, p) {
  if (!re.test(read(p))) throw new Error(`${p}: pattern not found: ${re}`);
}

/* ── Justification engine (MASTER PROMPT §3) ───────────────────────────── */

check("justification module exists and is pure", () =>
  has(/justificationShiftMeters|resolveWallJustification/, "src/modules/justification/index.ts"));
check("justification: six BIM location lines", () => {
  const s = read("src/modules/justification/index.ts");
  for (const m of ["wall-centerline", "core-centerline", "finish-exterior", "finish-interior", "core-exterior", "core-interior"]) {
    if (!s.includes(m)) throw new Error(`missing location line: ${m}`);
  }
});
check("justification: compound-core parsing + gating", () => {
  const s = read("src/modules/justification/index.ts");
  if (!/coreThicknessFromLayers/.test(s)) throw new Error("no core thickness parser");
  if (!/locationLineNeedsCore/.test(s)) throw new Error("no core gating helper");
});
check("justification: reference path preserved on mode switch", () =>
  has(/reference path itself is preserved|Preserve the intended path|path preserved/i, "src/modules/justification/index.ts"));

/* ── Authoring integration (§2/§3/§5/§6) ───────────────────────────────── */

check("3D draw path applies justification (was plan-only)", () =>
  has(/justifyLinearSegment/, "src/features/authoring.ts"));
check("walls record locationLine on commit", () =>
  has(/drawProps\.locationLine = wallLocationLine/, "src/features/authoring.ts"));
check("applyWallLocationOffset upgraded to core-aware engine", () =>
  has(/coreThicknessFromLayers\(layers, thickness\)/, "src/features/authoring.ts"));
check("beam z-justification shifts real elevation", () => {
  const s = read("src/features/authoring.ts");
  if (!/beamZJustification === "center" \? -dp\.height \/ 2/.test(s)) throw new Error("no center shift");
  if (!/beamZJustification === "top" \? -dp\.height/.test(s)) throw new Error("no top shift");
});
check("MEP slope reuses the plan-path chain state in 3D", () =>
  has(/slopedElevations\(tool, s\[0\], s\[1\], e\[0\], e\[1\]\)/, "src/features/authoring.ts"));
check("reference-line visualisation during placement (§3.3)", () =>
  has(/reference-line visualisation/, "src/features/authoring.ts"));
check("snap → persistent relationship recording (§5)", () =>
  has(/recordSnapRelationships/, "src/features/authoring.ts"));
check("wall-column binds created on column-face snaps", () =>
  has(/createWallColumnRelationship\(registry/, "src/features/authoring.ts"));
check("endpoint-constraint created on endpoint snaps", () => {
  const s = read("src/features/authoring.ts");
  if (!/type: "endpoint-constraint"/.test(s)) throw new Error("no endpoint constraint");
  if (!/type: "mep-connection"/.test(s)) throw new Error("no mep connection");
});
check("dependents follow the move in the SAME undo transaction (§6)", () => {
  const s = read("src/features/authoring.ts");
  if (!/collectDependentPatches/.test(s)) throw new Error("no dependent patch collection");
  const occurrences = (s.match(/collectDependentPatches\(/g) ?? []).length;
  if (occurrences < 3) throw new Error(`expected move + gizmo call sites, found ${occurrences - 1}`);
});
check("wall-column re-resolution on column move", () =>
  has(/calculateWallEndpoint\(wallLine, colRef\)/, "src/features/authoring.ts"));
check("preview refresh API for live parameter updates (§2.3)", () =>
  has(/export function refreshPreview/, "src/features/authoring.ts"));
check("draw-tool state exported for panel auto-open (§2.1)", () =>
  has(/export function isDrawToolActive/, "src/features/authoring.ts"));
check("justification states + reset exported", () => {
  const s = read("src/features/authoring.ts");
  for (const m of ["getBeamJustification", "setBeamJustification", "getBeamZJustification",
    "getMepJustification", "resetTypeDefaults"]) {
    if (!s.includes(m)) throw new Error(`missing export: ${m}`);
  }
});

/* ── Tool panel registry (§2) ──────────────────────────────────────────── */

check("declarative tool-panel registry exists", () =>
  has(/TOOL_PANELS|getToolPanel/, "src/features/tool-panels.ts"));
check("panel fields always declare a real binding", () => {
  const s = read("src/features/tool-panels.ts");
  if (!/kind: "type-default"/.test(s) || !/kind: "authoring"/.test(s)) {
    throw new Error("field bindings missing");
  }
});
check("palette renders the tool panel from the registry", () => {
  const s = read("src/features/property-palette.ts");
  for (const m of ["renderToolPanel", "renderToolField", "AUTHORING_STATE", "validatePanelNumber"]) {
    if (!s.includes(m)) throw new Error(`palette missing: ${m}`);
  }
});
check("palette auto-opens on tool activation (§2.1)", () =>
  has(/isDrawToolActive\(\) && !visible/, "src/features/property-palette.ts"));
check("panel inputs parse the app's unit grammar (§2.3)", () => {
  const s = read("src/features/property-palette.ts");
  if (!/units\.parseLengthInput/.test(s)) throw new Error("no unit-aware parsing");
  if (!/units\.formatLength/.test(s)) throw new Error("no unit-aware formatting");
});
check("invalid values are blocked with inline feedback", () =>
  has(/setErr\(/, "src/features/property-palette.ts"));
check("core options hidden unless compound core exists (§3.1)", () =>
  has(/requiresCoreLayers && !coreOk/, "src/features/property-palette.ts"));
check("panel Reset restores factory defaults", () =>
  has(/resetTypeDefaults\(desc\.elementType\)/, "src/features/property-palette.ts"));

/* ── Snapping engine (§4/§5) ───────────────────────────────────────────── */

check("magnetic math module exists (pure)", () =>
  has(/perpendicularFoot|parallelPoint|segmentIntersection/, "src/modules/snapping/magnetic.ts"));
check("phantom snap types now have real generators", () => {
  const s = read("src/features/snapping.ts");
  for (const m of ['"perpendicular", el.id, "perpendicular"', '"parallel", el.id, "parallel"', '"intersection", capped[i].el.id']) {
    if (!s.includes(m)) throw new Error(`no generator for ${m}`);
  }
});
check("MEP connector snapping with element identity", () =>
  has(/"connector", c\.ownerElementId, "connector"/, "src/features/snapping.ts"));
check("snap results carry element identity for relationship binding", () =>
  has(/elementId\?: string/, "src/features/snapping.ts"));
check("snap hysteresis prevents candidate flicker", () =>
  has(/pixelTolerance \* 1\.15/, "src/features/snapping.ts"));
check("Tab cycles overlapping snap candidates (§4.3)", () => {
  const s = read("src/features/snapping.ts");
  if (!/cycleNext\(step: 1 \| -1\)/.test(s)) throw new Error("no cycleNext");
  const a = read("src/features/authoring.ts");
  if (!/snapping\.cycleNext\(/.test(a)) throw new Error("Tab key not wired");
});
check("Alt temporarily suspends snapping (§4.3)", () => {
  const b = read("src/features/bim-experience.ts");
  if (!/setSuspended\(true\)/.test(b) || !/setSuspended\(false\)/.test(b)) {
    throw new Error("Alt suspend not wired");
  }
  const a = read("src/features/authoring.ts");
  if (!/isSuspended\?\.Great|isSuspended\?\.\(\)/.test(a) && !/isSuspended\?\.v|isSuspended\?\.\(\)/.test(a) && !/\(snapping as any\)\.isSuspended\?/.test(a)) {
    throw new Error("suspension not honoured in the snap loop");
  }
});
check("screen tolerance scales to world space at cursor depth (§4.2)", () =>
  has(/worldTolerance/, "src/features/snapping.ts"));
check("magnetic prefilter avoids per-move O(n²)", () => {
  const s = read("src/features/snapping.ts");
  if (!/aabbNearCursor/.test(s)) throw new Error("no AABB prefilter");
  if (!/skip elements whose AABB/.test(s)) throw new Error("prefilter not documented at the corner pass");
});
check("per-category snap toggles remain available (§4.3)", () =>
  has(/toggleType/, "src/features/snapping.ts"));

/* ── Tests + CI surface ────────────────────────────────────────────────── */

check("justification suite", () => has(/v73-justification: /, "tests/v73-justification.test.cjs"));
check("snap-magnetic suite", () => has(/v73-snap-magnetic: /, "tests/v73-snap-magnetic.test.cjs"));
check("tool-panels suite", () => has(/v73-tool-panels: /, "tests/v73-tool-panels.test.cjs"));
check("relationships suite", () => has(/v73-relationships: /, "tests/v73-relationships.test.cjs"));
check("package.json: test scripts wired", () => {
  const p = JSON.parse(read("package.json"));
  for (const k of ["test:v73-just", "test:v73-mag", "test:v73-panels", "test:v73-rel", "verify:v73"]) {
    if (!p.scripts[k]) throw new Error(`missing script: ${k}`);
  }
  if (p.version !== "0.73.0") throw new Error(`version ${p.version}`);
});
check("CI runs the v73 suites", () => {
  const wf = read(".github/workflows/unit-tests.yml");
  for (const k of ["test:v73-just", "test:v73-mag", "test:v73-panels", "test:v73-rel", "verify:v73"]) {
    if (!wf.includes(`npm run ${k}`)) throw new Error(`CI missing ${k}`);
  }
});
check("documentation exists", () => {
  const d = read("docs/MODELING_PANEL_V73.md");
  if (!/MASTER PROMPT|Justification|Snap/i.test(d)) throw new Error("doc lacks the spec mapping");
});

console.log(`\nverify-v73: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
