#!/usr/bin/env node
// AutoCAD-parity batch: saved-view twist honouring (View.rot), rot-aware
// pan/cull/draw math, UCS display toggle, and the NEW/GROUP/LIMITS/QDIM
// commands. Math runs against the compiled viewer-math; wiring is gated
// statically over src/features/cad-viewer.ts.
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const loaded = {};
function loadTsc(rel, exported) {
  if (!loaded[rel]) {
    const { execSync } = require("child_process");
    const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "parity-"));
    execSync(`npx tsc ${rel} --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
    const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
    loaded[rel] = require(find(out, path.basename(rel).replace(/\.ts$/, ".js")));
  }
  return exported ? loaded[rel][exported] : loaded[rel];
}

const src = fs.readFileSync(path.join(__dirname, "..", "src", "features", "cad-viewer.ts"), "utf8");
let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; console.log("  PASS " + name); }
  catch (e) { fail++; console.log("  FAIL " + name + ": " + e.message); }
};

/* ── rot-aware view math ────────────────────────────────────────────── */

t("panBy at rot=0 keeps the legacy drag mapping", () => {
  const M = loadTsc("src/modules/cad-viewer/viewer-math.ts");
  const v = { cx: 0, cy: 0, scale: 2, w: 800, h: 600 };
  const v2 = M.panBy(v, 100, 0);
  assert.ok(Math.abs(v2.cx + 50) < 1e-9 && Math.abs(v2.cy) < 1e-9, JSON.stringify(v2));
});

t("panBy un-rotates the drag: a rotated view pans where the pointer goes", () => {
  const M = loadTsc("src/modules/cad-viewer/viewer-math.ts");
  const v = { cx: 0, cy: 0, scale: 1, w: 800, h: 600, rot: 90 };
  const v2 = M.panBy(v, 100, 0);
  // With rot=90°, dragging right moves the centre toward world +y so the
  // content follows the pointer.
  assert.ok(Math.abs(v2.cx) < 1e-9, `cx=${v2.cx}`);
  assert.ok(Math.abs(v2.cy - 100) < 1e-9, `cy=${v2.cy}`);
});

t("panBy moves the old centre by exactly the drag vector on screen", () => {
  const M = loadTsc("src/modules/cad-viewer/viewer-math.ts");
  for (const rot of [-137.5, -40, 17, 203]) {
    const v = { cx: 12.5, cy: -3.25, scale: 0.7, w: 1440, h: 900, rot };
    const before = M.worldToScreen(v, v.cx, v.cy);
    const v2 = M.panBy(v, 60, -25);
    const after = M.worldToScreen(v2, v.cx, v.cy);
    assert.ok(Math.abs(after.x - before.x - 60) < 1e-6, `rot ${rot}: dx=${after.x - before.x}`);
    assert.ok(Math.abs(after.y - before.y + 25) < 1e-6, `rot ${rot}: dy=${after.y - before.y}`);
  }
});

t("bboxVisible sees content in a rotated frustum that 2-corner culling misses", () => {
  const M = loadTsc("src/modules/cad-viewer/viewer-math.ts");
  const v = { cx: 0, cy: 0, scale: 1, w: 800, h: 600, rot: 45 };
  const probe = { minX: 200, minY: 0, maxX: 210, maxY: 10 };
  assert.ok(M.bboxVisible(probe, v), "4-corner must include the rotated-corner content");
  const far = { minX: 1e6, minY: 1e6, maxX: 1e6 + 5, maxY: 1e6 + 5 };
  assert.ok(!M.bboxVisible(far, v), "distant content must stay culled");
});

t("worldToScreen/screenToWorld round-trip under arbitrary rot", () => {
  const M = loadTsc("src/modules/cad-viewer/viewer-math.ts");
  for (const rot of [-137.5, 45, 203]) {
    const v = { cx: 1234.5, cy: -987.25, scale: 0.37, w: 1440, h: 900, rot };
    for (const [x, y] of [[0, 0], [584247.8, -423740.16]]) {
      const s = M.worldToScreen(v, x, y);
      const w2 = M.screenToWorld(v, s.x, s.y);
      assert.ok(Math.abs(w2.x - x) < 1e-6 * Math.max(1, Math.abs(x)), `rot ${rot}: x ${w2.x} vs ${x}`);
      assert.ok(Math.abs(w2.y - y) < 1e-6 * Math.max(1, Math.abs(y)), `rot ${rot}: y ${w2.y} vs ${y}`);
    }
  }
});

/* ── saved view twist is honoured, not discarded ────────────────────── */

t("savedViewToView maps the saved twist onto View.rot (no more rejection)", () => {
  const M = loadTsc("src/modules/cad-viewer/viewer-math.ts");
  const sv = { cx: 100, cy: 200, height: 50, twist: -39.84 };
  const v = M.savedViewToView(sv, { minX: 0, minY: 0, maxX: 400, maxY: 400 }, 800, 600);
  assert.ok(v, "a valid twisted saved view must not be rejected");
  assert.ok(Math.abs(v.rot - (-39.84)) < 1e-9, `rot=${v.rot}`);
  assert.ok(Math.abs(v.scale - 600 / 50) < 1e-9, `scale=${v.scale}`);
});

t("savedViewToView normalises twist to (-180, 180]", () => {
  const M = loadTsc("src/modules/cad-viewer/viewer-math.ts");
  const v = M.savedViewToView({ cx: 0, cy: 0, height: 10, twist: -200 }, { minX: -50, minY: -50, maxX: 50, maxY: 50 }, 800, 600);
  assert.ok(Math.abs(v.rot - 160) < 1e-9, `rot=${v.rot}`);
});

t("applyTwist=false restores centre/height only (raw coordinates)", () => {
  const M = loadTsc("src/modules/cad-viewer/viewer-math.ts");
  const v = M.savedViewToView({ cx: 0, cy: 0, height: 10, twist: 30 }, { minX: -50, minY: -50, maxX: 50, maxY: 50 }, 800, 600, false);
  assert.ok(v && v.rot === undefined, `rot should be absent, got ${v && v.rot}`);
});

t("stale-default guards still reject nonsense saved views", () => {
  const M = loadTsc("src/modules/cad-viewer/viewer-math.ts");
  const b = { minX: -50, minY: -50, maxX: 50, maxY: 50 };
  assert.strictEqual(M.savedViewToView({ cx: 0, cy: 0, height: 0 }, b, 800, 600), null);
  assert.strictEqual(M.savedViewToView({ cx: 1e9, cy: 1e9, height: 10 }, b, 800, 600), null);
  assert.strictEqual(M.savedViewToView(undefined, b, 800, 600), null);
});

/* ── cad-viewer wiring ──────────────────────────────────────────────── */

t("UCSVIEW/UCSV route toggles the display via setUcs", () => {
  assert(/cmd === "UCSVIEW" \|\| cmd === "UCSV"\) \{ setUcs\(!ucsActive\); return; \}/.test(src), "UCSVIEW route missing");
});

t("UCS display defaults ON and persists the user's choice", () => {
  assert(/let ucsActive = true;/.test(src), "must default to ON");
  assert(/obs\.cad\.ucs/.test(src), "localStorage persistence missing");
});

t("upstream's UCS placement command is untouched", () => {
  assert(/cmd === "UCS"\)/.test(src), "UCS placement route missing");
});

t("setUcs applies/removes the saved twist live and syncs the ribbon", () => {
  const m = src.match(/function setUcs\(on: boolean\): void \{[\s\S]*?\n  \}/);
  assert.ok(m, "setUcs not found");
  const body = m[0];
  assert(body.includes("next.rot = savedTwist"), "ON must apply the saved twist");
  assert(body.includes("delete next.rot"), "OFF must remove the rotation");
  assert(body.includes('classList.toggle("on", ucsActive)'), "ribbon sync missing");
});

t("tray exposes a UCS button with a delegated listener", () => {
  assert(/data-s="ucsview"/.test(src), "tray UCS button missing");
  assert(/closest\("\[data-s=ucsview\]"\)/.test(src), "delegated tray listener missing");
});

t("ribbon exposes the UCS display option", () => {
  assert(/rb\("rotate", "UCS", `data-a="ucsview"`/.test(src), "ribbon UCS button missing");
});

t("loading a drawing honours the toggle and logs the OFF hint", () => {
  assert(/M\.savedViewToView\(doc\.savedView, modelBounds, view\.w, view\.h, ucsActive\)/.test(src), "restore must pass ucsActive");
  assert(/NOT applied \(UCS display is OFF — run UCSVIEW to apply it\)/.test(src), "OFF hint missing");
});

t("ARC and TEXT drawing compensate the view rotation", () => {
  assert(/s = \(-e\.startAngle \* Math\.PI\) \/ 180 - \(\(v\.rot \?\? 0\) \* Math\.PI\) \/ 180;/.test(src), "ARC rot compensation missing");
  assert(/c\.rotate\(\(-\(e\.rotation \?\? 0\) \* Math\.PI\) \/ 180 - \(\(v\.rot \?\? 0\) \* Math\.PI\) \/ 180\);/.test(src), "TEXT rot compensation missing");
});

t("culling samples all four screen corners", () => {
  assert(/M\.screenToWorld\(v, v\.w, 0\)/.test(src), "4-corner visibleBox missing");
});

t("NEW starts a blank drawing (doc reset + startBlank + fit)", () => {
  assert(/cmd === "NEW"\) \{ newDrawing\(\); return; \}/.test(src), "NEW route missing");
  const m = src.match(/function newDrawing\(\): void \{[\s\S]*?\n  \}/);
  assert.ok(m && m[0].includes("startBlank()") && m[0].includes("doc = null;"), "newDrawing must reset the document");
});

t("GROUP creates, lists and recalls named selection groups", () => {
  assert(/cmd === "GROUP"\) \{ groupCmd\(parts\.slice\(1\)\); return; \}/.test(src), "GROUP route missing");
  const m = src.match(/function groupCmd\(args: string\[\]\): void \{[\s\S]*?\n  \}/);
  assert.ok(m && m[0].includes("namedGroups.set(") && m[0].includes("namedGroups.get("), "group store missing");
});

t("LIMITS sets and reports the limits rectangle", () => {
  assert(/cmd === "LIMITS"\) \{ limitsCmd\(parts\.slice\(1\)\); return; \}/.test(src), "LIMITS route missing");
  assert(/drawingLimits = \{ minX: Math\.min\(/.test(src), "limits assignment missing");
});

t("QDIM creates aligned dimensions through the standard record path", () => {
  assert(/cmd === "QDIM"\) \{ qdim\(\); return; \}/.test(src), "QDIM route missing");
  const m = src.match(/function qdim\(\): void \{[\s\S]*?\n  \}/);
  assert.ok(m && m[0].includes('mode: "aligned"') && m[0].includes("commitDimRecord(rec)"), "QDIM must use commitDimRecord");
});

t("new commands are registered in the catalog", () => {
  for (const n of ["NEW", "GROUP", "LIMITS", "QDIM", "UCSVIEW"]) {
    assert(new RegExp(`\\{\\s*name:\\s*"${n}"`).test(src), `registry entry ${n} missing`);
  }
});

async function main() {
  console.log(`=== autocad-parity: ${pass} passed, ${fail} failed ===`);
  process.exitCode = fail ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
