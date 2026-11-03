#!/usr/bin/env node
/**
 * Ribbon collapse + full-screen focus mode.
 *
 * 1. Double-click a ribbon tab (Home / Annotate / View / …) must collapse the
 *    strip so only the tab buttons remain. The gesture is delegated on the
 *    persistent tabs row because renderTabs() rebuilds every button on each
 *    click — a rebuilt button never receives the browser's dblclick. The
 *    decision logic lives in src/shell/ribbon-collapse.ts and is EXECUTED here.
 * 2. Full screen (F11 / CAD full-screen button) must hide all command chrome
 *    (ribbon + status bar) and restore it on exit (body.obs-fullscreen + CSS).
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "rc-"));
execSync(`npx tsc src/shell/ribbon-collapse.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
const m = require(path.join(out, "ribbon-collapse.js"));
let n = 0; const ok = (c, s) => { assert.ok(c, s); n++; };

const rootDir = path.join(__dirname, "..");
const ribbonSrc = fs.readFileSync(path.join(rootDir, "src/shell/ribbon.ts"), "utf8");
const fsChromeSrc = fs.readFileSync(path.join(rootDir, "src/shell/fullscreen-chrome.ts"), "utf8");
const shellSrc = fs.readFileSync(path.join(rootDir, "src/shell/shell.ts"), "utf8");
const cssSrc = fs.readFileSync(path.join(rootDir, "src/style.css"), "utf8");

/* ── 1. gesture decision matrix (executed) ─────────────────────────────── */
// expanded + double-click on the open tab → collapse
ok(m.resolveDblClick({ minimized: false, lastAutoExpandAt: 0, now: 10_000, onTab: true }).minimize === true,
  "expanded + dblclick on tab → minimize");
// expanded + double-click on the empty tabs row → collapse
ok(m.resolveDblClick({ minimized: false, lastAutoExpandAt: 0, now: 10_000, onTab: false }).minimize === true,
  "expanded + dblclick on empty row → minimize");
// minimized + single click auto-expanded 100ms ago + dblclick lands → same gesture, stays expanded
const grace = m.resolveDblClick({ minimized: false, lastAutoExpandAt: 10_000, now: 10_100, onTab: true });
ok(grace.minimize === false, "dblclick right after auto-expand does not re-collapse");
ok(grace.lastAutoExpandAt === 0, "grace window is consumed after swallowing");
// minimized + dblclick on the empty row within the grace window → still toggles (expand)
ok(m.resolveDblClick({ minimized: true, lastAutoExpandAt: 10_000, now: 10_100, onTab: false }).minimize === false,
  "empty-row dblclick is never swallowed → toggles");
// dblclick AFTER the grace window → normal toggle
ok(m.resolveDblClick({ minimized: false, lastAutoExpandAt: 10_000, now: 10_000 + m.AUTO_EXPAND_GRACE_MS, onTab: true }).minimize === true,
  "grace window boundary (>="
  + " AUTO_EXPAND_GRACE_MS) → normal toggle");
ok(m.resolveDblClick({ minimized: true, lastAutoExpandAt: 0, now: 60_000, onTab: true }).minimize === false,
  "minimized + dblclick on tab without auto-expand → expands");
// bookkeeping: untouched path passes lastAutoExpandAt through
ok(m.resolveDblClick({ minimized: true, lastAutoExpandAt: 777, now: 60_000, onTab: false }).lastAutoExpandAt === 777,
  "non-grace path preserves lastAutoExpandAt");

/* ── 2. fullscreen chrome decision (executed) ──────────────────────────── */
ok(m.fullscreenChromeActive(null) === false, "no fullscreen element → chrome stays");
ok(m.fullscreenChromeActive({}) === true, "any fullscreen element → hide chrome");

/* ── 3. ribbon wiring (source pins) ────────────────────────────────────── */
ok(ribbonSrc.includes(`tabsRow.addEventListener("dblclick"`),
  "dblclick is delegated on the persistent tabs row (survives renderTabs rebuilds)");
ok(!ribbonSrc.includes("btn.ondblclick"), "per-button ondblclick removed (would double-toggle)");
ok(!ribbonSrc.includes("tabsRow.ondblclick"), "row ondblclick property removed (would double-toggle)");
ok(ribbonSrc.includes("activeTab === t.id && !ribbonMinimized) return"),
  "re-clicking the active tab does not rebuild the tabs row (keeps dblclick alive)");
ok((ribbonSrc.match(/lastAutoExpandAt = Date\.now\(\)/g) || []).length >= 2,
  "auto-expands (tab click + contextual tab) stamp the grace timestamp");
ok(ribbonSrc.includes(`from "./ribbon-collapse"`), "ribbon uses the shared gesture logic");
ok(ribbonSrc.includes('"obs.ribbon.minimized"'), "minimize state still persisted");
ok(/applyRibbonMinimize[\s\S]*?window\.dispatchEvent\(new Event\("resize"\)\)/.test(ribbonSrc),
  "minimize/restore refits the viewers via resize events");

/* ── 4. fullscreen chrome wiring (source pins) ─────────────────────────── */
ok(fsChromeSrc.includes('"fullscreenchange"') && fsChromeSrc.includes('"webkitfullscreenchange"'),
  "listens to standard + legacy webkit fullscreenchange");
ok(fsChromeSrc.includes("document.body.classList.toggle(FULLSCREEN_CLASS"), "toggles the body class");
ok(fsChromeSrc.includes("fullscreenChromeActive("), "uses the pure decision helper");
ok(/Event\("resize"\)/.test(fsChromeSrc) && fsChromeSrc.includes("obs-ribbon-resize"),
  "fullscreen change refits the viewers via resize events");
ok(shellSrc.includes("setupFullscreenChrome()"), "shell wires the fullscreen chrome");
ok(cssSrc.includes("body.obs-fullscreen .obs-ribbon") && cssSrc.includes("body.obs-fullscreen .bb-status"),
  "CSS hides ribbon AND status bar in full-screen mode");

console.log(`ribbon-collapse: ${n} checks OK`);
