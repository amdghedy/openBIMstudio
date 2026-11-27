// Fence / lasso selection, Ctrl+click cycling, grip modes (AutoCAD parity A11) — node test.
//
// Proved fail-without-fix against the base: the module does not exist there,
// so the tsc step fails with TS6053 (module not found) before any assertion
// runs. The viewer wiring (DOM-heavy, cannot compile headlessly) is proved
// by source markers, the same pattern as the A7 suite.
//
// No mocks: the geometry, entity helpers, modify math and selection helpers
// under test are the shipped ones.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-selection-a11-"));
fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction");
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, a + "!=" + b);
const nearPt = (a, b, e = 1e-6) => { near(a.x, b.x, e); near(a.y, b.y, e); };
try {
  execSync(
    "npx tsc src/modules/cad-viewer/cad-selection-a11.ts src/modules/cad-viewer/viewer-math.ts " +
      "src/modules/cad-viewer/modify-math.ts src/modules/cad-viewer/cad-polyline.ts " +
      "src/modules/drawings/dxf-geometry.ts src/modules/drawings/dxf-reader.ts src/modules/drawings/dxf-writer.ts " +
      "src/modules/cad-viewer/cad-annotation.ts src/modules/cad-viewer/cad-2d-critical-gaps.ts src/modules/cad-viewer/fillet-chamfer.ts " +
      "--outDir " + out + " --module commonjs --target es2020 --skipLibCheck --esModuleInterop",
    { cwd: root, stdio: "pipe" },
  );
  const locate = (dir, name) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) { const found = locate(p, name); if (found) return found; }
      else if (entry.name === name) return p;
    }
    return null;
  };
  const S = require(locate(out, "cad-selection-a11.js"));
  const M = require(locate(out, "viewer-math.js"));

  const L = (x1, y1, x2, y2) => ({ type: "LINE", layer: "0", start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });
  const C = (x, y, r) => ({ type: "CIRCLE", layer: "0", center: { x, y }, radius: r });
  const P = (x, y) => ({ type: "POINT", layer: "0", position: { x, y } });
  const T = (x, y) => ({ type: "TEXT", layer: "0", position: { x, y }, value: "T", height: 10, rotation: 0 });
  const PL = (pts, extra = {}) => ({ type: "LWPOLYLINE", layer: "0", points: pts, closed: false, ...extra });
  const idxOf = (ents) => {
    let b = null;
    for (const e of ents) b = M.unionBBox(b, M.entityBBox(e));
    return M.buildIndex(ents, b ?? { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 });
  };

  // ── FENCE ──
  t("fence: crosses a line -> selected; misses it -> not", () => {
    const ents = [L(0, 0, 100, 0), L(0, 50, 100, 50)];
    const idx = idxOf(ents);
    assert.deepEqual(S.selectByFence(idx, ents, [{ x: 50, y: -10 }, { x: 50, y: 10 }]), [0]);
    assert.deepEqual(S.selectByFence(idx, ents, [{ x: 50, y: 60 }, { x: 50, y: 70 }]), []);
  });
  t("fence: fully enclosing a circle does NOT select it; crossing it does", () => {
    const ents = [C(50, 50, 10)];
    const idx = idxOf(ents);
    const around = [{ x: 30, y: 30 }, { x: 70, y: 30 }, { x: 70, y: 70 }, { x: 30, y: 70 }];
    assert.deepEqual(S.selectByFence(idx, ents, around), []);
    assert.deepEqual(S.selectByFence(idx, ents, [{ x: 0, y: 50 }, { x: 100, y: 50 }]), [0]);
  });
  t("fence: crosses a bulged arc crown, not its chord", () => {
    // Semicircle (0,0)-(200,0), bulge -1, crown at (100,100).
    const ents = [PL([{ x: 0, y: 0 }, { x: 200, y: 0 }], { bulges: [-1] })];
    const idx = idxOf(ents);
    // Fence through the crown (100,100): hits the arc, misses the chord y=0.
    assert.deepEqual(S.selectByFence(idx, ents, [{ x: 100, y: 90 }, { x: 100, y: 110 }]), [0]);
    // Fence along y=0 through the chord only: the arc is above it.
    assert.deepEqual(S.selectByFence(idx, ents, [{ x: 50, y: -10 }, { x: 150, y: -10 }]), []);
  });
  t("fence: fewer than 2 points selects nothing", () => {
    const ents = [L(0, 0, 10, 0)];
    assert.deepEqual(S.selectByFence(idxOf(ents), ents, [{ x: 5, y: 0 }]), []);
    assert.deepEqual(S.selectByFence(idxOf(ents), ents, []), []);
  });
  t("fence: infinite RAY crossed by the fence; parallel offset misses", () => {
    const ents = [{ type: "RAY", layer: "0", start: { x: 0, y: 0 }, direction: { x: 1, y: 0 } }];
    const idx = idxOf(ents);
    assert.deepEqual(S.selectByFence(idx, ents, [{ x: 50, y: -10 }, { x: 50, y: 10 }]), [0]);
    assert.deepEqual(S.selectByFence(idx, ents, [{ x: 50, y: 10 }, { x: 60, y: 10 }]), []);
  });
  t("fence: POINT within tolerance; TEXT crossed through its box", () => {
    const ents = [P(50, 50), T(100, 100)];
    const idx = idxOf(ents);
    assert.deepEqual(S.selectByFence(idx, ents, [{ x: 50, y: 40 }, { x: 50, y: 60 }], () => true, 0), [0]);
    assert.deepEqual(S.selectByFence(idx, ents, [{ x: 50, y: 40 }, { x: 50, y: 45 }], () => true, 0), []);
    // The TEXT box starts at its insertion point; a fence through its middle selects it.
    assert.deepEqual(S.selectByFence(idx, ents, [{ x: 103, y: 90 }, { x: 103, y: 120 }]), [1]);
  });
  t("fence: invisible entities are skipped", () => {
    const ents = [L(0, 0, 100, 0)];
    assert.deepEqual(S.selectByFence(idxOf(ents), ents, [{ x: 50, y: -10 }, { x: 50, y: 10 }], () => false), []);
  });

  // ── LASSO ──
  const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
  t("lasso window: fully inside selects; poking out does not", () => {
    const ents = [L(10, 10, 90, 90), L(10, 10, 150, 10)];
    const idx = idxOf(ents);
    assert.deepEqual(S.selectByLasso(idx, ents, square, "window"), [0]);
  });
  t("lasso crossing: poking out selects; fully outside does not", () => {
    const ents = [L(10, 10, 150, 10), L(200, 200, 300, 300)];
    const idx = idxOf(ents);
    assert.deepEqual(S.selectByLasso(idx, ents, square, "crossing"), [0]);
  });
  t("lasso: fewer than 3 points selects nothing", () => {
    const ents = [L(10, 10, 90, 90)];
    assert.deepEqual(S.selectByLasso(idxOf(ents), ents, [{ x: 0, y: 0 }, { x: 100, y: 0 }], "window"), []);
  });
  t("lasso window: circle fully inside selects; circle crossing the edge does not", () => {
    const ents = [C(50, 50, 10), C(100, 50, 20)];
    const idx = idxOf(ents);
    assert.deepEqual(S.selectByLasso(idx, ents, square, "window"), [0]);
    assert.deepEqual(S.selectByLasso(idx, ents, square, "crossing"), [0, 1]);
  });
  t("lasso crossing: POINT inside selects; POINT outside does not; RAY never window-selects", () => {
    const ents = [P(50, 50), P(200, 200), { type: "RAY", layer: "0", start: { x: 50, y: 50 }, direction: { x: 1, y: 0 } }];
    const idx = idxOf(ents);
    assert.deepEqual(S.selectByLasso(idx, ents, square, "crossing"), [0, 2]);
    assert.deepEqual(S.selectByLasso(idx, ents, square, "window"), [0]);
  });
  t("lassoModeFromPath: rightward first move -> window, leftward -> crossing", () => {
    assert.equal(S.lassoModeFromPath([{ x: 0, y: 0 }, { x: 10, y: 0 }], { x: 0, y: 0 }, 4), "window");
    assert.equal(S.lassoModeFromPath([{ x: 0, y: 0 }, { x: -10, y: 0 }], { x: 0, y: 0 }, 4), "crossing");
    assert.equal(S.lassoModeFromPath([{ x: 0, y: 0 }, { x: 1, y: 0 }], { x: 0, y: 0 }, 4), "window");
  });

  // ── Ctrl+click cycling ──
  t("cycleNext: first click takes the first candidate, repeats advance, wraps, new spot restarts", () => {
    const cands = [3, 7, 9];
    let r = S.cycleNext(cands, null, "500,300");
    assert.equal(r.index, 3);
    r = S.cycleNext(cands, r.state, "500,300");
    assert.equal(r.index, 7);
    r = S.cycleNext(cands, r.state, "500,300");
    assert.equal(r.index, 9);
    r = S.cycleNext(cands, r.state, "500,300");
    assert.equal(r.index, 3);
    r = S.cycleNext(cands, r.state, "510,300");
    assert.equal(r.index, 3);
    assert.equal(S.cycleNext([], null, "500,300"), null);
    // A changed candidate set restarts at the first candidate.
    const r2 = S.cycleNext([3, 7], { key: "500,300", candidates: [3, 7, 9], pos: 2 }, "500,300");
    assert.equal(r2.index, 3);
  });

  // ── grip modes ──
  t("nextGripMode cycles stretch -> move -> rotate -> scale -> mirror -> stretch", () => {
    assert.deepEqual(["stretch", "move", "rotate", "scale", "mirror"].map((m) => S.nextGripMode(m)),
      ["move", "rotate", "scale", "mirror", "stretch"]);
    assert.equal(S.GRIP_MODES.length, 5);
  });
  t("grip move: whole line follows the grip by (to - base)", () => {
    const e = L(0, 0, 10, 0);
    const r = S.applyGripMode(e, "move", { x: 0, y: 0 }, null, { x: 5, y: 5 }, 0);
    nearPt(r.entity.start, { x: 5, y: 5 });
    nearPt(r.entity.end, { x: 15, y: 5 });
  });
  t("grip rotate: first significant move captures the zero reference, later moves rotate about the grip", () => {
    const e = L(0, 0, 10, 0);
    const r1 = S.applyGripMode(e, "rotate", { x: 0, y: 0 }, null, { x: 10, y: 0 }, 0, 1);
    assert.ok(r1.ref !== null && Math.abs(r1.ref.angleDeg) < 1e-9, "ref angle should be 0");
    nearPt(r1.entity.end, { x: 10, y: 0 }); // no jump on capture
    const r2 = S.applyGripMode(e, "rotate", { x: 0, y: 0 }, r1.ref, { x: 0, y: 10 }, 0, 1);
    nearPt(r2.entity.end, { x: 0, y: 10 }); // 90 deg CCW about (0,0)
    assert.equal(S.gripRotateDeg(0, { x: 0, y: 0 }, { x: 0, y: 10 }), 90);
  });
  t("grip rotate: cursor still on the grip leaves the entity unchanged with no reference", () => {
    const e = L(0, 0, 10, 0);
    const r = S.applyGripMode(e, "rotate", { x: 0, y: 0 }, null, { x: 0.0001, y: 0 }, 0, 1);
    assert.equal(r.ref, null);
    nearPt(r.entity.end, { x: 10, y: 0 });
  });
  t("grip scale: factor is cursor distance over reference distance about the grip", () => {
    const e = L(0, 0, 10, 0);
    const r1 = S.applyGripMode(e, "scale", { x: 0, y: 0 }, null, { x: 10, y: 0 }, 0, 1);
    assert.ok(r1.ref !== null && Math.abs(r1.ref.dist - 10) < 1e-9);
    nearPt(r1.entity.end, { x: 10, y: 0 });
    const r2 = S.applyGripMode(e, "scale", { x: 0, y: 0 }, r1.ref, { x: 20, y: 0 }, 0, 1);
    nearPt(r2.entity.end, { x: 20, y: 0 });
    assert.equal(S.gripScaleFactor(10, { x: 0, y: 0 }, { x: 5, y: 0 }), 0.5);
  });
  t("grip mirror: across the line through the grip and the cursor", () => {
    const e = L(0, 0, 10, 0);
    const r = S.applyGripMode(e, "mirror", { x: 0, y: 0 }, null, { x: 0, y: 10 }, 0);
    nearPt(r.entity.start, { x: 0, y: 0 });
    nearPt(r.entity.end, { x: -10, y: 0 });
    const noop = S.applyGripMode(e, "mirror", { x: 0, y: 0 }, null, { x: 0, y: 0 }, 0);
    nearPt(noop.entity.end, { x: 10, y: 0 });
  });
  t("grip stretch: vertex grip moves the endpoint (existing behaviour)", () => {
    const e = L(0, 0, 10, 0);
    const r = S.applyGripMode(e, "stretch", { x: 0, y: 0 }, null, { x: 0, y: 10 }, 0);
    nearPt(r.entity.start, { x: 0, y: 10 });
    nearPt(r.entity.end, { x: 10, y: 0 });
  });
  t("captureGripRef: null while the cursor is still on the grip", () => {
    assert.equal(S.captureGripRef({ x: 0, y: 0 }, { x: 0.5, y: 0 }, 1), null);
    const r = S.captureGripRef({ x: 0, y: 0 }, { x: 3, y: 4 }, 1);
    assert.ok(r !== null && Math.abs(r.dist - 5) < 1e-9);
  });

  // ── viewer wiring (source markers — the viewer is DOM-heavy) ──
  const viewerSrc = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
  t("viewer: FENCE / LASSO commands registered", () => {
    assert.ok(/name: "FENCE", aliases: \["FE"\]/.test(viewerSrc), "FENCE command missing");
    assert.ok(/name: "LASSO"/.test(viewerSrc), "LASSO command missing");
  });
  t("viewer: FENCE / LASSO dispatch to tools", () => {
    assert.ok(/cmd === "FENCE"/.test(viewerSrc), "FENCE dispatch missing");
    assert.ok(/cmd === "LASSO"/.test(viewerSrc), "LASSO dispatch missing");
  });
  t("viewer: fence / lasso finishers wired to Enter, right-click and double-click", () => {
    assert.ok(/function finishFence/.test(viewerSrc), "finishFence missing");
    assert.ok(/function finishLasso/.test(viewerSrc), "finishLasso missing");
  });
  t("viewer: Ctrl+click cycling routes through cycleNext", () => {
    assert.ok(/cycleNext/.test(viewerSrc), "cycleNext not used in the viewer");
    assert.ok(/handleCycleClick/.test(viewerSrc), "handleCycleClick missing");
  });
  t("viewer: grip mode switch — Enter cycles, right-click menu offers the modes", () => {
    assert.ok(/function cycleGripMode/.test(viewerSrc), "cycleGripMode missing");
    assert.ok(/function showGripModeMenu/.test(viewerSrc), "showGripModeMenu missing");
    assert.ok(/applyGripMode/.test(viewerSrc), "applyGripMode not used in the viewer");
  });
  t("viewer: Fence / Lasso ribbon buttons exist", () => {
    assert.ok(/tb\("fence"/.test(viewerSrc), "fence ribbon button missing");
    assert.ok(/tb\("lasso"/.test(viewerSrc), "lasso ribbon button missing");
  });
  t("viewer (2D-32): selection count refreshes on selection change, not only on updateStatus()", () => {
    // The count span is a stable target, updated in place.
    assert.ok(/<span data-s="selcount">/.test(viewerSrc), "count span has no data-s=selcount marker");
    assert.ok(/function refreshSelCount\(\): void \{/.test(viewerSrc), "refreshSelCount missing");
    assert.ok(/const el = statusEl\.querySelector<HTMLElement>\("\[data-s=selcount\]"\)/.test(viewerSrc), "refresh targets the selcount span");
    assert.ok(/el\.textContent = sel\.size \? sel\.size \+ " selected" : ""/.test(viewerSrc), "refresh writes the count text");
    // showProps() is the funnel every selection-mutating path reaches.
    const showProps = viewerSrc.slice(viewerSrc.indexOf("function showProps() {"));
    assert.ok(showProps.startsWith("function showProps() {\n    // 2D-32"), "showProps does not refresh the count first");
    // The two paths that mutate sel without showProps() refresh directly.
    assert.ok(/refreshSelCount\(\); \/\/ 2D-32: deleteLayerByName does not call showProps\(\)/.test(viewerSrc), "deleteLayerByName does not refresh the count");
    assert.ok(/refreshSelCount\(\); \/\/ 2D-32: the lock-toggle call sites do not call showProps\(\)/.test(viewerSrc), "pruneLockedFromSel does not refresh the count");
    // The command handlers that mutate sel directly (no setSel, no
    // showProps) refresh at the mutation site — eight dispatch sites,
    // plus GROUP, whose selection recall lives in groupCmd().
    for (const cmd of ["LAYSEL", "TYPESEL", "CLRSEL", "SELECTALL", "SELBYLAYER", "ERASEOUT", "XPLODEPL", "AUDITZL"]) {
      const i = viewerSrc.indexOf(`cmd === "${cmd}"`);
      assert.ok(i >= 0, `${cmd} handler missing`);
      const block = viewerSrc.slice(i, i + 1200);
      assert.ok(block.includes("refreshSelCount(); // 2D-32"), `${cmd} does not refresh the count`);
    }
    const groupCmd = viewerSrc.slice(viewerSrc.indexOf("function groupCmd("));
    assert.ok(groupCmd.includes("refreshSelCount(); // 2D-32"), "groupCmd recall does not refresh the count");
    // The full-bar rebuild still renders the same count, so the two paths agree.
    assert.ok(/<span data-s="selcount">\$\{sel\.size \? sel\.size \+ " selected" : ""\}<\/span>/.test(viewerSrc), "full render and refresh disagree on the count text");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error("SETUP FAILED: " + (e && e.message));
  if (e && e.stdout) console.error(String(e.stdout).slice(-4000));
  if (e && e.stderr) console.error(String(e.stderr).slice(-4000));
  process.exit(1);
}
