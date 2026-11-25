// CAD snap behaviour (AutoCAD parity A15) — findSnap node tests.
//
// Proves, without a browser, the three snapper changes in
// src/modules/cad-viewer/viewer-math.ts:
//   1. Nearest-in-aperture: the CAD viewer used to pick by fixed
//      priority tier (endpoint/midpoint/centre first, intersection /
//      extension / perpendicular later) no matter the distance.
//      AutoCAD picks the nearest snap candidate inside the aperture;
//      tiers only break (near-)ties now.
//   2. Apparent intersection: the mode was accepted but could never
//      fire — only bounded crossings were computed. Two entities whose
//      extensions cross inside the aperture now offer an "apparent"
//      snap; a bounded crossing is an "intersection", never "apparent".
//   3. "nearest" stays a fallback: it only fires when no specific
//      snap kind produced a candidate (the old code already had that
//      shape — the nearest candidate never passes through `consider`).
//
// Fixture (one drawing, all units mm):
//   A: (0,0)-(1000,0)            midpoint (500,0)
//   B: (300,-400)-(300,600)      midpoint (300,100); crosses A at (300,0)
//   D: (308,2)-(316,9)           endpoint E (308,2), midpoint (312,5.5)
//   C: (700,200)-(800,200)       midpoint (750,200)
//   E: (760,210)-(760,300)       endpoint (760,210), midpoint (760,255)
// C and E do not meet: E's downward extension crosses C at (760,200),
// which is ON C but NOT on E — the apparent-intersection point.
// The cursor positions below were chosen so the expected winner is
// strictly nearer than every other candidate (margins > 1 unit), and
// so the OLD tier code would have returned a different point — each
// test below names the old answer in its comment.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cad-snap-a15-"));
try {
  execSync("npx tsc src/modules/cad-viewer/viewer-math.ts --outDir " + out + " --module commonjs --target es2020 --skipLibCheck", { cwd: root, stdio: "pipe" });
} catch (e) {
  const log = String((e.stdout || "") + (e.stderr || ""));
  assert.fail("type errors in viewer-math.ts:\n" + log);
}
const M = require((() => {
  const locate = (dir, name) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = locate(p, name); if (found) return found; }
      else if (entry.name === name) return p;
    }
    return null;
  };
  const mathPath = locate(out, "viewer-math.js");
  assert.ok(mathPath, "compiled viewer-math.js should exist");
  return mathPath;
})());
const line = (x1, y1, x2, y2) => ({ type: "LINE", layer: "0", start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });
const entities = [
  line(0, 0, 1000, 0),      // A
  line(300, -400, 300, 600), // B
  line(308, 2, 316, 9),      // D
  line(700, 200, 800, 200),  // C
  line(760, 210, 760, 300),  // E
];
const idx = M.buildIndex(entities, { minX: -10, minY: -410, maxX: 1010, maxY: 610 });
const vis = () => true;
const snap = (x, y, tol, modes) => M.findSnap(idx, entities, x, y, tol, modes, vis);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

// ---- 1. Nearest-in-aperture ----
t("nearest wins over a higher tier: intersection (3.61) beats endpoint (6.08)", () => {
  // Old tier code returned the endpoint (308,2): tier 0 beat tier 1
  // regardless of distance. The extension candidate (305.1,-0.54) at
  // 4.71 is also nearer than the endpoint, so this pins the ordering.
  const s = snap(302, 3, 15, M.ALL_SNAPS);
  assert.ok(s, "expected a snap");
  assert.strictEqual(s.kind, "intersection");
  near(s.x, 300); near(s.y, 0);
});
t("nearest wins the other way too: endpoint (2.24) beats intersection (6.08)", () => {
  // Modes exclude extension on purpose: the cursor (306,1) sits almost
  // on D's extension ray, so the extension projection (0.57 away) would
  // legitimately win under nearest-first. This test pins the
  // endpoint-vs-intersection ordering only.
  const s = snap(306, 1, 15, ["endpoint", "midpoint", "center", "intersection"]);
  assert.ok(s);
  assert.strictEqual(s.kind, "endpoint");
  near(s.x, 308); near(s.y, 2);
});
t("tie-break: equal distance falls back to tier (endpoint over intersection)", () => {
  const small = [line(0, 0, 10, 0), line(6, -6, 6, 6)];
  const smallIdx = M.buildIndex(small, { minX: -10, minY: -10, maxX: 20, maxY: 10 });
  // Cursor (3,0): endpoint (0,0) and intersection (6,0) are both 3.0 away.
  const s = M.findSnap(smallIdx, small, 3, 0, 5, ["endpoint", "intersection"], vis);
  assert.ok(s);
  assert.strictEqual(s.kind, "endpoint");
  near(s.x, 0); near(s.y, 0);
});

