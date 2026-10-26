/**
 * tests/v73-tool-panels.test.cjs
 *
 * MASTER PROMPT §2 — dynamic modeling properties panel descriptors.
 * Guards the contract that every real draw tool exposes its own
 * parameter set, that unsupported parameters are never shown
 * (§2.2 "hide or disable unsupported parameters"), and that numeric
 * validation (§2.3) rejects non-finite / out-of-range values.
 *
 * Run: node tests/v73-tool-panels.test.cjs
 */

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

let pass = 0;
let fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); pass++; }
  catch (e) { console.error(`  FAIL ${name}`); console.error(`    ${e.message}`); fail++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// ── Compile ─────────────────────────────────────────────────────────────
const root = path.resolve(__dirname, "..");
const tmpOut = fs.mkdtempSync(path.join(os.tmpdir(), "obs-v73-panels-"));
fs.writeFileSync(path.join(tmpOut, "package.json"), '{"type": "commonjs"}');
execSync(
  "npx tsc --rootDir src --outDir " + JSON.stringify(tmpOut) +
  " --module commonjs --moduleResolution node --target ES2022 --skipLibCheck --noCheck" +
  " src/features/tool-panels.ts",
  { cwd: root, stdio: "inherit", shell: true },
);
const TP = require(path.join(tmpOut, "features/tool-panels.js"));

// ── Coverage: every actual draw tool has a panel (§2.1) ─────────────────
const DRAW_TOOLS = [
  "wall", "curtain-wall", "slab", "column", "beam", "brace", "truss",
  "footing", "strip", "mline", "duct", "pipe", "cable-tray", "conduit",
  "equipment", "door", "window", "grid", "level",
];

t("every draw tool exposes a tool panel", () => {
  for (const tool of DRAW_TOOLS) {
    const d = TP.getToolPanel(tool);
    assert(d, `missing panel for ${tool}`);
    assert(d.tool === tool);
    assert(d.elementType, `${tool} panel has no element type`);
    assert(Array.isArray(d.groups) && d.groups.length > 0, `${tool} panel has no groups`);
  }
});
t("unknown tools resolve to null (no invented UI)", () => {
  assert(TP.getToolPanel("does-not-exist") === null);
  assert(TP.getToolPanel(null) === null);
  assert(TP.getToolPanel(undefined) === null);
});

// ── §2.2 — only parameters the engine actually uses ─────────────────────
t("walls expose the six Revit-style location lines", () => {
  const wall = TP.getToolPanel("wall");
  const fields = wall.groups.flatMap((g) => g.fields);
  const loc = fields.filter((f) => f.bind && f.bind.kind === "authoring" && f.bind.stateKey === "wallLocationLine");
  assert(loc.length >= 1, "wall panel has no location-line control");
  const values = new Set(loc.flatMap((f) => (f.options ?? []).map((o) => o.value)));
  for (const v of ["wall-centerline", "core-centerline", "finish-exterior", "finish-interior", "core-exterior", "core-interior"]) {
    assert(values.has(v), `location line ${v} missing`);
  }
});
t("core-only controls are gated behind requiresCoreLayers", () => {
  const wall = TP.getToolPanel("wall");
  const gated = wall.groups.flatMap((g) => g.fields).filter((f) => f.requiresCoreLayers);
  assert(gated.length > 0, "wall panel has no core-gated control");
  for (const f of gated) {
    const opts = (f.options ?? []).map((o) => o.value);
    for (const v of opts) assert(v.startsWith("core"), `gated field exposes non-core option ${v}`);
  }
  // Other tools must not pretend to have core options.
  for (const tool of ["column", "slab", "duct", "door"]) {
    const d = TP.getToolPanel(tool);
    assert(d.groups.flatMap((g) => g.fields).every((f) => !f.requiresCoreLayers), `${tool} has core-gated fields`);
  }
});
t("beams expose horizontal + z justification", () => {
  const beam = TP.getToolPanel("beam");
  const keys = beam.groups.flatMap((g) => g.fields)
    .filter((f) => f.bind && f.bind.kind === "authoring")
    .map((f) => f.bind.stateKey);
  assert(keys.includes("beamJustification"), "no horizontal justification");
  assert(keys.includes("beamZJustification"), "no z justification");
});
t("MEP tools expose justification + slope, doors do not", () => {
  for (const tool of ["duct", "pipe", "cable-tray", "conduit"]) {
    const keys = TP.getToolPanel(tool).groups.flatMap((g) => g.fields)
      .filter((f) => f.bind && f.bind.kind === "authoring")
      .map((f) => f.bind.stateKey);
    assert(keys.includes("mepJustification"), `${tool} lacks MEP justification`);
    assert(keys.includes("drawSlope"), `${tool} lacks slope`);
  }
  const doorKeys = TP.getToolPanel("door").groups.flatMap((g) => g.fields)
    .filter((f) => f.bind && f.bind.kind === "authoring")
    .map((f) => f.bind.stateKey);
  assert(!doorKeys.includes("drawSlope") && !doorKeys.includes("mepJustification"),
    "door panel shows MEP-only controls");
});
t("doors/windows expose hosted-element dimensions", () => {
  for (const tool of ["door", "window"]) {
    const keys = TP.getToolPanel(tool).groups.flatMap((g) => g.fields)
      .filter((f) => f.bind && f.bind.kind === "type-default")
      .map((f) => f.bind.key);
    for (const k of ["width", "height", "sillHeight", "frameThickness"]) {
      assert(keys.includes(k), `${tool} missing ${k}`);
    }
  }
});
t("walls expose chain + join behavior", () => {
  const keys = TP.getToolPanel("wall").groups.flatMap((g) => g.fields)
    .filter((f) => f.bind && f.bind.kind === "authoring")
    .map((f) => f.bind.stateKey);
  assert(keys.includes("wallChain"));
  assert(keys.includes("wallJoinStatus"));
  assert(keys.includes("wallOffset"));
});
t("every non-info field declares a binding", () => {
  for (const tool of TP.coveredTools()) {
    for (const f of TP.getToolPanel(tool).groups.flatMap((g) => g.fields)) {
      if (f.kind === "info") continue;
      assert(f.bind, `${tool}/${f.label} has no binding — it would do nothing`);
    }
  }
});
t("select fields always carry options", () => {
  for (const tool of TP.coveredTools()) {
    for (const f of TP.getToolPanel(tool).groups.flatMap((g) => g.fields)) {
      if (f.kind !== "select") continue;
      assert(Array.isArray(f.options) && f.options.length > 0, `${tool}/${f.label} select without options`);
    }
  }
});
t("group titles are unique per tool", () => {
  for (const tool of TP.coveredTools()) {
    const titles = TP.getToolPanel(tool).groups.map((g) => g.title);
    assert(new Set(titles).size === titles.length, `${tool} duplicates group titles`);
  }
});

// ── §2.3 — numeric validation ───────────────────────────────────────────
t("non-finite values are rejected", () => {
  assert(TP.validatePanelNumber({ kind: "number", label: "x" }, NaN) !== null);
  assert(TP.validatePanelNumber({ kind: "number", label: "x" }, Infinity) !== null);
});
t("below-minimum values are rejected with a message", () => {
  const err = TP.validatePanelNumber({ kind: "number", label: "Height", unit: "m", min: 0.01 }, -1);
  assert(err !== null && /minimum/i.test(err));
});
t("above-maximum values are rejected", () => {
  const err = TP.validatePanelNumber({ kind: "number", label: "Panels", max: 24 }, 99);
  assert(err !== null && /maximum/i.test(err));
});
t("in-range values pass", () => {
  assert(TP.validatePanelNumber({ kind: "number", label: "Height", min: 0.01 }, 3.0) === null);
});

console.log(`\nv73-tool-panels: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
