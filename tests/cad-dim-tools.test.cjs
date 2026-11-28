#!/usr/bin/env node
// Dimension/annotation parity batch: DIMSPACE, DIMBREAK, DIMOVERRIDE,
// DIMDISASSOCIATE, HYPERLINK — intersection math runs against the compiled
// viewer-math; wiring is gated statically over the sources.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const loaded = {};
function loadTsc(rel, exported) {
  if (!loaded[rel]) {
    const { execSync } = require("child_process");
    const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "dimtools-"));
    execSync(`npx tsc ${rel} --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
    const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
    loaded[rel] = require(find(out, path.basename(rel).replace(/\.ts$/, ".js")));
  }
  return exported ? loaded[rel][exported] : loaded[rel];
}

const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
const cv = read("src/features/cad-viewer.ts");
const ea = read("src/core/escape-all.ts");
const home = read("src/shell/home-screen.ts");
const types = read("src/modules/drawings/dxf-types.ts");
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  PASS " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + ": " + e.message); }
};

/* ── intersection math (the DIMBREAK engine) ────────────────────────── */

t("segment/segment: crossing lines intersect once inside both spans", () => {
  const M = loadTsc("src/modules/cad-viewer/viewer-math.ts", "segmentIntersections");
  const xs = M({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 });
  assert.strictEqual(xs.length, 1);
  assert.ok(Math.abs(xs[0].x - 5) < 1e-9 && Math.abs(xs[0].y) < 1e-9, JSON.stringify(xs));
});

t("segment/segment: parallel and non-intersecting spans yield nothing", () => {
  const M = loadTsc("src/modules/cad-viewer/viewer-math.ts", "segmentIntersections");
  assert.deepStrictEqual(M({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 }, { x: 10, y: 1 }), [], "parallel");
  assert.deepStrictEqual(M({ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: -5 }, { x: 5, y: 5 }), [], "crossing outside span");
});

t("segment/circle: two crossings, filtered to the segment", () => {
  const M = loadTsc("src/modules/cad-viewer/viewer-math.ts", "segmentCircleIntersections");
  const xs = M({ x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, 4);
  assert.strictEqual(xs.length, 2);
  xs.sort((a, b) => a.x - b.x);
  assert.ok(Math.abs(xs[0].x + 4) < 1e-9 && Math.abs(xs[1].x - 4) < 1e-9, JSON.stringify(xs));
  assert.deepStrictEqual(M({ x: 5, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, 4), [], "segment outside circle");
});

t("segment/arc: crossings respect the angular span", () => {
  const M = loadTsc("src/modules/cad-viewer/viewer-math.ts", "segmentCircleIntersections");
  // Full circle: both crossings. A quarter arc (0° sweeping 90°, the
  // upper-right quadrant) keeps only the +4 crossing at angle 0.
  const full = M({ x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, 4);
  const quarter = M({ x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, 4, { startAngle: 0, sweepDeg: 90 });
  assert.strictEqual(full.length, 2);
  assert.strictEqual(quarter.length, 1, JSON.stringify(quarter));
  assert.ok(Math.abs(quarter[0].x - 4) < 1e-9, "kept the crossing inside the sweep");
});

/* ── command wiring ─────────────────────────────────────────────────── */

t("DIMSPACE routes and spaces by the dim-line normal", () => {
  assert(/cmd === "DIMSPACE"\) \{ dimspaceCmd\(parts\.slice\(1\)\); return; \}/.test(cv), "route missing");
  const m = cv.match(/function dimspaceCmd\(args: string\[\]\): void \{[\s\S]*?\n  \}/);
  assert.ok(m && m[0].includes("dimNormalOf(r)") && m[0].includes("DIMSPACE AUTO"), "spacing logic missing");
});

t("DIMBREAK splits the role-dimline entity at crossings via the shared math", () => {
  assert(/cmd === "DIMBREAK"\) \{ dimbreakCmd\(\); return; \}/.test(cv), "route missing");
  const m = cv.match(/function dimbreakCmd\(\): void \{[\s\S]*?\n  \}/);
  assert.ok(m, "dimbreakCmd missing");
  const body = m[0];
  assert(body.includes('e.meta?.role === "dimline"'), "must target the role-dimline entities");
  assert(body.includes("M.segmentIntersections") && body.includes("M.segmentCircleIntersections"), "must use the shared intersection math");
  assert(body.includes("applyDimReplace(before, after)"), "must replace as one undo act");
});

t("DIMOVERRIDE merges per-record overrides into every style resolution", () => {
  assert(/cmd === "DIMOVERRIDE" \|\| cmd === "DOV"\) \{ dimoverrideCmd\(parts\.slice\(1\)\); return; \}/.test(cv), "route missing");
  // 2D-30: dimStyleOf wraps the merged style in annoScaledStyle so the
  // arrowhead size follows the annotation scale — the merge itself is
  // unchanged (base + dimOverrides), only the returned shape is scaled.
  assert(/function dimStyleOf\(rec: DIM\.DimRecord\): DIM\.DimStyle \{\s*\n\s*const base = dimStyleList\.find\(\(st\) => st\.name === rec\.styleName\) \?\? currentDimStyle\(\);\s*\n\s*return annoScaledStyle\(\{ \.\.\.base, \.\.\.\(dimOverrides\.get\(rec\.id\) \?\? \{\}\) \}\);/.test(cv), "dimStyleOf merge missing");
  const commit = cv.match(/function commitDimRecord\(rec: DIM\.DimRecord\): DxfEntity\[\] \{[\s\S]*?\n  \}/);
  assert.ok(commit && commit[0].includes("dimStyleOf(rec)"), "commitDimRecord must use the merged style");
  const assoc = cv.slice(cv.indexOf("function withAssociativeDims"), cv.indexOf("function withAssociativeDims") + 1600);
  assert.ok(assoc.includes("dimStyleOf(rec)"), "associative rebuilds must use the merged style");
  assert(/sub === "TEXTHEIGHT"/.test(cv) && /sub === "SUFFIX"/.test(cv), "property table incomplete");
});

t("DIMDISASSOCIATE removes the record so tracking stops", () => {
  assert(/cmd === "DIMDISASSOCIATE"\) \{ dimdisassociateCmd\(\); return; \}/.test(cv), "route missing");
  const m = cv.match(/function dimdisassociateCmd\(\): void \{[\s\S]*?\n  \}/);
  assert.ok(m && m[0].includes("dimRecords.delete(r.id)"), "record removal missing");
});

t("HYPERLINK attaches, lists and clears URLs on selection", () => {
  assert(/cmd === "HYPERLINK"\) \{ hyperlinkCmd\(parts\.slice\(1\)\); return; \}/.test(cv), "route missing");
  const m = cv.match(/function hyperlinkCmd\(args: string\[\]\): void \{[\s\S]*?\n  \}/);
  assert.ok(m && m[0].includes("hyperlink: arg") && m[0].includes('arg.toUpperCase() === "REMOVE"'), "attach/remove missing");
  assert(types.includes("hyperlink?: string"), "meta type must carry hyperlink");
});

t("entity replacement is a single undo 'replace' act", () => {
  const m = cv.match(/function applyDimReplace\(before: DxfEntity\[\], after: DxfEntity\[\]\): void \{[\s\S]*?\n  \}/);
  assert.ok(m && m[0].includes('pushUndoAct({ type: "replace", before, after })'), "undo act missing");
});

t("new commands are registered in the catalog", () => {
  for (const n of ["DIMSPACE", "DIMBREAK", "DIMOVERRIDE", "DIMDISASSOCIATE", "HYPERLINK"]) {
    assert(new RegExp(`\\{\\s*name:\\s*"${n}"`).test(cv), `registry entry ${n} missing`);
  }
});

/* ── escape-all gap closures ────────────────────────────────────────── */

t("measure-creation scope exists and clears the pending measurer", () => {
  const m = ea.match(/id: "measure-creation"[\s\S]*?cancel: \(\) => \{[\s\S]*?\n    \},/);
  assert.ok(m && m[0].includes("cancelCreation"), "must clear the pending creation flow");
});

t("the ESC test counts cancel events, not every dispatch", () => {
  const test = read("tests/escape-all.test.cjs");
  assert(/dispatched\.filter\(\(e\)[^)]*\.type === "obs:operation-cancelled"\)/.test(test), "filter missing");
});

t("command-count copy matches the real registry", () => {
  const arr = cv.slice(cv.indexOf("const CAD_COMMANDS"), cv.indexOf("];", cv.indexOf("const CAD_COMMANDS")));
  const n = (arr.match(/\{\s*name:\s*"/g) || []).length;
  assert.ok(n >= 182, `registry holds ${n} commands`);
  // The copy states either the exact count or a "200+" floor (the upstream
  // welcome page moved to a range claim as the registry keeps growing).
  const exact = home.includes(`${n} keyboard-first commands`) && home.includes(`${n} COMMANDS`);
  const floor = home.includes("200+ keyboard-first commands") && home.includes("200+ command line");
  assert.ok(exact || floor, `home copy must state ${n} or a 200+ floor`);
});

/* ── 2D-22: DIMENSION entity ↔ live record round-trip ─────────────── */
/* A dimension authored inside BEDIT is stored in the block as a real
   DIMENSION entity; dimRecordOfDimension rebuilds its live record (the
   exact inverse of dimensionEntitiesForSave's field mapping) so the
   renderer can draw it from its definition points. */

t("2D-22: dimRecordOfDimension inverts the save mapping (linear/aligned)", () => {
  const DIM = loadTsc("src/modules/cad-viewer/dimension-system.ts");
  const lin = DIM.dimRecordOfDimension({
    type: "DIMENSION", layer: "0", dimId: "dim-x", dimType: 0, styleName: "ISO-25",
    defPoint: { x: 10, y: 50 }, extOrigin1: { x: 0, y: 0 }, extOrigin2: { x: 40, y: 0 },
    text: "40.00",
  });
  assert.ok(lin, "linear must rebuild");
  assert.equal(lin.mode, "linear");
  assert.deepEqual(lin.p1, { x: 0, y: 0 });
  assert.deepEqual(lin.p2, { x: 40, y: 0 });
  assert.deepEqual(lin.placement, { x: 10, y: 50 });
  const ali = DIM.dimRecordOfDimension({
    type: "DIMENSION", layer: "0", dimType: 1,
    defPoint: { x: 5, y: 5 }, extOrigin1: { x: 0, y: 0 }, extOrigin2: { x: 3, y: 4 },
  });
  assert.ok(ali && ali.mode === "aligned", "aligned must rebuild");
});

t("2D-22: dimRecordOfDimension inverts the save mapping (radial/diameter/ordinate)", () => {
  const DIM = loadTsc("src/modules/cad-viewer/dimension-system.ts");
  const rad = DIM.dimRecordOfDimension({
    type: "DIMENSION", layer: "0", dimType: 4,
    defPoint: { x: 0, y: 0 }, curvePoint: { x: 10, y: 0 }, text: "R10.00",
  });
  assert.ok(rad && rad.mode === "radial", "radial must rebuild");
  assert.deepEqual(rad.p1, { x: 0, y: 0 });
  assert.deepEqual(rad.p2, { x: 10, y: 0 });
  const dia = DIM.dimRecordOfDimension({
    type: "DIMENSION", layer: "0", dimType: 3,
    defPoint: { x: 0, y: 0 }, curvePoint: { x: 0, y: 5 },
  });
  assert.ok(dia && dia.mode === "diameter", "diameter must rebuild");
  // Ordinate: the datum axis comes back by the same dominant-delta rule
  // the DIMORDINATE tool uses (dx >= dy → "x").
  const ordX = DIM.dimRecordOfDimension({
    type: "DIMENSION", layer: "0", dimType: 6,
    defPoint: { x: 20, y: 30 }, leaderEnd: { x: 45, y: 32 },
  });
  assert.ok(ordX && ordX.mode === "ordinate" && ordX.axis === "x", "ordinate x must rebuild");
  const ordY = DIM.dimRecordOfDimension({
    type: "DIMENSION", layer: "0", dimType: 6,
    defPoint: { x: 20, y: 30 }, leaderEnd: { x: 22, y: 60 },
  });
  assert.ok(ordY && ordY.axis === "y", "ordinate y must rebuild");
});

t("2D-22: dimRecordOfDimension rejects types with no record and missing points", () => {
  const DIM = loadTsc("src/modules/cad-viewer/dimension-system.ts");
  assert.equal(DIM.dimRecordOfDimension({ type: "DIMENSION", layer: "0", dimType: 2, defPoint: { x: 0, y: 0 } }), null, "angular (70=2) has no record");
  assert.equal(DIM.dimRecordOfDimension({ type: "DIMENSION", layer: "0", dimType: 0, defPoint: { x: 0, y: 0 }, extOrigin1: { x: 0, y: 0 } }), null, "linear without extOrigin2 must fail");
  assert.equal(DIM.dimRecordOfDimension({ type: "DIMENSION", layer: "0", dimType: 4, defPoint: { x: 0, y: 0 } }), null, "radial without curvePoint must fail");
});

t("2D-22: a rebuilt record renders back to dimension geometry", () => {
  const DIM = loadTsc("src/modules/cad-viewer/dimension-system.ts");
  const rec = DIM.dimRecordOfDimension({
    type: "DIMENSION", layer: "0", dimId: "dim-x", dimType: 0, styleName: "ISO-25",
    defPoint: { x: 10, y: 50 }, extOrigin1: { x: 0, y: 0 }, extOrigin2: { x: 40, y: 0 },
    text: "40.00",
  });
  const style = DIM.defaultDimStyles()[0];
  const built = DIM.buildDimEntities(rec, style, "40.00");
  assert.ok(built.length >= 3, `expected dimension geometry, got ${built.length} entities`);
  const textEnt = built.find((e) => e.type === "TEXT");
  assert.ok(textEnt && textEnt.value === "40.00", "measurement text must survive the round-trip");
  assert.ok(built.every((e) => e.meta?.dimId === "dim-x"), "built geometry keeps the dimId tag");
});

t("2D-22: BCLOSE converts session dimensions and drops their records", () => {
  assert.ok(/dimensionEntitiesForSave\(ents\)/.test(cv), "BCLOSE must build DIMENSION entities from the session list");
  assert.ok(/ents = ents\.filter\(\(e\) => !\(e\.meta\?\.dimId && ids\.has\(e\.meta\.dimId\)\)\)/.test(cv), "converted geometry must be swapped out of the session list");
  assert.ok(/dimIdsAtOpen: new Set\(dimRecords\.keys\(\)\)/.test(cv), "session must snapshot the record ids at open");
  assert.ok(/dropSessionDims\(\)/.test(cv), "session records must be dropped on save and on discard");
  assert.ok(/case "DIMENSION": \{[\s\S]*?dimRecordOfDimension\(e\)/.test(cv), "drawEntity must render a DIMENSION entity from its definition points");
});

async function main() {
  console.log(`=== cad-dim-tools: ${pass} passed, ${fail} failed ===`);
  process.exitCode = fail ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