// ---- 2. Apparent intersection ----
t("apparent fires when extensions cross inside the aperture", () => {
  // Old code returned the midpoint (750,200): apparent could never fire.
  // The extension candidate at the same point (760,200) ties at 4.0 and
  // is considered after the apparent block, so apparent still wins.
  const s = snap(756, 200, 15, M.ALL_SNAPS);
  assert.ok(s, "expected a snap");
  assert.strictEqual(s.kind, "apparent");
  near(s.x, 760); near(s.y, 200);
});
t("a bounded crossing is an intersection, never apparent", () => {
  const s = snap(300, 2, 15, M.ALL_SNAPS);
  assert.ok(s);
  assert.strictEqual(s.kind, "intersection");
  near(s.x, 300); near(s.y, 0);
});
t("apparent is not offered when the mode is off", () => {
  // Modes without apparent AND extension: the midpoint (750,200) wins.
  const s = snap(756, 200, 15, ["endpoint", "midpoint", "center", "intersection", "nearest"]);
  assert.ok(s);
  assert.strictEqual(s.kind, "midpoint");
  near(s.x, 750); near(s.y, 200);
});
t("apparent outside the aperture is not offered", () => {
  // Apparent (760,200) is 20 away; the midpoint (750,200) is 10 away.
  const s = snap(740, 200, 15, M.ALL_SNAPS);
  assert.ok(s);
  assert.strictEqual(s.kind, "midpoint");
  near(s.x, 750); near(s.y, 200);
});

// ---- 3. Nearest stays a fallback; override filter works at findSnap level ----
t("nearest fallback fires only when no specific kind is near", () => {
  // Cursor (700,3): no endpoint/midpoint/intersection within 15.
  const s = snap(700, 3, 15, M.ALL_SNAPS);
  assert.ok(s);
  assert.strictEqual(s.kind, "nearest");
  near(s.x, 700); near(s.y, 0);
});
t("override filter: modes=[endpoint] near a midpoint returns null", () => {
  // This is what the viewer passes when the SE override is armed: the
  // pick is restricted to endpoints, so a midpoint-only neighbourhood
  // offers nothing (and the raw point is used instead).
  assert.strictEqual(snap(500, 3, 15, ["endpoint"]), null);
});
t("override filter: modes=[endpoint] near an endpoint returns it", () => {
  const s = snap(2, 3, 15, ["endpoint"]);
  assert.ok(s);
  assert.strictEqual(s.kind, "endpoint");
  near(s.x, 0); near(s.y, 0);
});

// ---- Source pins: the viewer wiring this test cannot execute ----
t("OSNAP Defaults restores DEFAULT_SNAP_MODES, not ALL_SNAPS", () => {
  const src = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
  const defLines = src.split("\n").filter((l) => l.includes("snap-default") && l.includes("addEventListener"));
  assert.strictEqual(defLines.length, 1, "expected exactly one snap-default handler");
  assert.ok(defLines[0].includes("DEFAULT_SNAP_MODES"), "Defaults must refresh DEFAULT_SNAP_MODES");
  assert.ok(!defLines[0].includes("ALL_SNAPS"), "Defaults must not refresh ALL_SNAPS");
  const allLines = src.split("\n").filter((l) => l.includes("snap-all") && l.includes("addEventListener"));
  assert.strictEqual(allLines.length, 1);
  assert.ok(allLines[0].includes("ALL_SNAPS"), "All must still refresh ALL_SNAPS");
});
t("OSNAP dialog lists every snap mode the engine supports", () => {
  const src = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
  const start = src.indexOf("function openOsnapSettings");
  const end = src.indexOf("function openUnitsDialog", start);
  assert.ok(start >= 0 && end > start, "OSNAP dialog function not found");
  const dialog = src.slice(start, end);
  for (const kind of M.ALL_SNAPS) {
    assert.ok(dialog.includes(`id: "${kind}"`), `dialog is missing the ${kind} checkbox`);
  }
  assert.strictEqual(M.ALL_SNAPS.length, 14, "ALL_SNAPS should have 14 kinds");
});
t("one-shot override is consumed at the three snap-pick sites", () => {
  const src = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
  const consumes = src.split("cadSnapOverride.consumeAfterSnap()").length - 1;
  assert.ok(consumes >= 3, `expected >= 3 consume sites, found ${consumes}`);
  assert.ok(src.includes("clearCadSnapOverride()"), "setTool must clear the override");
  assert.ok(src.includes("function showCadSnapOverrideMenu"), "right-click overrides menu must exist");
  assert.ok(src.includes("resolveCadOverrideKeys"), "keydown handler must resolve override keys");
  assert.ok(src.includes("armCadSnapOverride"), "override arming must exist");
});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
