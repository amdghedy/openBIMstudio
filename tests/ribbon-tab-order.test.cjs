#!/usr/bin/env node
/**
 * Ribbon tab order — Revit 2D environment audit gap G1a + AutoCAD parity A12.
 *
 * Pins the ribbon to Revit tab order: Home (A12 default tab), File,
 * Architecture, Structure, Systems (Mechanical + Electrical merged), Insert,
 * Annotate, Parametric (A12), Analyze, Massing & Site, Collaborate, View,
 * Manage, then the product tabs Output (A12) / Coordinate / Clash Detective
 * / Edit / X Dim kept after Manage.
 *
 * Two layers, same style as tests/ribbon-collapse.test.cjs:
 *  1. The order model itself is EXECUTED: src/shell/ribbon-order.ts is a
 *     pure, DOM-free module compiled with tsc and required here.
 *  2. Source pins prove src/shell/ribbon.ts `TABS` matches that model
 *     tab-for-tab and group-for-group, that no tool was lost in the merge,
 *     and that the moved buttons were moved (not copied).
 *
 * Sensitivity: on the pre-G1a tree this fails — there is no ribbon-order.ts
 * to compile, `mechanical`/`electrical` tabs still exist, and the tab order
 * is the old one.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const os = require("os");

const ROOT = path.join(__dirname, "..");
let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  PASS " + name); } catch (e) { console.log("  FAIL " + name + ": " + e.message); throw e; } };

/* ── 1. Execute the order model ────────────────────────────────────────── */
const out = fs.mkdtempSync(path.join(os.tmpdir(), "rto-"));
execSync(`npx tsc src/shell/ribbon-order.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe", cwd: ROOT });
const model = require(path.join(out, "ribbon-order.js"));
const ORDER = model.RIBBON_TAB_ORDER;

const EXPECTED_IDS = ["home", "file", "architecture", "structure", "systems", "insert",
  "annotate", "parametric", "analyze", "massing-site", "collaborate", "view", "manage",
  "output", "coordinate", "clash", "edit", "cost"];

t("tab ids are in Revit order with the A12 AutoCAD tabs", () => {
  assert.deepStrictEqual(ORDER.map((x) => x.id), EXPECTED_IDS);
});

t("Home is first and is the default tab; Parametric follows Annotate; Output follows Manage", () => {
  assert.strictEqual(ORDER[0].id, "home", "Home must be the first tab");
  assert.deepStrictEqual([...ORDER.find((x) => x.id === "home").groups],
    ["Draw", "Modify", "Annotate", "History", "Properties"]);
  const ann = ORDER.findIndex((x) => x.id === "annotate");
  assert.strictEqual(ORDER[ann + 1].id, "parametric", "Parametric must follow Annotate");
  assert.deepStrictEqual([...ORDER.find((x) => x.id === "parametric").groups],
    ["Parametric", "Families", "Constraints"]);
  const man = ORDER.findIndex((x) => x.id === "manage");
  assert.strictEqual(ORDER[man + 1].id, "output", "Output must follow Manage");
  assert.deepStrictEqual([...ORDER.find((x) => x.id === "output").groups],
    ["Plot", "Export", "Sheets"]);
  assert.ok(ORDER.find((x) => x.id === "output").product, "Output must be a product tab");
});

t("Mechanical + Electrical are gone; Systems + Collaborate exist", () => {
  const ids = ORDER.map((x) => x.id);
  assert.ok(!ids.includes("mechanical"), "mechanical tab must not exist");
  assert.ok(!ids.includes("electrical"), "electrical tab must not exist");
  assert.ok(ids.includes("systems"), "systems tab missing");
  assert.ok(ids.includes("collaborate"), "collaborate tab missing");
});

t("tab ids and labels are unique", () => {
  assert.strictEqual(new Set(ORDER.map((x) => x.id)).size, ORDER.length, "duplicate tab id");
  assert.strictEqual(new Set(ORDER.map((x) => x.label)).size, ORDER.length, "duplicate tab label");
});

t("Systems groups: HVAC / Auto-Route / Plumbing / Fire / Electrical / Systems / Display / Engineering / Properties", () => {
  const sys = ORDER.find((x) => x.id === "systems");
  assert.deepStrictEqual([...sys.groups], ["HVAC", "Auto-Route", "Plumbing", "Fire",
    "Electrical", "Systems", "Display", "Engineering", "Properties"]);
  const i = (g) => sys.groups.indexOf(g);
  assert.ok(i("HVAC") < i("Plumbing") && i("Plumbing") < i("Fire") && i("Fire") < i("Electrical"),
    "discipline groups out of order");
});

t("Collaborate groups are Live Sync + Worksets", () => {
  const c = ORDER.find((x) => x.id === "collaborate");
  assert.deepStrictEqual([...c.groups], ["Live Sync", "Worksets"]);
});

t("deviation tabs are exactly the five after Manage, in order", () => {
  assert.deepStrictEqual([...model.RIBBON_PRODUCT_TAB_IDS], ["output", "coordinate", "clash", "edit", "cost"]);
  assert.deepStrictEqual([...model.RIBBON_REVIT_TAB_IDS],
    EXPECTED_IDS.slice(0, EXPECTED_IDS.indexOf("manage") + 1));
  const manageIdx = ORDER.findIndex((x) => x.id === "manage");
  ORDER.forEach((x, i) => {
    if (i <= manageIdx) assert.ok(!x.product, `${x.id} must not be flagged product`);
    else assert.ok(x.product, `${x.id} after Manage must be flagged product`);
  });
});

t("every deviation carries its reason in the model", () => {
  for (const x of ORDER.filter((x) => x.product || x.id === "file")) {
    assert.ok(typeof x.deviation === "string" && x.deviation.length > 20,
      `${x.id}: deviation reason missing`);
  }
});

t("RIBBON_TAB_IDS partitions into Revit run + product tabs", () => {
  assert.deepStrictEqual([...model.RIBBON_TAB_IDS], EXPECTED_IDS);
  assert.strictEqual(model.RIBBON_REVIT_TAB_IDS.length + model.RIBBON_PRODUCT_TAB_IDS.length,
    model.RIBBON_TAB_IDS.length);
});

/* ── 2. Source pins: ribbon.ts TABS matches the model ─────────────────── */
const ribbonSrc = fs.readFileSync(path.join(ROOT, "src/shell/ribbon.ts"), "utf8");
// Full-line comments only (the commented-out Modify groupLabel in
// Architecture must not count as a group); strings are left intact.
const noComments = ribbonSrc.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const t0 = noComments.indexOf("const TABS:");
const t1 = noComments.indexOf("\n];", t0);
assert.ok(t0 >= 0 && t1 > t0, "TABS array not found in ribbon.ts");
const region = noComments.slice(t0, t1);
const tabChunks = region.split(/^  \{$/m).slice(1);
assert.strictEqual(tabChunks.length, ORDER.length,
  `TABS has ${tabChunks.length} tabs, model has ${ORDER.length}`);

t("ribbon.ts TABS order matches the model", () => {
  const ids = tabChunks.map((c) => {
    const m = c.match(/^    id: "([^"]+)",$/m);
    assert.ok(m, "tab chunk without id");
    return m[1];
  });
  assert.deepStrictEqual(ids, EXPECTED_IDS);
});

t("ribbon.ts group order matches the model, tab by tab", () => {
  tabChunks.forEach((c, i) => {
    const groups = [...c.matchAll(/groupLabel\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.deepStrictEqual(groups, [...ORDER[i].groups],
      `tab ${ORDER[i].id}: groups ${JSON.stringify(groups)} != model ${JSON.stringify(ORDER[i].groups)}`);
  });
});

t("no mechanical/electrical tab survives in ribbon.ts", () => {
  assert.ok(!/^\s+id: "mechanical",$/m.test(region), "mechanical tab still in TABS");
  assert.ok(!/^\s+id: "electrical",$/m.test(region), "electrical tab still in TABS");
});

t("MEP Delivery workspace lands on Systems", () => {
  assert.ok(ribbonSrc.includes('tab: "systems"'), "WORKSPACES mep still points at mechanical");
  assert.ok(!ribbonSrc.includes('tab: "mechanical"'), "stale mechanical workspace reference");
});

t("Insert tab Clash shortcut still targets a real tab id", () => {
  assert.ok(ribbonSrc.includes('[data-tab="clash"]'), "Insert → Clash shortcut lost");
  assert.ok(ORDER.some((x) => x.id === "clash"), "clash tab missing from model");
});

/* ── 3. No tool lost in the merge; moved buttons moved, not copied ─────── */
const systemsChunk = tabChunks[ORDER.findIndex((x) => x.id === "systems")];
const collabChunk = tabChunks[ORDER.findIndex((x) => x.id === "collaborate")];
const manageChunk = tabChunks[ORDER.findIndex((x) => x.id === "manage")];

const EXPECTED_SYSTEMS_TOOLS = ["duct", "duct-fitting", "air-terminal", "flex-duct",
  "duct-accessory", "equipment", "pipe", "pipe-fitting", "pipe-accessory",
  "plumbing-fixture", "sprinkler", "sprinkler-main", "fire-pump", "cable-tray",
  "cable-tray-fitting", "conduit", "conduit-fitting", "wire", "panel", "switch",
  "outlet", "junction-box", "lighting-fixture", "emergency-light",
  "lighting-switch", "transformer", "generator"];

t("Systems tab holds every pre-G1a Mechanical + Electrical tool", () => {
  for (const tool of EXPECTED_SYSTEMS_TOOLS) {
    assert.ok(systemsChunk.includes(`"${tool}"`),
      `Systems tab lost tool "${tool}"`);
  }
  assert.strictEqual(new Set(EXPECTED_SYSTEMS_TOOLS).size, 27, "tool list itself has a duplicate");
});

t("duplicate Equip button deduplicated (tool kept once, in HVAC)", () => {
  const n = (systemsChunk.match(/toolBtn\("equipment", "Equip", "equipment"\)/g) || []).length;
  assert.strictEqual(n, 1, `equipment tool button appears ${n} times in Systems`);
});

t("Live Sync + Worksets moved to Collaborate, not copied", () => {
  assert.ok(collabChunk.includes('"Live Sync"'), "Collaborate lacks Live Sync");
  assert.strictEqual((collabChunk.match(/b\("workset"/g) || []).length, 5,
    "Collaborate must hold all 5 workset buttons");
  assert.ok(!manageChunk.includes('"Live Sync"'), "Live Sync still in Manage (copied, not moved)");
  assert.ok(!manageChunk.includes('b("workset"'), "workset buttons still in Manage (copied, not moved)");
  assert.ok(!/groupLabel\("Collaboration"\)/.test(manageChunk), "Manage still has Collaboration group");
  assert.ok(!/groupLabel\("Worksets"\)/.test(manageChunk), "Manage still has Worksets group");
});

t("File and Edit tabs kept (documented deviations, not deletions)", () => {
  const ids = tabChunks.map((c) => c.match(/^    id: "([^"]+)",$/m)[1]);
  assert.ok(ids.includes("file"), "File tab deleted");
  assert.ok(ids.includes("edit"), "Edit tab deleted (demotion was rejected: see ribbon-order.ts)");
  assert.ok(ribbonSrc.includes("src/shell/ribbon-order.ts"),
    "ribbon.ts must point at the order model as source of truth");
});

t("audit doc copied into the repo", () => {
  const doc = fs.readFileSync(path.join(ROOT, "docs/engineering/REVIT_2D_ENVIRONMENT.md"), "utf8");
  assert.ok(doc.includes("G1 — Ribbon tab order"), "audit doc copy missing the G1 section");
  assert.ok(doc.includes("29c222b"), "audit doc copy missing its base SHA");
});

console.log(`\nribbon-tab-order: ${pass} assertions passed`);
