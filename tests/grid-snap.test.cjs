/*
 * Real grid snap (AutoCAD parity A4) — node test.
 *
 * The CAD viewer used to toggle the SAME `snapOn` master for F9/SNAP and
 * for F3/OSNAP, so F9 was a second OSNAP switch; the live point pipeline
 * (`constrainInputPoint`) had no grid step at all, and SNAPUNIT stored
 * `userSnapStep` once and never read it anywhere else. The fix separates
 * the masters — `gridSnapOn` (F9 / SNAP / SNAPMODE / status-bar SNAP)
 * vs `snapOn` (F3 / OSNAP) — and adds a real grid step in
 * `constrainInputPoint` via the pure helpers in grid-snap.ts:
 *   - `snapToGridPoint` rounds to the nearest multiple of the step,
 *     measured from the drawing origin (0,0), the same origin the
 *     visible grid is painted from.
 *   - `effectiveSnapStep` resolves the spacing SNAPUNIT wins, else
 *     GRIDUNIT (AutoCAD: SNAPUNIT defaults to the grid spacing), else
 *     the auto display step.
 *   - `resolveGridSnapPoint` is the one decision: grid ON, no object
 *     snap, usable spacing — otherwise the point is unchanged.
 * Snap order (AutoCAD): an object snap found within aperture wins and
 * grid snap is skipped; otherwise the raw point is quantized to the
 * grid first and ortho/polar/OTRACK operate on the quantized point.
 *
 * Strategy (repo precedent: layer-lock-enforcement.test.cjs):
 *   1. Compile the real grid-snap.ts + session-state.ts with tsc and
 *      test the real helpers behaviourally — no mocks of the decision
 *      logic.
 *   2. Source markers prove cad-viewer.ts actually wires the helpers
 *      into the live path and separates the two masters — these fail on
 *      the unfixed tree, where the helpers and the wiring do not exist.
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cad-grid-snap-"));
execSync(
  `npx tsc src/modules/cad-viewer/grid-snap.ts src/modules/cad-viewer/session-state.ts --outDir "${out}" --module commonjs --target ES2022 --moduleResolution node --lib ES2022,DOM --skipLibCheck --noCheck`,
  { cwd: root, stdio: "inherit" },
);
const G = require(path.join(out, "grid-snap.js"));
const S = require(path.join(out, "session-state.js"));
const viewer = fs.readFileSync(path.join(root, "src", "features", "cad-viewer.ts"), "utf8");
const sessionState = fs.readFileSync(path.join(root, "src", "modules", "cad-viewer", "session-state.ts"), "utf8");

let pass = 0, fail = 0;
const t = (n, f) => {
  try { f(); pass++; console.log("  PASS " + n); }
  catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); }
};

/* ── snapToGridPoint ── */

t("rounds to the nearest multiple of an integer step, both axes", () => {
  assert.deepEqual(G.snapToGridPoint({ x: 13.37, y: 16.2 }, 10), { x: 10, y: 20 });
  assert.deepEqual(G.snapToGridPoint({ x: 14.9, y: 4.9 }, 10), { x: 10, y: 0 });
  assert.deepEqual(G.snapToGridPoint({ x: 15.1, y: 25 }, 10), { x: 20, y: 30 }); // 25 is a tie; Math.round rounds halves up
});

t("rounds to a non-integer step (2.5)", () => {
  assert.deepEqual(G.snapToGridPoint({ x: 7.3, y: 6.1 }, 2.5), { x: 7.5, y: 5 });
  assert.deepEqual(G.snapToGridPoint({ x: 1.2, y: 3.8 }, 2.5), { x: 0, y: 5 });
});

t("rounds to a fractional step (0.5)", () => {
  assert.deepEqual(G.snapToGridPoint({ x: 13.37, y: 4.24 }, 0.5), { x: 13.5, y: 4 });
});

t("step 0.1 returns clean decimals, not binary dust", () => {
  // 134 * 0.1 is 13.400000000000002 in raw floating point; a snapped
  // coordinate saved to DXF must read back as 13.4.
  const p = G.snapToGridPoint({ x: 13.37, y: 4.26 }, 0.1);
  assert.equal(p.x, 13.4);
  assert.equal(p.y, 4.3);
});

t("a step larger than the movement snaps to the origin multiple", () => {
  assert.deepEqual(G.snapToGridPoint({ x: 13, y: 4 }, 100), { x: 0, y: 0 });
  assert.deepEqual(G.snapToGridPoint({ x: 60, y: -40 }, 100), { x: 100, y: 0 });
});

t("negative coordinates round to the nearest multiple", () => {
  assert.deepEqual(G.snapToGridPoint({ x: -13.37, y: -16 }, 10), { x: -10, y: -20 });
  // Ties round toward +Infinity, like Math.round: -5 is halfway between
  // -10 and 0, so it lands on 0.
  assert.deepEqual(G.snapToGridPoint({ x: -5, y: -5 }, 10), { x: 0, y: 0 });
});

