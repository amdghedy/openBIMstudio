#!/usr/bin/env node
/**
 * Plan dockable + live-sync — Revit 2D environment audit gap G12.
 *
 * Pins the two reachable G12 subsets (audit §2 G12, §3 item 11). Full
 * unification is explicitly out of scope: the plan stays an SVG projection
 * regenerated from the model, not a live view of the Three.js scene.
 *
 * (a) Dockable plan — src/modules/views/plan-dock.ts is a pure, DOM-free
 *     layout model. Modal keeps the full-width overlay and zero viewport
 *     margin (pre-G12 behaviour); docked-right pins the panel to the right
 *     edge and reserves the same width as a right margin on the 3D
 *     viewport host, so 3D resizes to share the screen; docked-bottom pins
 *     it to the bottom edge with a bottom margin. Width/height clamp to
 *     usable bounds.
 * (b) Live-sync — src/modules/views/plan-live-sync.ts is a DOM-free
 *     debounced coalescer. Rapid successive model changes schedule exactly
 *     one regeneration; a change that arrives while a regeneration is
 *     running is remembered as one follow-up (previously the panel
 *     returned early on `generating` and dropped it); and the model-change
 *     event actually fires for element creation — `createElement` in
 *     src/features/authoring.ts notifies after its history command, which
 *     it previously never did, so adding a wall in 3D reached no listener
 *     at all (history.exec dispatches no obs-history and no authoring
 *     notification).
 *
 * Two layers, same style as tests/project-browser-g11.test.cjs:
 *  1. The models are EXECUTED: both modules are compiled with tsc and
 *     required here.
 *  2. Source pins prove src/features/plan-view-panel.ts wires the models
 *     into the real panel (dock buttons, viewport margin, renderer pause
 *     only in modal mode, live-sync subscription) and that authoring.ts
 *     notifies on element creation.
 *
 * Sensitivity: on the pre-G12 tree this fails — there is no plan-dock.ts
 * or plan-live-sync.ts to compile, the plan has no dock button and no
 * viewport margin, the 3D renderer is paused whenever the plan is open,
 * the live-sync handler drops changes made mid-regeneration, and
 * createElement never calls notifyAuthoringChange.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const os = require("os");

const ROOT = path.join(__dirname, "..");
let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  PASS " + name); } catch (e) { console.log("  FAIL " + name + ": " + e.message); throw e; } };
const ta = async (name, fn) => { try { await fn(); pass++; console.log("  PASS " + name); } catch (e) { console.log("  FAIL " + name + ": " + e.message); throw e; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 1. Execute the models ─────────────────────────────────────────────── */
const out = fs.mkdtempSync(path.join(os.tmpdir(), "g12-"));
execSync(
  `npx tsc src/modules/views/plan-dock.ts src/modules/views/plan-live-sync.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`,
  { stdio: "pipe", cwd: ROOT },
);
const dock = require(path.join(out, "plan-dock.js"));
const { PlanLiveSync } = require(path.join(out, "plan-live-sync.js"));

