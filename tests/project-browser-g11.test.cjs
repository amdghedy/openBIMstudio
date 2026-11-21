#!/usr/bin/env node
/**
 * Project Browser ordering and grouping — Revit 2D environment audit gap G11.
 *
 * Pins the Revit browser order and grouping (audit §2 G11):
 *   Roots: Views, Sheets, Schedules/Quantities, Families, Groups,
 *          Models & Links, 4D Phases
 *   Views subgrouped by kind: Floor Plans / Ceiling Plans / Elevations /
 *          Sections / 3D Views / … / Saved Views — only for kinds that
 *          have a stored view (or the built-in 3D / Floor Plan entry);
 *          no empty groups for kinds the engine cannot produce.
 *   Families lists family types as well as materials.
 *   A filter textbox narrows the tree by node name as you type.
 *
 * Two layers, same style as tests/ribbon-draw-order.test.cjs:
 *  1. The tree model itself is EXECUTED: src/features/project-browser-tree.ts
 *     is a pure, DOM-free module compiled with tsc and required here.
 *  2. Source pins prove src/features/project-browser.ts delegates to that
 *     model (no second hardcoded root order), reads stored views from the
 *     views module and family types from the family service, and renders
 *     the filter textbox with the existing toolbar/header intact.
 *
 * Sensitivity: on the pre-G11 tree this fails — there is no
 * project-browser-tree.ts to compile, the roots are Views, Schedules,
 * Sheets, Families, Models & Links, Groups, 4D Phases, Views is flat
 * (3D View, Floor Plan, saved views), Families lists materials only,
 * and there is no filter input.
 */
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const os = require("os");

const ROOT = path.join(__dirname, "..");
let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log("  PASS " + name); } catch (e) { console.log("  FAIL " + name + ": " + e.message); throw e; } };