t("multiples are measured from the given origin, not from (0,0)", () => {
  assert.deepEqual(G.snapToGridPoint({ x: 13, y: 4 }, 10, { x: 5, y: 0 }), { x: 15, y: 0 });
  assert.deepEqual(G.snapToGridPoint({ x: 13, y: 4 }, 5, { x: 2.5, y: 2.5 }), { x: 12.5, y: 2.5 });
});

t("the default origin is the drawing origin (0,0)", () => {
  assert.deepEqual(G.DRAWING_ORIGIN, { x: 0, y: 0 });
  assert.deepEqual(G.snapToGridPoint({ x: 13, y: 4 }, 10), { x: 10, y: 0 });
});

t("a non-positive, NaN or infinite step leaves the point unchanged", () => {
  for (const step of [0, -5, NaN, Infinity, -Infinity]) {
    assert.deepEqual(G.snapToGridPoint({ x: 13.37, y: 4.26 }, step), { x: 13.37, y: 4.26 });
  }
});

t("a point already on the grid is unchanged", () => {
  assert.deepEqual(G.snapToGridPoint({ x: 20, y: -30 }, 10), { x: 20, y: -30 });
});

t("does not mutate its input", () => {
  const p = { x: 13.37, y: 4.26 };
  const q = G.snapToGridPoint(p, 10);
  assert.deepEqual(p, { x: 13.37, y: 4.26 });
  assert.notEqual(q, p);
});

/* ── effectiveSnapStep ── */

t("SNAPUNIT wins over GRIDUNIT and the auto step", () => {
  assert.equal(G.effectiveSnapStep(10, 5, 2), 10);
});

t("falls back to GRIDUNIT when SNAPUNIT is unset", () => {
  assert.equal(G.effectiveSnapStep(null, 5, 2), 5);
  assert.equal(G.effectiveSnapStep(undefined, 5, 2), 5);
});

t("falls back to the auto display step when neither is set", () => {
  assert.equal(G.effectiveSnapStep(null, null, 2), 2);
});

t("ignores a non-positive or NaN SNAPUNIT and falls back", () => {
  assert.equal(G.effectiveSnapStep(0, 5, 2), 5);
  assert.equal(G.effectiveSnapStep(-3, 5, 2), 5);
  assert.equal(G.effectiveSnapStep(NaN, null, 2), 2);
});

t("returns null when no candidate is a usable spacing", () => {
  assert.equal(G.effectiveSnapStep(null, null, null), null);
  assert.equal(G.effectiveSnapStep(0, -1, NaN), null);
  assert.equal(G.effectiveSnapStep(undefined, undefined, undefined), null);
});

/* ── resolveGridSnapPoint: the one decision ── */

const on = (step, extra = {}) => ({ gridSnapOn: true, hasObjectSnap: false, step, ...extra });

t("grid ON with no object snap snaps the point", () => {
  assert.deepEqual(G.resolveGridSnapPoint({ x: 13, y: 4 }, on(10)), { x: 10, y: 0 });
});

t("grid OFF leaves the point untouched even with a valid step", () => {
  assert.deepEqual(
    G.resolveGridSnapPoint({ x: 13, y: 4 }, { gridSnapOn: false, hasObjectSnap: false, step: 10 }),
    { x: 13, y: 4 },
  );
});

t("an object snap wins: grid snap is skipped when one was found", () => {
  // AutoCAD order — the object-snapped point must not be dragged onto
  // the grid. (The caller substitutes the object-snap point itself.)
  assert.deepEqual(
    G.resolveGridSnapPoint({ x: 13.37, y: 4.26 }, { gridSnapOn: true, hasObjectSnap: true, step: 10 }),
    { x: 13.37, y: 4.26 },
  );
});

t("grid ON with no usable spacing leaves the point untouched", () => {
  assert.deepEqual(G.resolveGridSnapPoint({ x: 13, y: 4 }, on(null)), { x: 13, y: 4 });
});

t("the origin is honoured through the decision helper", () => {
  assert.deepEqual(
    G.resolveGridSnapPoint({ x: 13, y: 4 }, on(10, { origin: { x: 5, y: 0 } })),
    { x: 15, y: 0 },
  );
});

t("SNAPUNIT takes effect: the same point snaps differently per SNAPUNIT value", () => {
  // This is the pipeline the viewer runs: SNAPUNIT only ever assigned
  // userSnapStep, and effectiveSnapStep is what reads it back.
  const p = { x: 13, y: 4 };
  const at10 = G.resolveGridSnapPoint(p, on(G.effectiveSnapStep(10, null, 2)));
  const at5 = G.resolveGridSnapPoint(p, on(G.effectiveSnapStep(5, null, 2)));
  const atAuto = G.resolveGridSnapPoint(p, on(G.effectiveSnapStep(null, null, 2)));
  assert.deepEqual(at10, { x: 10, y: 0 });
  assert.deepEqual(at5, { x: 15, y: 5 });
  assert.deepEqual(atAuto, { x: 14, y: 4 });
});

/* ── session persistence: gridSnapOn rides the existing SessionUi record ── */

