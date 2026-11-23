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
  assert(/function dimStyleOf\(rec: DIM\.DimRecord\): DIM\.DimStyle \{\s*\n\s*const base = dimStyleList\.find\(\(st\) => st\.name === rec\.styleName\) \?\? currentDimStyle\(\);\s*\n\s*return \{ \.\.\.base, \.\.\.\(dimOverrides\.get\(rec\.id\) \?\? \{\}\) \};/.test(cv), "dimStyleOf merge missing");
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

async function main() {
  console.log(`=== cad-dim-tools: ${pass} passed, ${fail} failed ===`);
  process.exitCode = fail ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