(async () => {
  /* ── (a) Dock state transitions ──────────────────────────────────────── */
  t("modal is the default / fallback for unknown stored values", () => {
    assert.strictEqual(dock.parsePlanDockMode(undefined), "modal");
    assert.strictEqual(dock.parsePlanDockMode("tiled"), "modal");
    assert.strictEqual(dock.parsePlanDockMode("docked-right"), "docked-right");
    assert.strictEqual(dock.parsePlanDockMode("docked-bottom"), "docked-bottom");
  });
  t("Dock button toggles modal <-> docked-right, never straight to bottom", () => {
    assert.strictEqual(dock.togglePlanDockMode("modal"), "docked-right");
    assert.strictEqual(dock.togglePlanDockMode("docked-right"), "modal");
    assert.strictEqual(dock.togglePlanDockMode("docked-bottom"), "modal");
  });
  t("side button switches right <-> bottom and leaves modal alone", () => {
    assert.strictEqual(dock.togglePlanDockSide("docked-right"), "docked-bottom");
    assert.strictEqual(dock.togglePlanDockSide("docked-bottom"), "docked-right");
    assert.strictEqual(dock.togglePlanDockSide("modal"), "modal");
  });
  t("toggle labels name the action (Dock / Undock)", () => {
    assert.strictEqual(dock.planDockToggleLabel("modal"), "Dock");
    assert.strictEqual(dock.planDockToggleLabel("docked-right"), "Undock");
    assert.strictEqual(dock.planDockToggleLabel("docked-bottom"), "Undock");
  });

  /* ── (a) Layout reservation ──────────────────────────────────────────── */
  t("modal: full-width overlay, zero viewport margin", () => {
    const g = dock.computePlanDockLayout("modal", { width: 1600, height: 900 }, 88);
    assert.deepStrictEqual(g.overlay, { left: 0, right: 0, top: 88, bottom: 0, width: null, height: null });
    assert.deepStrictEqual(g.viewportMargin, { right: 0, bottom: 0 });
    assert.strictEqual(g.dockSizePx, 0);
  });
  t("docked-right: panel on the right edge, 3D keeps the same right margin", () => {
    const g = dock.computePlanDockLayout("docked-right", { width: 1600, height: 900 }, 88);
    assert.strictEqual(g.overlay.width, 560);
    assert.strictEqual(g.overlay.right, 0);
    assert.strictEqual(g.overlay.left, null);
    assert.strictEqual(g.overlay.top, 88);
    assert.strictEqual(g.overlay.bottom, 0);
    assert.deepStrictEqual(g.viewportMargin, { right: 560, bottom: 0 });
    assert.strictEqual(g.dockSizePx, 560);
  });
  t("docked-right: width clamps to half the viewport on narrow screens", () => {
    const g = dock.computePlanDockLayout("docked-right", { width: 800, height: 900 }, 88);
    assert.strictEqual(g.overlay.width, 400);
    assert.strictEqual(g.viewportMargin.right, 400);
    const wide = dock.computePlanDockLayout("docked-right", { width: 3000, height: 900 }, 88, 2000);
    assert.strictEqual(wide.overlay.width, 1500); // 50% cap, not the 2000 requested
  });
  t("docked-right: width never drops below the usable minimum", () => {
    const g = dock.computePlanDockLayout("docked-right", { width: 1600, height: 900 }, 88, 100);
    assert.strictEqual(g.overlay.width, 320);
  });
  t("docked-bottom: panel on the bottom edge, 3D keeps the same bottom margin", () => {
    const g = dock.computePlanDockLayout("docked-bottom", { width: 1600, height: 900 }, 88);
    assert.strictEqual(g.overlay.height, 405); // 45% of 900
    assert.strictEqual(g.overlay.left, 0);
    assert.strictEqual(g.overlay.right, 0);
    assert.strictEqual(g.overlay.bottom, 0);
    assert.strictEqual(g.overlay.top, null);
    assert.deepStrictEqual(g.viewportMargin, { right: 0, bottom: 405 });
    assert.strictEqual(g.dockSizePx, 405);
  });
  t("docked-bottom: height clamps to 60% of the viewport", () => {
    const g = dock.computePlanDockLayout("docked-bottom", { width: 1600, height: 900 }, 88, 560, 900);
    assert.strictEqual(g.overlay.height, 540);
    assert.strictEqual(g.viewportMargin.bottom, 540);
  });
  t("ribbon height is honoured (minimized ribbon keeps a 28px floor)", () => {
    const g = dock.computePlanDockLayout("modal", { width: 1600, height: 900 }, 32);
    assert.strictEqual(g.overlay.top, 32);
    const flat = dock.computePlanDockLayout("modal", { width: 1600, height: 900 }, 0);
    assert.strictEqual(flat.overlay.top, 28);
  });

  /* ── (b) Live-sync: debounce / coalesce ──────────────────────────────── */
  await ta("rapid successive changes coalesce into one regeneration", async () => {
    let calls = 0;
    const sync = new PlanLiveSync({ delayMs: 15, onRegenerate: () => { calls++; } });
    sync.notify(); sync.notify(); sync.notify(); sync.notify(); sync.notify();
    assert.strictEqual(sync.pending, true);
    await sleep(60);
    assert.strictEqual(calls, 1);
    assert.strictEqual(sync.pending, false);
  });
  await ta("changes separated by the debounce window regenerate twice", async () => {
    let calls = 0;
    const sync = new PlanLiveSync({ delayMs: 15, onRegenerate: () => { calls++; } });
    sync.notify();
    await sleep(60);
    sync.notify();
    await sleep(60);
    assert.strictEqual(calls, 2);
  });
  await ta("flush fires a pending regeneration immediately", async () => {
    let calls = 0;
    const sync = new PlanLiveSync({ delayMs: 1000, onRegenerate: () => { calls++; } });
    sync.notify();
    assert.strictEqual(sync.pending, true);
    sync.flush();
    assert.strictEqual(calls, 1);
    assert.strictEqual(sync.pending, false);
    await sleep(30);
    assert.strictEqual(calls, 1);
  });
  await ta("cancel drops a pending regeneration", async () => {
    let calls = 0;
    const sync = new PlanLiveSync({ delayMs: 15, onRegenerate: () => { calls++; } });
    sync.notify();
    sync.cancel();
    await sleep(60);
    assert.strictEqual(calls, 0);
  });

  /* ── (b) Live-sync: no dropped changes while a regeneration runs ─────── */
  await ta("a change during regeneration queues exactly one follow-up", async () => {
    let calls = 0;
    let busy = false;
    const sync = new PlanLiveSync({ delayMs: 15, isBusy: () => busy, onRegenerate: () => { calls++; } });
    busy = true; // a regeneration is running
    sync.notify(); sync.notify(); // two edits mid-regeneration
    assert.strictEqual(calls, 0);
    assert.strictEqual(sync.queued, true);
    await sleep(60);
    assert.strictEqual(calls, 0, "nothing fires while busy");
    busy = false;
    sync.markIdle();
    assert.strictEqual(calls, 1, "exactly one follow-up, not one per edit");
    assert.strictEqual(sync.queued, false);
    await sleep(60);
    assert.strictEqual(calls, 1);
  });
  await ta("markIdle with nothing queued is a no-op", async () => {
    let calls = 0;
    const sync = new PlanLiveSync({ delayMs: 15, onRegenerate: () => { calls++; } });
    sync.markIdle();
    await sleep(40);
    assert.strictEqual(calls, 0);
  });
  await ta("a change after the follow-up fires debounces normally", async () => {
    let calls = 0;
    let busy = false;
    const sync = new PlanLiveSync({ delayMs: 15, isBusy: () => busy, onRegenerate: () => { calls++; } });
    busy = true;
    sync.notify();
    busy = false;
    sync.markIdle();
    assert.strictEqual(calls, 1);
    sync.notify();
    await sleep(60);
    assert.strictEqual(calls, 2);
  });

  /* ── 2. Source pins: the panel actually wires the models ─────────────── */
  const panel = fs.readFileSync(path.join(ROOT, "src/features/plan-view-panel.ts"), "utf8");
  const authoring = fs.readFileSync(path.join(ROOT, "src/features/authoring.ts"), "utf8");
  t("panel imports the dock model and the live-sync coalescer", () => {
    assert.ok(panel.includes('from "../modules/views/plan-dock"'), "plan-dock import");
    assert.ok(panel.includes('from "../modules/views/plan-live-sync"'), "plan-live-sync import");
  });
  t("panel has a Dock toggle button and a side button (stable test hooks)", () => {
    assert.ok(panel.includes("data-obs-plan-dock"), "dock button hook");
    assert.ok(panel.includes("data-obs-plan-dock-side"), "side button hook");
    assert.ok(panel.includes("computePlanDockLayout"), "layout applied from the model");
    assert.ok(panel.includes("togglePlanDockMode"), "dock toggle from the model");
  });
  t("panel reserves viewport space for the docked plan (margin, not overlay)", () => {
    assert.ok(panel.includes("marginRight"), "right margin for docked-right");
    assert.ok(panel.includes("marginBottom"), "bottom margin for docked-bottom");
    // The viewport host carries height:100%, which defeats a bottom margin
    // on the flex cross axis — the panel must also shrink its height, and
    // it must measure from the host's real top (a percentage resolves
    // against the middle workspace row, which stops at the status bar,
    // while the docked overlay runs to the viewport bottom).
    assert.ok(panel.includes("window.innerHeight - hostTop"), "explicit measured height for docked-bottom");
  });
  t("panel pauses the 3D renderer only in modal mode (docked 3D stays live)", () => {
    assert.ok(panel.includes("updatePlanRendererPause"), "pause helper exists");
    assert.ok(panel.includes('planDockMode === "modal"'), "pause gated on modal mode");
  });
  t("panel feeds model changes through the live-sync coalescer", () => {
    assert.ok(panel.includes("planLiveSync.notify()"), "live-sync notified on change");
    assert.ok(panel.includes("planLiveSync.markIdle()"), "follow-up fired when a regen finishes");
    assert.ok(panel.includes("onAuthoringChange"), "authoring-change subscription kept");
  });
  t("createElement notifies after its history command (wall add reaches listeners)", () => {
    // Inside createElement: history.exec closes, then notify, then return.
    // (history.exec dispatches no obs-history and no authoring notification,
    // so without this a wall added in 3D never reached the plan's live sync.)
    const start = authoring.indexOf("async function createElement(");
    assert.ok(start >= 0, "createElement found");
    const body = authoring.slice(start, authoring.indexOf("\n  return el;", start));
    assert.ok(body.includes("await history.exec({"), "createElement records via history.exec");
    assert.ok(body.includes("notifyAuthoringChange();"), "createElement notifies after history.exec");
  });
  t("panel exposes the dock mode on ctx.features.planView", () => {
    assert.ok(panel.includes("dockMode:"), "dockMode getter on the feature API");
    assert.ok(panel.includes("setDockMode:"), "setDockMode on the feature API");
  });

  console.log(`\nplan-dock-live-sync-g12: ${pass} assertions passed`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