t("sanitizeSessionUi keeps gridSnapOn and drops a non-boolean value", () => {
  assert.equal(S.sanitizeSessionUi({ gridSnapOn: true }, [], []).gridSnapOn, true);
  assert.equal(S.sanitizeSessionUi({ gridSnapOn: false }, [], []).gridSnapOn, false);
  assert.equal(S.sanitizeSessionUi({ gridSnapOn: "yes" }, [], []).gridSnapOn, undefined);
  assert.equal(S.sanitizeSessionUi({ snapOn: true }, [], []).snapOn, true);
});

t("sessionUiSignature round-trips gridSnapOn alongside snapOn", () => {
  const sig = S.sessionUiSignature({ snapOn: true, gridSnapOn: true });
  assert.equal(JSON.parse(sig).gridSnapOn, true);
  assert.equal(JSON.parse(sig).snapOn, true);
});

/* ── source markers: the viewer actually wires the helpers in ── */

const has = (s, label) => {
  assert.ok(viewer.includes(s), `cad-viewer.ts is missing: ${label}`);
};

t("viewer imports the grid-snap module", () => {
  has('import * as GridSnap from "../modules/cad-viewer/grid-snap"', "grid-snap import");
});

t("constrainInputPoint applies the grid step from the SNAPUNIT value", () => {
  has("GridSnap.resolveGridSnapPoint(point,", "constrainInputPoint calls resolveGridSnapPoint");
  has("GridSnap.effectiveSnapStep(userSnapStep, userGridStep, M.gridStep(view.scale))", "effective step reads userSnapStep");
  has("origin: GridSnap.DRAWING_ORIGIN", "grid anchored at the drawing origin");
});

t("F9 toggles grid snap only, and reaches the canvas key handler while the command HUD is open", () => {
  has('if (key === "F9")', "F9 key handler");
  has("setGridSnap(!gridSnapOn)", "F9 toggles gridSnapOn");
  assert.ok(viewer.includes('event.key === "F9"'), "dynamic-command input forwards F9 to the canvas");
});

t("SNAP / SNAPMODE toggles grid snap, not the OSNAP master", () => {
  has('if (cmd === "SNAP" || cmd === "SNAPMODE")', "SNAP command branch");
  const i = viewer.indexOf('if (cmd === "SNAP" || cmd === "SNAPMODE")');
  const block = viewer.slice(i, i + 600);
  assert.ok(block.includes("setGridSnap"), "SNAP command calls setGridSnap");
  assert.ok(!block.includes("snapOn = !snapOn"), "SNAP command must not toggle snapOn");
});

t("SNAPMODE (getvar/setvar) now reports the grid-snap master", () => {
  has('if (k === "SNAPMODE") return gridSnapOn ? 1 : 0;', "SNAPMODE getvar reads gridSnapOn");
  has('if (k === "SNAPMODE") gridSnapOn = Number(v) !== 0;', "SNAPMODE setvar writes gridSnapOn");
});

t("the status bar gains a SNAP button wired to grid snap, next to the untouched OSNAP button", () => {
  has('data-s="gridsnap"', "status-bar SNAP button");
  has('title="Snap to grid (F9)"', "SNAP button names F9");
  has('data-s="snap" title="Object Snap (F3)"', "OSNAP button still names F3");
  const i = viewer.indexOf('statusEl.querySelector("[data-s=gridsnap]")');
  assert.ok(i >= 0, "SNAP status-bar listener missing");
  assert.ok(viewer.slice(i, i + 200).includes("setGridSnap(!gridSnapOn)"), "SNAP button toggles gridSnapOn");
});

t("the OPTIONS dialog splits SNAP and OSNAP into separate rows", () => {
  has('row("gridsnap", "SNAP — grid (F9)", gridSnapOn)', "OPTIONS grid-snap row");
  has('row("osnap", "OSNAP — object (F3)", snapOn)', "OPTIONS osnap row");
  assert.ok(!viewer.includes('"SNAP / OSNAP (F3/F9)"'), "the combined SNAP/OSNAP row is gone");
});

t("gridSnapOn is saved and restored with the other toggles", () => {
  has("gridSnapOn,", "currentUi saves gridSnapOn");
  has("if (u.gridSnapOn !== undefined) gridSnapOn = u.gridSnapOn;", "restore reads gridSnapOn");
  assert.ok(sessionState.includes("gridSnapOn?: boolean"), "SessionUi declares gridSnapOn");
  assert.ok(sessionState.includes('"gridSnapOn"'), "sanitizeSessionUi validates gridSnapOn");
});

t("F3 / OSNAP still drive the OSNAP master only", () => {
  has('if (key === "F3")', "F3 key handler still exists");
  has('if (cmd === "OSNAP")', "OSNAP command still exists");
  const i = viewer.indexOf('if (cmd === "OSNAP")');
  const block = viewer.slice(i, i + 200);
  assert.ok(block.includes("snapOn = !snapOn"), "OSNAP command toggles snapOn");
  assert.ok(!block.includes("gridSnapOn"), "OSNAP command must not touch gridSnapOn");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
