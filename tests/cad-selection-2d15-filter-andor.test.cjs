// FILTER AND/OR condition trees — nested groups of criteria (2D-15).
//
// Proved fail-without-fix against the parent commit: the condition-tree
// API (sanitizeFilterNode / matchesFilterTree / FilterNode) does not exist
// there, so this suite fails at the first tree assertion. The viewer
// wiring (DOM-heavy, cannot compile headlessly) is proved by source
// markers, the same pattern as the A18 suite.
//
// No mocks: the geometry, entity metrics and selection helpers under test
// are the shipped ones.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-selection-2d15-"));
fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction");
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
try {
  execSync(
    "npx tsc src/modules/cad-viewer/cad-selection-a18.ts src/modules/cad-viewer/viewer-math.ts " +
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
  const S = require(locate(out, "cad-selection-a18.js"));

  const L = (x1, y1, x2, y2, extra = {}) => ({ type: "LINE", layer: "0", start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, ...extra });
  const C = (x, y, r, extra = {}) => ({ type: "CIRCLE", layer: "0", center: { x, y }, radius: r, ...extra });
  const T = (v, extra = {}) => ({ type: "TEXT", layer: "0", position: { x: 0, y: 0 }, value: v, height: 10, rotation: 0, ...extra });
  const crit = (property, operator, value) => ({ kind: "criterion", criterion: { property, operator, value } });
  const grp = (operator, children) => ({ kind: "group", operator, children });

  // Six entities: two A-lines, one B-line, one B-circle, one A-circle, one B-text.
  const ents = [
    L(0, 0, 100, 0, { layer: "A" }),   // 0: A LINE, length 100
    L(0, 0, 200, 0, { layer: "A" }),   // 1: A LINE, length 200
    L(0, 0, 100, 0, { layer: "B" }),   // 2: B LINE, length 100
    C(0, 0, 50, { layer: "B" }),       // 3: B CIRCLE, circumference ~314
    C(0, 0, 10, { layer: "A" }),       // 4: A CIRCLE, circumference ~63
    T("NOTE", { layer: "B" }),          // 5: B TEXT
  ];
  const select = (tree) => ents.map((_, i) => i).filter((i) => S.matchesFilterTree(ents[i], tree));

  // ── compound selection ──
  t("compound filter (layer=A AND type=LINE) OR (layer=B AND type=CIRCLE) selects exactly the matches", () => {
    const tree = grp("OR", [
      grp("AND", [crit("layer", "=", "A"), crit("type", "=", "LINE")]),
      grp("AND", [crit("layer", "=", "B"), crit("type", "=", "CIRCLE")]),
    ]);
    assert.deepEqual(select(tree), [0, 1, 3]);
  });
  t("nested group: the OR above AND length < 250 keeps only the two A-lines", () => {
    const orGroup = grp("OR", [
      grp("AND", [crit("layer", "=", "A"), crit("type", "=", "LINE")]),
      grp("AND", [crit("layer", "=", "B"), crit("type", "=", "CIRCLE")]),
    ]);
    const tree = grp("AND", [orGroup, crit("length", "<", "250")]);
    assert.deepEqual(select(tree), [0, 1]);
  });
  t("nested group: three levels deep — OR inside AND inside OR", () => {
    const tree = grp("OR", [
      grp("AND", [grp("OR", [crit("layer", "=", "A"), crit("layer", "=", "B")]), crit("type", "=", "TEXT")]),
      crit("type", "=", "CIRCLE"),
    ]);
    // B TEXT (5) via the left branch; both circles (3, 4) via the right.
    assert.deepEqual(select(tree), [3, 4, 5]);
  });
  t("matchesFilterTree: null/undefined matches everything; a lone criterion still works", () => {
    assert.deepEqual(select(null), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(select(undefined), [0, 1, 2, 3, 4, 5]);
    assert.deepEqual(select(crit("layer", "=", "B")), [2, 3, 5]);
    assert.deepEqual(select(grp("AND", [])), [0, 1, 2, 3, 4, 5], "empty AND matches everything");
    assert.deepEqual(select(grp("OR", [])), [], "empty OR matches nothing");
  });
  t("OR of one branch behaves like the branch; AND of one branch behaves like the branch", () => {
    assert.deepEqual(select(grp("OR", [crit("type", "=", "CIRCLE")])), [3, 4]);
    assert.deepEqual(select(grp("AND", [crit("layer", "=", "A"), crit("type", "=", "LINE")])), [0, 1]);
  });

  // ── tree validation ──
  t("sanitizeFilterNode: valid trees round-trip; junk leaves drop; a one-child group flattens", () => {
    const tree = grp("OR", [
      grp("AND", [crit("layer", "=", "A"), crit("type", "=", "LINE")]),
      crit("nope", "=", "1"),
    ]);
    // The junk leaf drops, leaving the OR with one child — which flattens to that child.
    assert.deepEqual(S.sanitizeFilterNode(JSON.parse(JSON.stringify(tree))), grp("AND", [crit("layer", "=", "A"), crit("type", "=", "LINE")]));
    assert.deepEqual(S.sanitizeFilterNode(grp("AND", [crit("layer", "=", "A")])), crit("layer", "=", "A"));
    assert.strictEqual(S.sanitizeFilterNode(grp("AND", [crit("nope", "=", "1")])), null);
    assert.strictEqual(S.sanitizeFilterNode(grp("XOR", [crit("layer", "=", "A")])), null);
    assert.strictEqual(S.sanitizeFilterNode({ kind: "group", operator: "AND" }), null, "group without children is unusable");
    assert.strictEqual(S.sanitizeFilterNode(null), null);
    assert.strictEqual(S.sanitizeFilterNode("layer"), null);
  });
  t("sanitizeFilterNode: depth is capped; a legacy flat criteria array becomes an AND group", () => {
    let deep = crit("layer", "=", "A");
    for (let i = 0; i < 8; i++) deep = grp("AND", [deep]);
    assert.strictEqual(S.sanitizeFilterNode(deep), null, "8-deep nesting is over the cap");
    let ok = crit("layer", "=", "A");
    for (let i = 0; i < 3; i++) ok = grp("AND", [ok]);
    assert.deepEqual(S.sanitizeFilterNode(ok), crit("layer", "=", "A"), "3-deep nesting flattens to the lone criterion");
    assert.deepEqual(
      S.sanitizeFilterNode([{ property: "layer", operator: "=", value: "A" }, { property: "type", operator: "=", value: "LINE" }]),
      grp("AND", [crit("layer", "=", "A"), crit("type", "=", "LINE")]),
    );
    assert.strictEqual(S.sanitizeFilterNode([]), null, "empty legacy list means no filter");
  });
  t("sanitizeFilterNode: the criterion cap drops the tail, never throws", () => {
    const many = grp("OR", Array.from({ length: 30 }, (_, i) => crit("layer", "=", "L" + i)));
    const out = S.sanitizeFilterNode(many);
    assert.ok(out && out.kind === "group" && out.children.length === 20, "capped at twenty criteria, got " + (out && out.children.length));
  });
  t("filterTreeFromCriteria: empty is null, one is a lone criterion, several are an AND group", () => {
    assert.strictEqual(S.filterTreeFromCriteria([]), null);
    assert.deepEqual(S.filterTreeFromCriteria([{ property: "layer", operator: "=", value: "A" }]), crit("layer", "=", "A"));
    assert.deepEqual(
      S.filterTreeFromCriteria([{ property: "layer", operator: "=", value: "A" }, { property: "type", operator: "=", value: "LINE" }]),
      grp("AND", [crit("layer", "=", "A"), crit("type", "=", "LINE")]),
    );
  });
  t("countFilterCriteria / describeFilterTree / cloneFilterNode", () => {
    const tree = grp("OR", [
      grp("AND", [crit("layer", "=", "A"), crit("type", "=", "LINE")]),
      grp("AND", [crit("layer", "=", "B"), crit("type", "=", "CIRCLE")]),
    ]);
    assert.strictEqual(S.countFilterCriteria(tree), 4);
    assert.strictEqual(S.countFilterCriteria(null), 0);
    assert.strictEqual(S.countFilterCriteria(crit("layer", "=", "A")), 1);
    assert.strictEqual(
      S.describeFilterTree(tree),
      "(layer = A AND type = LINE) OR (layer = B AND type = CIRCLE)",
    );
    assert.strictEqual(S.describeFilterTree(null), "");
    assert.strictEqual(S.describeFilterTree(crit("layer", "=", "A")), "layer = A");
    const clone = S.cloneFilterNode(tree);
    assert.deepEqual(clone, tree);
    clone.children[0].children[0].criterion.value = "Z";
    assert.strictEqual(tree.children[0].children[0].criterion.value, "A", "clone is deep — editing it leaves the original alone");
    assert.strictEqual(S.cloneFilterNode(null), null);
  });

  // ── named filters carry the tree; legacy criteria still load ──
  t("sanitizeNamedFilter: tree round-trips; a stored flat criteria list migrates to an AND group", () => {
    const tree = grp("OR", [crit("layer", "=", "A"), crit("layer", "=", "B")]);
    const f = S.sanitizeNamedFilter({ name: " A or B ", types: ["LINE"], tree });
    assert.deepEqual(f, { name: "A or B", types: ["LINE"], tree });
    const legacy = S.sanitizeNamedFilter({
      name: "old", types: [],
      criteria: [{ property: "layer", operator: "=", value: "A" }, { property: "nope", operator: "=", value: "1" }],
    });
    assert.deepEqual(legacy, { name: "old", types: [], tree: crit("layer", "=", "A") });
    assert.strictEqual(S.sanitizeNamedFilter({ name: "x", types: [], tree: grp("XOR", []) }), null, "an unusable tree makes the whole filter unusable");
    const stored = JSON.parse(JSON.stringify(S.serializeNamedFilters(new Map([["A or B", f]]))));
    assert.deepEqual(S.sanitizeNamedFilters(stored), { "A or B": f });
  });

  // ── viewer wiring markers ──
  const viewerSrc = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
  const sessionSrc = fs.readFileSync(path.join(root, "src/modules/cad-viewer/session-state.ts"), "utf8");
  const has = (re, msg) => assert.ok(re.test(viewerSrc), msg);
  t("viewer: visible() honours the compound filter tree", () => {
    has(/Sel18\.matchesFilterTree\(e, propFilter\)/, "visible() honours propFilter tree");
    has(/let propFilter: Sel18\.FilterNode \| null = null;/, "propFilter is a tree, null when unset");
  });
  t("viewer: FILTER dialog edits a condition tree — AND/OR toggle per group, nested groups, add/remove", () => {
    has(/function applyFilterState\(types: Set<string>, tree: Sel18\.FilterNode \| null\): void \{/, "applyFilterState takes a tree");
    has(/function saveNamedFilter\(name: string, types: Set<string>, tree: Sel18\.FilterNode \| null\): boolean \{/, "saveNamedFilter takes a tree");
    has(/data-r="filter-tree"/, "tree container");
    has(/data-r="filter-group-op"/, "AND/OR toggle per group");
    has(/data-r="filter-add-subgroup"/, "add-subgroup button");
    has(/data-r="filter-add-criterion"/, "add-criterion button");
    has(/data-filter-criterion-remove/, "remove-criterion button");
    has(/data-r="filter-remove-group"/, "remove-group button");
    has(/Sel18\.sanitizeFilterNode\(u\.propFilter\)/, "active filter restored through the tree sanitizer");
    has(/propFilter: propFilter \? Sel18\.cloneFilterNode\(propFilter\) \?\? undefined : undefined,/, "active filter captured in the session");
    has(/applyFilterState\(new Set\(f\.types\), f\.tree\)/, "named filter apply uses the stored tree");
  });
  t("viewer: FILTER command clear/save use the tree; QSELECT stays single-criterion", () => {
    has(/propFilter = null;/, "FILTER CLEAR resets the tree");
    has(/saveNamedFilter\(nm, typeFilter, propFilter\)/, "FILTER SAVE saves the tree");
    has(/Sel18\.countFilterCriteria\(/, "log lines count criteria from the tree");
    has(/Sel18\.applyQSelect\(ents, candidates, criterion, mode, sel\)/, "QSELECT still applies one criterion");
  });
  t("session: propFilter is a tree node; legacy arrays convert at sanitize time", () => {
    assert.ok(/propFilter\?: SessionFilterNode;/.test(sessionSrc), "SessionUi carries the tree");
    assert.ok(/export type SessionFilterNode =/.test(sessionSrc), "SessionFilterNode type defined");
    assert.ok(/sanitizeSessionFilterTree/.test(sessionSrc), "tree sanitizer exists");
  });

  console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
  if (fail) process.exit(1);
} catch (e) {
  console.log("FATAL: " + (e && e.message));
  process.exit(1);
}
