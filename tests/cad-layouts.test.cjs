/*
 * CAD shell layouts (AutoCAD parity A13).
 *
 * The CAD viewer's MODEL/PAPER status button rendered a label with no
 * click handler (display-only), there was no "+" / new-layout button
 * (creation was command-line only), and every layout switch wiped the
 * view history (`history.length = 0` in activate()), so Zoom Previous
 * reported "No previous view" after a switch. Worse, UNDO / REDO operated
 * on whichever entity list happened to be current: an edit made in model
 * space and undone from a paper layout pushed model entities into the
 * layout's list (and vice versa), because nothing recorded which space an
 * action belonged to.
 *
 * The fix:
 *   1. The MODEL/PAPER button toggles space for real (PAPER returns to
 *      the last paper layout, creating Layout1 when the drawing has
 *      none); the tab strip is always visible while a drawing is open
 *      and gains a "+" button that creates a layout and switches to it.
 *   2. addLayout creates one default viewport on an A3 sheet (10 mm
 *      margin) fitted to the model view, so a new layout shows the
 *      drawing through the viewport instead of an empty sheet.
 *   3. Every undo action is stamped with its owning space at push time
 *      and UNDO / REDO apply the pure list transform to that space's
 *      list, writing it back to its owner; the cached per-space spatial
 *      index is kept in step so picks stay correct after a round-trip.
 *
 * Strategy (repo precedent: fillet-chamfer.test.cjs):
 *   1. Compile the real acad-parity.ts with tsc and test addLayout and
 *      the undo/redo list helpers behaviourally — no mocks of the
 *      decision logic.
 *   2. Source markers prove cad-viewer.ts actually wires the helpers
 *      into the live path (toggle handler, "+" button, space stamping,
 *      no history wipe) — these fail on the unfixed tree, where the
 *      wiring does not exist.
 */
const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-cad-layouts-"));
execSync(
  `npx tsc src/modules/cad-viewer/acad-parity.ts --outDir "${out}" --module commonjs --target ES2022 --moduleResolution node --lib ES2022,DOM --skipLibCheck --noCheck`,
  { cwd: root, stdio: "inherit" },
);
const P = require(path.join(out, "cad-viewer", "acad-parity.js"));
const viewer = fs.readFileSync(path.join(root, "src", "features", "cad-viewer.ts"), "utf8");

let pass = 0,
  fail = 0;