/* ── 1. Execute the tree model ─────────────────────────────────────────── */
const out = fs.mkdtempSync(path.join(os.tmpdir(), "pbt-"));
execSync(`npx tsc src/features/project-browser-tree.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe", cwd: ROOT });
const model = require(path.join(out, "project-browser-tree.js"));
const { buildProjectBrowserTree, filterProjectBrowserTree, PROJECT_BROWSER_ROOT_ORDER } = model;

/** Fixture mirroring the views store's seeded defaults (2 plan, 1 elevation,
 *  1 section) plus two families with types, materials, one sheet, one group,
 *  one link, one phase and one saved view. */
function fixture(overrides = {}) {
  return {
    links: [{ id: "m1", label: "site.ifc" }],
    savedViews: [{ id: "sv1", name: "Iso Overview" }],
    sheets: [{ id: "sh1", number: "A-101", name: "Ground Floor Plan" }],
    materials: [
      { id: "mat-concrete", name: "Concrete" },
      { id: "mat-timber", name: "Timber" },
    ],
    families: [
      { id: "builtin-wall-1", name: "Basic Wall", types: [
        { id: "t1", name: "Generic - 200mm" },
        { id: "t2", name: "Generic - 300mm" },
      ] },
      { id: "builtin-door-2", name: "Single Door", types: [
        { id: "t3", name: "900 x 2100mm" },
      ] },
    ],
    groups: [{ id: "g1", name: "Core Walls" }],
    phases: [{ id: "p1", name: "Existing", elementCount: 3 }],
    views: [
      { id: "plan-level-0", kind: "plan", name: "Level 0 Plan" },
      { id: "plan-level-1", kind: "plan", name: "Level 1 Plan" },
      { id: "elev-north", kind: "elevation", name: "North Elevation" },
      { id: "section-a", kind: "section", name: "Section A-A" },
    ],
    ...overrides,
  };
}

const labels = (nodes) => nodes.map((n) => n.label);
const find = (nodes, id) => {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) { const f = find(n.children, id); if (f) return f; }
  }
  return null;
};
const allLabels = (nodes, acc = []) => {
  for (const n of nodes) { acc.push(n.label); if (n.children) allLabels(n.children, acc); }
  return acc;
};

const tree = buildProjectBrowserTree(fixture());

/* ── 2. Root order ─────────────────────────────────────────────────────── */
t("root order is Views, Sheets, Schedules/Quantities, Families, Groups, Models & Links, 4D Phases", () => {
  assert.deepStrictEqual(
    tree.map((n) => n.id),
    ["views", "sheets", "schedules", "families", "groups", "links", "phases"],
  );
  assert.deepStrictEqual(PROJECT_BROWSER_ROOT_ORDER, ["views", "sheets", "schedules", "families", "groups", "links", "phases"]);
  assert.deepStrictEqual(labels(tree), [
    "Views (all)", "Sheets (all)", "Schedules/Quantities (all)", "Families",
    "Groups", "Models & Links", "4D Phases",
  ]);
  // The stable Revit facts: Sheets before Schedules, Groups before Links.
  const ids = tree.map((n) => n.id);
  assert.ok(ids.indexOf("sheets") < ids.indexOf("schedules"), "Sheets must precede Schedules");
  assert.ok(ids.indexOf("groups") < ids.indexOf("links"), "Groups must precede Links");
});

/* ── 3. Views subgroups for the kinds the engine produces ─────────────── */
t("Views subgroups exist for the view kinds the engine produces (plan / elevation / section / 3d)", () => {
  const views = find(tree, "views");
  assert.deepStrictEqual(labels(views.children), [
    "Floor Plans", "Elevations", "Sections", "3D Views", "Saved Views",
  ]);
  assert.deepStrictEqual(labels(find(tree, "views-plan").children), [
    "Floor Plan", "Level 0 Plan", "Level 1 Plan",
  ]);
  assert.deepStrictEqual(labels(find(tree, "views-elevation").children), ["North Elevation"]);
  assert.deepStrictEqual(labels(find(tree, "views-section").children), ["Section A-A"]);
  assert.deepStrictEqual(labels(find(tree, "views-3d").children), ["3D View"]);
  assert.deepStrictEqual(labels(find(tree, "views-saved").children), ["Iso Overview"]);
  // Stored views carry their view id so activation can open them.
  assert.strictEqual(find(tree, "viewdef-plan-level-0").meta.viewId, "plan-level-0");
  assert.strictEqual(find(tree, "viewdef-section-a").meta.viewId, "section-a");
});

t("no empty groups for view kinds with no stored views (no Ceiling Plans / Detail / Drafting / Legends)", () => {
  const views = find(tree, "views");
  for (const absent of ["Ceiling Plans", "Detail Views", "Drafting Views", "Legends"]) {
    assert.ok(!labels(views.children).includes(absent), `${absent} must not render with no views of that kind`);
  }
});

t("a stored ceiling-plan view produces a Ceiling Plans subgroup (grouping is data-driven)", () => {
  const withRcp = buildProjectBrowserTree(fixture({
    views: [
      ...fixture().views,
      { id: "rcp-0", kind: "rcp", name: "Level 0 Ceiling Plan" },
    ],
  }));
  const views = find(withRcp, "views");
  assert.deepStrictEqual(labels(views.children), [
    "Floor Plans", "Ceiling Plans", "Elevations", "Sections", "3D Views", "Saved Views",
  ]);
  assert.deepStrictEqual(labels(find(withRcp, "views-rcp").children), ["Level 0 Ceiling Plan"]);
});

/* ── 4. Families list family types as well as materials ───────────────── */
t("Families lists family types under each family, plus a Materials subgroup", () => {
  const fams = find(tree, "families");
  assert.strictEqual(find(tree, "fam-builtin-wall-1").label, "Basic Wall");
  assert.deepStrictEqual(labels(find(tree, "fam-builtin-wall-1").children), [
    "Generic - 200mm", "Generic - 300mm",
  ]);
  assert.deepStrictEqual(labels(find(tree, "fam-builtin-door-2").children), ["900 x 2100mm"]);
  assert.strictEqual(find(tree, "famtype-builtin-wall-1-t1").meta.familyId, "builtin-wall-1");
  assert.strictEqual(find(tree, "famtype-builtin-wall-1-t1").meta.typeId, "t1");
  assert.deepStrictEqual(labels(find(tree, "families-materials").children), ["Concrete", "Timber"]);
  assert.deepStrictEqual(labels(fams.children), ["Basic Wall", "Single Door", "Materials"]);
  assert.strictEqual(fams.count, 4, "Families count covers families + materials");
});

/* ── 5. Filter narrows nodes by name ───────────────────────────────────── */
t("filter narrows the tree to the matching path (case-insensitive, ancestors kept)", () => {
  const hit = filterProjectBrowserTree(tree, "level 0");
  assert.deepStrictEqual(allLabels(hit), ["Views (all)", "Floor Plans", "Level 0 Plan"]);
  const hit2 = filterProjectBrowserTree(tree, "NORTH ELEVATION");
  assert.deepStrictEqual(allLabels(hit2), ["Views (all)", "Elevations", "North Elevation"]);
  const hit3 = filterProjectBrowserTree(tree, "a-101");
  assert.deepStrictEqual(allLabels(hit3), ["Sheets (all)", "A-101 — Ground Floor Plan"]);
  assert.deepStrictEqual(filterProjectBrowserTree(tree, "zzz-no-such-node"), []);
  assert.deepStrictEqual(filterProjectBrowserTree(tree, ""), tree, "empty query returns the tree unchanged");
  assert.deepStrictEqual(filterProjectBrowserTree(tree, "   "), tree, "blank query returns the tree unchanged");
});

t("filter on a parent label keeps its whole subtree", () => {
  const hit = filterProjectBrowserTree(tree, "basic wall");
  assert.deepStrictEqual(allLabels(hit), [
    "Families", "Basic Wall", "Generic - 200mm", "Generic - 300mm",
  ]);
});

/* ── 6. Source pins: the panel delegates to the model ──────────────────── */
const pbSrc = fs.readFileSync(path.join(ROOT, "src/features/project-browser.ts"), "utf8");
const vpSrc = fs.readFileSync(path.join(ROOT, "src/features/views-panel.ts"), "utf8");

t("project-browser.ts delegates to the tree model (no second hardcoded root order)", () => {
  assert.ok(pbSrc.includes('from "./project-browser-tree"'), "must import the tree model");
  assert.ok(pbSrc.includes("buildProjectBrowserTree({"), "buildTree must call the model");
  assert.ok(pbSrc.includes("filterProjectBrowserTree(buildTree(), filterQuery)"), "render must filter through the model");
  assert.ok(!pbSrc.includes('label: "Views (all)"'), "root labels must live in the model, not a second copy here");
  assert.ok(!pbSrc.includes('label: "Schedules/Quantities (all)"'), "no hardcoded Schedules root here");
});

t("project-browser.ts reads stored views from the views module and family types from the family service", () => {
  assert.ok(pbSrc.includes('from "../modules/views/store"'), "must import the views store");
  assert.ok(pbSrc.includes("bootViewsStore()"), "must boot the views store before listing");
  assert.ok(pbSrc.includes("listViews()"), "must list stored views");
  assert.ok(pbSrc.includes("ctx.features") && pbSrc.includes(".family"), "must read families from the family service");
  assert.ok(pbSrc.includes("f.types"), "must map family types, not just family names");
});

t("filter textbox exists; toolbar (+ View, + Sheet, Expand) and header (Refresh, Properties, Close) intact", () => {
  assert.ok(pbSrc.includes('class="pb-filter-input"'), "filter input missing");
  assert.ok(pbSrc.includes('aria-label="Filter browser"'), "filter input needs an accessible label");
  assert.ok(pbSrc.includes('placeholder="Filter…"'), "filter input needs a Filter placeholder");
  assert.ok(pbSrc.includes('data-act="new-view"') && pbSrc.includes('>+ View<'), "+ View button missing");
  assert.ok(pbSrc.includes('data-act="new-sheet"') && pbSrc.includes('>+ Sheet<'), "+ Sheet button missing");
  assert.ok(pbSrc.includes('data-act="expand"') && pbSrc.includes('>Expand<'), "Expand button missing");
  assert.ok(pbSrc.includes('data-act="refresh"'), "Refresh header button missing");
  assert.ok(pbSrc.includes('data-act="props"'), "Properties header button missing");
  assert.ok(pbSrc.includes('data-act="close"'), "Close header button missing");
  assert.ok(pbSrc.includes('filterQuery = filterInput.value'), "filter input must drive the render");
});

t("stored-view activation opens the view in the Views panel", () => {
  assert.ok(pbSrc.includes('openViewInPanel(String(node.meta.viewId))'), "view-def activation must open the view");
  assert.ok(vpSrc.includes("export function openViewInPanel(viewId: string)"), "views-panel must export openViewInPanel");
  assert.ok(pbSrc.includes('case "view-def":'), "onActivate must handle view-def nodes");
  assert.ok(pbSrc.includes('case "view-group":'), "onActivate must handle view-group nodes");
});

console.log(`\nproject-browser-g11: ${pass} passed`);