const t = (n, f) => {
  try {
    f();
    pass++;
    console.log("  PASS " + n);
  } catch (e) {
    fail++;
    console.log("  FAIL " + n + ": " + e.message);
  }
};
const close = (a, b, eps = 1e-6) => {
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} to be within ${eps} of ${b}`);
};
const line = (x1, y1, x2, y2, layer = "0") => ({ type: "LINE", layer, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });
const doc = () => ({ units: "mm", layers: [{ name: "0", color: 7 }], entities: [] });

/* ── addLayout: naming ─────────────────────────────────────────────── */

t("first layout is Layout1", () => {
  const d = doc();
  assert.strictEqual(P.addLayout(d), "Layout1");
  assert.strictEqual(d.layouts.length, 1);
  assert.strictEqual(d.layouts[0].name, "Layout1");
});

t("layouts count up (Layout2, Layout3)", () => {
  const d = doc();
  assert.strictEqual(P.addLayout(d), "Layout1");
  assert.strictEqual(P.addLayout(d), "Layout2");
  assert.strictEqual(P.addLayout(d), "Layout3");
});

t("custom name is kept", () => {
  const d = doc();
  assert.strictEqual(P.addLayout(d, "Sheet A"), "Sheet A");
});

t("duplicate custom name is suffixed, never clobbered", () => {
  const d = doc();
  P.addLayout(d, "Sheet A");
  assert.strictEqual(P.addLayout(d, "Sheet A"), "Sheet A_2");
  // "sheet a_2" is already taken (case-insensitive), so the next suffix is _3.
  assert.strictEqual(P.addLayout(d, "sheet a"), "sheet a_3");
  assert.strictEqual(d.layouts.length, 3);
});

/* ── addLayout: default viewport ───────────────────────────────────── */

t("new layout carries exactly one viewport on an A3 sheet", () => {
  const d = doc();
  P.addLayout(d);
  const vp = d.layouts[0].viewports[0];
  assert.ok(vp, "expected a default viewport");
  assert.strictEqual(d.layouts[0].viewports.length, 1);
  // A3 portrait is 297 x 420 with a 10 mm margin.
  close(vp.width, 277);
  close(vp.height, 400);
  close(vp.center.x, 148.5);
  close(vp.center.y, 210);
});

t("viewport shows the caller's model view", () => {
  const d = doc();
  P.addLayout(d, undefined, { viewCenter: { x: 50, y: 25, z: 0 }, viewHeight: 220 });
  const vp = d.layouts[0].viewports[0];
  close(vp.viewCenter.x, 50);
  close(vp.viewCenter.y, 25);
  close(vp.viewHeight, 220);
});

t("viewport defaults to the origin at a 100-unit height", () => {
  const d = doc();
  P.addLayout(d);
  const vp = d.layouts[0].viewports[0];
  close(vp.viewCenter.x, 0);
  close(vp.viewCenter.y, 0);
  close(vp.viewHeight, 100);
});

t("non-positive viewHeight falls back to 100", () => {
  const d = doc();
  P.addLayout(d, undefined, { viewHeight: 0 });
  close(d.layouts[0].viewports[0].viewHeight, 100);
});

/* ── deleteLayout ──────────────────────────────────────────────────── */

t("deleteLayout removes by name and returns the deleted name", () => {
  const d = doc();
  P.addLayout(d, "Sheet A");
  P.addLayout(d, "Sheet B");
  assert.strictEqual(P.deleteLayout(d, "Sheet A"), "Sheet A");
  assert.strictEqual(d.layouts.length, 1);
  assert.strictEqual(d.layouts[0].name, "Sheet B");
});

t("deleteLayout matches names case-insensitively", () => {
  const d = doc();
  P.addLayout(d, "Sheet A");
  assert.strictEqual(P.deleteLayout(d, "sheet a"), "Sheet A");
  assert.strictEqual(d.layouts.length, 0);
});

t("deleteLayout removes by 1-based index", () => {
  const d = doc();
  P.addLayout(d, "Sheet A");
  P.addLayout(d, "Sheet B");
  P.addLayout(d, "Sheet C");
  assert.strictEqual(P.deleteLayout(d, 2), "Sheet B");
  assert.deepStrictEqual(d.layouts.map((l) => l.name), ["Sheet A", "Sheet C"]);
  assert.strictEqual(P.deleteLayout(d, "1"), "Sheet A");
  assert.deepStrictEqual(d.layouts.map((l) => l.name), ["Sheet C"]);
});

t("deleteLayout returns null for an unknown name or index", () => {
  const d = doc();
  P.addLayout(d, "Sheet A");
  assert.strictEqual(P.deleteLayout(d, "Nope"), null);
  assert.strictEqual(P.deleteLayout(d, 5), null);
  assert.strictEqual(P.deleteLayout(d, 0), null);
  assert.strictEqual(d.layouts.length, 1);
});

t("deleteLayout on a drawing with no layouts returns null", () => {
  const d = doc();
  assert.strictEqual(P.deleteLayout(d, "Layout1"), null);
});

t("deleteLayout keeps the surviving layouts' entities", () => {
  const d = doc();
  P.addLayout(d, "Sheet A");
  P.addLayout(d, "Sheet B");
  const keep = line(0, 0, 10, 0);
  d.layouts[1].entities.push(keep);
  P.deleteLayout(d, "Sheet A");
  assert.deepStrictEqual(d.layouts[0].entities, [keep]);
});

/* ── undo / redo list helpers: space-aware transforms ─────────────── */

t("undo of an add removes exactly the added entities", () => {
  const a = line(0, 0, 10, 0), b = line(0, 0, 0, 10), c = line(10, 0, 10, 10);
  const next = P.undoEntityList([a, b, c], { type: "add", entities: [c] });
  assert.deepStrictEqual(next, [a, b]);
});

t("redo of an add restores the added entities", () => {
  const a = line(0, 0, 10, 0), b = line(0, 0, 0, 10);
  const next = P.redoEntityList([a], { type: "add", entities: [b] });
  assert.deepStrictEqual(next, [a, b]);
});

t("undo of a delete restores the deleted entities", () => {
  const a = line(0, 0, 10, 0), b = line(0, 0, 0, 10);
  const next = P.undoEntityList([a], { type: "delete", entities: [b] });
  assert.deepStrictEqual(next, [a, b]);
});

t("redo of a delete removes the deleted entities again", () => {
  const a = line(0, 0, 10, 0), b = line(0, 0, 0, 10);
  const next = P.redoEntityList([a, b], { type: "delete", entities: [b] });
  assert.deepStrictEqual(next, [a]);
});

t("undo/redo of an order restores the captured paint order", () => {
  const a = line(0, 0, 10, 0), b = line(0, 0, 0, 10);
  const act = { type: "order", orderBefore: [a, b], orderAfter: [b, a] };
  assert.deepStrictEqual(P.redoEntityList([a, b], act), [b, a]);
  assert.deepStrictEqual(P.undoEntityList([b, a], act), [a, b]);
});

t("undo/redo of a replace swaps before/after sets", () => {
  const before = line(0, 0, 10, 0), after = line(0, 0, 5, 5), other = line(9, 9, 10, 10);
  const act = { type: "replace", before: [before], after: [after] };
  assert.deepStrictEqual(P.undoEntityList([after, other], act), [other, before]);
  assert.deepStrictEqual(P.redoEntityList([before, other], act), [other, after]);
});

t("modify leaves list membership alone (object-level)", () => {
  const a = line(0, 0, 10, 0);
  const act = { type: "modify", before: [a], after: [a] };
  assert.strictEqual(P.undoEntityList([a], act).length, 1);
  assert.strictEqual(P.redoEntityList([a], act).length, 1);
});

t("helpers never mutate the input list", () => {
  const a = line(0, 0, 10, 0), b = line(0, 0, 0, 10);
  const src = [a, b];
  P.undoEntityList(src, { type: "delete", entities: [b] });
  P.redoEntityList(src, { type: "add", entities: [b] });
  assert.deepStrictEqual(src, [a, b]);
});

/* ── source wiring in cad-viewer.ts ────────────────────────────────── */

t("activate() no longer wipes the view history", () => {
  assert.ok(!viewer.includes("history.length = 0"), "activate() must not clear history");
});

t("MODEL/PAPER status button has a click handler", () => {
  assert.ok(viewer.includes('querySelector("[data-s=space]")'), "expected a data-s=space handler");
  assert.ok(viewer.includes("toggleSpace()"), "expected toggleSpace() to be wired");
});

t("tab strip has a new-layout button", () => {
  assert.ok(viewer.includes("data-new-layout"), "expected a data-new-layout button in buildTabs");
  assert.ok(viewer.includes("createLayoutAndActivate"), "expected createLayoutAndActivate");
});

t("undo actions are stamped with their owning space", () => {
  assert.ok(viewer.includes("act.space = layoutI"), "pushUndoAct must stamp the space");
  assert.ok(viewer.includes("undoEntityList(list, act)"), "undo() must use the pure list helper");
  assert.ok(viewer.includes("redoEntityList(list, act)"), "redo() must use the pure list helper");
  assert.ok(
    viewer.includes("refreshOffscreenSpace(space, next)"),
    "undo/redo landing in another space must refresh that space's cached index",
  );
});

t("LAYOUT NEW creates and activates (not just creates)", () => {
  const i = viewer.indexOf('cmd === "LAYOUT"');
  assert.ok(i >= 0, "LAYOUT command missing");
  const block = viewer.slice(i, i + 1200);
  assert.ok(block.includes("createLayoutAndActivate"), "LAYOUT NEW must switch to the new layout");
});

t("LAYOUT DELETE is wired with confirm + toast + tab rebuild", () => {
  const i = viewer.indexOf('cmd === "LAYOUT"');
  assert.ok(i >= 0, "LAYOUT command missing");
  const block = viewer.slice(i, i + 1800);
  assert.ok(block.includes("DELETE"), "LAYOUT DELETE subcommand missing");
  assert.ok(block.includes("deleteLayoutAndActivate"), "LAYOUT DELETE must call deleteLayoutAndActivate");
  const fn = viewer.indexOf("async function deleteLayoutAndActivate");
  assert.ok(fn >= 0, "deleteLayoutAndActivate missing");
  const body = viewer.slice(fn, fn + 2600);
  assert.ok(body.includes("confirmDialog(") && body.includes('"Delete layout"'), "delete must confirm like other destructive actions");
  assert.ok(body.includes("AcadParity.deleteLayout"), "delete must use the pure helper");
  assert.ok(body.includes('cadToast("info"'), "delete must report through obs-toast");
  assert.ok(body.includes("buildTabs()"), "delete must rebuild the tab strip");
  assert.ok(body.includes("markDirty()"), "delete must mark the drawing dirty");
  assert.ok(body.includes("layoutIdxCache.clear()"), "delete must clear the shifted per-space index cache");
  assert.ok(body.includes("activate(-1)"), "deleting the current layout must step back to Model first");
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
