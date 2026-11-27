// QSELECT dialog criteria, FILTER property criteria + named filters, and
// previous selection (AutoCAD parity A18) — node test.
//
// Proved fail-without-fix against the base: the module does not exist
// there, so the tsc step fails with TS6053 (module not found) before any
// assertion runs. The viewer wiring (DOM-heavy, cannot compile headlessly)
// is proved by source markers, the same pattern as the A7/A11 suites.
//
// No mocks: the geometry, entity metrics and selection helpers under test
// are the shipped ones.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-selection-a18-"));
fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction");
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b, e = 1e-6) => assert.ok(Math.abs(a - b) < e, a + "!=" + b);
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
  const C = (x, y, r) => ({ type: "CIRCLE", layer: "0", center: { x, y }, radius: r });
  const A = (r, a0, a1) => ({ type: "ARC", layer: "0", center: { x: 0, y: 0 }, radius: r, startAngle: a0, endAngle: a1 });
  const T = (v, h = 10) => ({ type: "TEXT", layer: "0", position: { x: 0, y: 0 }, value: v, height: h, rotation: 0 });
  const PL = (pts, extra = {}) => ({ type: "LWPOLYLINE", layer: "0", points: pts, closed: false, ...extra });
  const SQ = () => PL([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }], { closed: true, width: 2 });

  // ── property model ──
  t("propertiesForType: ALL offers the common six; types add their own", () => {
    assert.deepEqual(S.propertiesForType("ALL").map((p) => p.id), ["type", "layer", "color", "linetype", "lineweight", "text"]);
    assert.ok(S.propertiesForType("LINE").some((p) => p.id === "length"));
    assert.deepEqual(S.propertiesForType("CIRCLE").map((p) => p.id).filter((id) => ["radius", "length", "area"].includes(id)), ["radius", "length", "area"]);
    const textProps = S.propertiesForType("TEXT").map((p) => p.id);
    assert.ok(textProps.includes("height"));
    assert.strictEqual(textProps.filter((id) => id === "text").length, 1, "text offered once");
    assert.deepEqual(S.propertiesForType("POINT").map((p) => p.id), ["type", "layer", "color", "linetype", "lineweight", "text"]);
  });
  t("operatorsForKind: numbers compare, strings contain", () => {
    assert.deepEqual(S.operatorsForKind("number"), ["=", "!=", ">", "<", ">=", "<="]);
    assert.deepEqual(S.operatorsForKind("string"), ["=", "!=", "contains", "not-contains"]);
    assert.deepEqual(S.operatorsForKind("color"), ["=", "!=", "contains", "not-contains"]);
    assert.deepEqual(S.operatorsForKind("lineweight"), ["=", "!=", ">", "<", ">=", "<="]);
  });

  // ── criterion validation ──
  t("sanitizeCriterion: accepts valid criteria, trims, rejects junk", () => {
    assert.deepEqual(S.sanitizeCriterion({ property: "length", operator: ">", value: " 100 " }), { property: "length", operator: ">", value: "100" });
    assert.deepEqual(S.sanitizeCriterion({ property: "text", operator: "contains", value: "NOTE" }), { property: "text", operator: "contains", value: "NOTE" });
    assert.deepEqual(S.sanitizeCriterion({ property: "color", operator: "=", value: "#FF0000" }), { property: "color", operator: "=", value: "#FF0000" });
    assert.deepEqual(S.sanitizeCriterion({ property: "lineweight", operator: "=", value: "BYLAYER" }), { property: "lineweight", operator: "=", value: "BYLAYER" });
    assert.strictEqual(S.sanitizeCriterion({ property: "nope", operator: "=", value: "1" }), null);
    assert.strictEqual(S.sanitizeCriterion({ property: "text", operator: ">", value: "x" }), null, "> is not a string operator");
    assert.strictEqual(S.sanitizeCriterion({ property: "length", operator: ">", value: "abc" }), null);
    assert.strictEqual(S.sanitizeCriterion({ property: "color", operator: "=", value: "banana" }), null);
    assert.strictEqual(S.sanitizeCriterion({ property: "lineweight", operator: "=", value: "-1" }), null);
    assert.strictEqual(S.sanitizeCriterion({ property: "length", operator: "=", value: "" }), null);
    assert.strictEqual(S.sanitizeCriterion({ property: "length", operator: "=", value: "x".repeat(201) }), null);
    assert.strictEqual(S.sanitizeCriterion(null), null);
    assert.strictEqual(S.sanitizeCriterion("length"), null);
  });
  t("sanitizeCriteria: drops the unusable, caps at ten", () => {
    const raw = [{ property: "length", operator: ">", value: "1" }, { property: "nope", operator: "=", value: "1" }, { property: "radius", operator: "=", value: "5" }];
    assert.deepEqual(S.sanitizeCriteria(raw).map((c) => c.property), ["length", "radius"]);
    assert.strictEqual(S.sanitizeCriteria(Array.from({ length: 12 }, () => ({ property: "length", operator: ">", value: "1" }))).length, 10);
    assert.deepEqual(S.sanitizeCriteria("junk"), []);
  });

  // ── matching ──
  t("matchesCriterion: numeric properties use the shipped metrics", () => {
    const l100 = L(0, 0, 100, 0), l200 = L(0, 0, 200, 0);
    assert.strictEqual(S.matchesCriterion(l200, { property: "length", operator: ">", value: "150" }), true);
    assert.strictEqual(S.matchesCriterion(l100, { property: "length", operator: ">", value: "150" }), false);
    assert.strictEqual(S.matchesCriterion(l100, { property: "length", operator: "=", value: "100" }), true);
    const c = C(0, 0, 50);
    assert.strictEqual(S.matchesCriterion(c, { property: "radius", operator: "=", value: "50" }), true);
    assert.strictEqual(S.matchesCriterion(c, { property: "length", operator: "=", value: String(2 * Math.PI * 50) }), true, "circle length is the circumference");
    assert.strictEqual(S.matchesCriterion(c, { property: "area", operator: ">", value: "7000" }), true);
    const arc = A(50, 0, 90);
    assert.strictEqual(S.matchesCriterion(arc, { property: "length", operator: ">", value: "70" }), true, "arc length is the arc, not the chord");
    assert.strictEqual(S.matchesCriterion(arc, { property: "area", operator: "<", value: "2000" }), true, "sector area");
    const sq = SQ();
    assert.strictEqual(S.matchesCriterion(sq, { property: "area", operator: "=", value: "10000" }), true);
    assert.strictEqual(S.matchesCriterion(sq, { property: "length", operator: "=", value: "400" }), true);
    assert.strictEqual(S.matchesCriterion(sq, { property: "width", operator: "=", value: "2" }), true);
    assert.strictEqual(S.matchesCriterion(T("NOTE A", 10), { property: "height", operator: "=", value: "10" }), true);
    assert.strictEqual(S.matchesCriterion(l100, { property: "radius", operator: "=", value: "50" }), false, "a line has no radius");
    assert.strictEqual(S.matchesCriterion(l100, { property: "length", operator: "=", value: "abc" }), false, "an invalid criterion never matches");
  });
  t("matchesCriterion: strings compare case-insensitively; colour and lineweight follow the command-line forms", () => {
    const a = L(0, 0, 10, 0, { layer: "A-Wall" });
    assert.strictEqual(S.matchesCriterion(a, { property: "layer", operator: "=", value: "a-wall" }), true);
    assert.strictEqual(S.matchesCriterion(a, { property: "layer", operator: "contains", value: "WALL" }), true);
    assert.strictEqual(S.matchesCriterion(a, { property: "type", operator: "=", value: "line" }), true);
    assert.strictEqual(S.matchesCriterion(T("NOTE A"), { property: "text", operator: "contains", value: "note" }), true);
    assert.strictEqual(S.matchesCriterion(T("NOTE A"), { property: "text", operator: "not-contains", value: "zzz" }), true);
    assert.strictEqual(S.matchesCriterion(L(0, 0, 10, 0, { color: 1 }), { property: "color", operator: "=", value: "1" }), true);
    assert.strictEqual(S.matchesCriterion(L(0, 0, 10, 0, { rgb: 0xff0000 }), { property: "color", operator: "=", value: "#FF0000" }), true);
    assert.strictEqual(S.matchesCriterion(L(0, 0, 10, 0), { property: "color", operator: "=", value: "BYLAYER" }), true);
    assert.strictEqual(S.matchesCriterion(L(0, 0, 10, 0, { lineweight: 0.5 }), { property: "lineweight", operator: "=", value: "0.5" }), true);
    assert.strictEqual(S.matchesCriterion(L(0, 0, 10, 0), { property: "lineweight", operator: "=", value: "BYLAYER" }), true);
    assert.strictEqual(S.matchesCriterion(L(0, 0, 10, 0), { property: "lineweight", operator: "!=", value: "BYLAYER" }), false);
    assert.strictEqual(S.matchesCriterion(L(0, 0, 10, 0, { lineweight: 0.5 }), { property: "lineweight", operator: ">", value: "0.25" }), true);
  });
  t("matchesAllCriteria: empty matches everything; criteria AND", () => {
    const e = L(0, 0, 200, 0, { layer: "A-Wall" });
    assert.strictEqual(S.matchesAllCriteria(e, []), true);
    assert.strictEqual(S.matchesAllCriteria(e, [
      { property: "length", operator: ">", value: "150" },
      { property: "layer", operator: "=", value: "A-Wall" },
    ]), true);
    assert.strictEqual(S.matchesAllCriteria(e, [
      { property: "length", operator: ">", value: "150" },
      { property: "layer", operator: "=", value: "A-Door" },
    ]), false);
  });

  // ── QSELECT apply modes ──
  t("applyQSelect: include / exclude / append", () => {
    // The circle's circumference (2π·10 ≈ 63) is below the 150 cut, so
    // only the long line matches.
    const ents = [L(0, 0, 100, 0), L(0, 0, 200, 0), C(0, 0, 10)];
    const all = [0, 1, 2];
    const c = { property: "length", operator: ">", value: "150" };
    assert.deepEqual(S.applyQSelect(ents, all, c, "include", new Set()), [1]);
    assert.deepEqual(S.applyQSelect(ents, all, c, "exclude", new Set()), [0, 2]);
    assert.deepEqual(S.applyQSelect(ents, all, c, "append", new Set([0])), [0, 1]);
    assert.deepEqual(S.applyQSelect(ents, all, c, "append", new Set([1])), [1], "appending a match already held adds nothing");
  });

  // ── named filters ──
  t("sanitizeNamedFilter: valid round-trips; junk is dropped; legacy criteria migrate to a tree", () => {
    const f = S.sanitizeNamedFilter({ name: " Big circles ", types: ["CIRCLE", 7, ""], criteria: [{ property: "radius", operator: ">", value: "40" }, { property: "nope", operator: "=", value: "1" }] });
    assert.deepEqual(f, { name: "Big circles", types: ["CIRCLE"], tree: { kind: "criterion", criterion: { property: "radius", operator: ">", value: "40" } } });
    assert.strictEqual(S.sanitizeNamedFilter({ name: "  " }), null);
    assert.strictEqual(S.sanitizeNamedFilter({ name: "x".repeat(101) }), null);
    assert.strictEqual(S.sanitizeNamedFilter(null), null);
    const stored = JSON.parse(JSON.stringify(S.serializeNamedFilters(new Map([["Big circles", f]]))));
    assert.deepEqual(S.sanitizeNamedFilters(stored), { "Big circles": f });
  });
  t("sanitizeNamedFilters: drops bad entries, caps at fifty", () => {
    const raw = { a: { name: "ok", types: [], criteria: [] }, b: { name: "" }, c: null };
    assert.deepEqual(Object.keys(S.sanitizeNamedFilters(raw)), ["ok"]);
    const many = {};
    for (let i = 0; i < 60; i++) many["f" + i] = { name: "f" + i, types: [], criteria: [] };
    assert.strictEqual(Object.keys(S.sanitizeNamedFilters(many)).length, 50);
  });

  // ── previous selection ──
  t("recordPrevious / restorePrevious: clearing never erases; stale indices drop", () => {
    assert.deepEqual(S.recordPrevious([], [1, 2]), [1, 2]);
    assert.deepEqual(S.recordPrevious([1, 2], []), [1, 2]);
    assert.deepEqual(S.recordPrevious([1, 2], [3]), [3]);
    assert.deepEqual(S.restorePrevious([0, 2, 9, -1], 3), [0, 2]);
    assert.deepEqual(S.restorePrevious([], 3), []);
  });

  // ── viewer wiring markers ──
  const viewerSrc = fs.readFileSync(path.join(root, "src/features/cad-viewer.ts"), "utf8");
  const sessionSrc = fs.readFileSync(path.join(root, "src/modules/cad-viewer/session-state.ts"), "utf8");
  const has = (re, msg) => assert.ok(re.test(viewerSrc), msg);
  t("viewer: Sel18 imported and visible() honours the property criteria", () => {
    has(/import \* as Sel18 from "\.\.\/modules\/cad-viewer\/cad-selection-a18";/, "Sel18 import");
    has(/Sel18\.matchesFilterTree\(e, propFilter\)/, "visible() honours propFilter");
  });
  t("viewer: QSELECT dialog exists and bare QSELECT opens it", () => {
    has(/function openQSelectDialog\(\): void \{/, "openQSelectDialog defined");
    has(/if \(!what\) \{\s*\n\s*openQSelectDialog\(\);\s*\n\s*return;\s*\n\s*\}/, "bare QSELECT opens the dialog");
    has(/Sel18\.applyQSelect\(ents, candidates, criterion, mode, sel\)/, "dialog applies through applyQSelect");
    has(/if \(type !== "ALL"\) candidates = candidates\.filter\(\(i\) => ents\[i\]\.type === type\);/, "the chosen Object Type scopes the match");
    has(/data-r="qs-type"/, "dialog has a type picker");
    has(/data-r="qs-apply"/, "dialog has an Apply button");
  });
  t("viewer: FILTER dialog has property criteria and named filters", () => {
    has(/function applyFilterState\(types: Set<string>, tree: Sel18\.FilterNode \| null\): void \{/, "applyFilterState defined");
    has(/function saveNamedFilter\(name: string, types: Set<string>, tree: Sel18\.FilterNode \| null\): boolean \{/, "saveNamedFilter defined");
    has(/data-r="filter-picker-prop"/, "criteria property picker");
    has(/data-r="filter-add-criterion"/, "add-criterion button");
    has(/data-r="filter-save"/, "save named filter button");
    has(/data-filter-apply-name/, "named filter Apply");
    has(/data-filter-delete-name/, "named filter Delete");
  });
  t("viewer: PREVIOUS command, P option and previous-selection store", () => {
    has(/\{ name: "PREVIOUS", aliases: \["PREV"\]/, "PREVIOUS in the command table");
    has(/function restorePreviousSelection\(\): boolean \{/, "restorePreviousSelection defined");
    has(/prevSel = Sel18\.recordPrevious\(prevSel, \[\.\.\.sel\]\);/, "setSel records the previous selection");
    has(/\(cmd === "P" \|\| cmd === "PAN"\) && mod\?\.stage === "select"/, "P restores previous selection at a Select objects prompt");
    has(/cmd === "SELECT" && \(parts\[1\] \?\? ""\)\.toUpperCase\(\) === "PREVIOUS"/, "SELECT PREVIOUS accepted");
    has(/Select objects: \(click to add · P = previous selection · Enter \/ right-click to finish\)/, "mod prompt advertises P");
    has(/addItem\("Select Previous",\(\)=>restorePreviousSelection\(\),prevSel\.length===0\)/, "context menu restores previous selection");
  });
  t("viewer: named filters and property criteria persist per drawing", () => {
    has(/namedFilters: namedFilters\.size \? Sel18\.serializeNamedFilters\(namedFilters\) : undefined,/, "named filters captured in the session");
    has(/Sel18\.sanitizeNamedFilters\(sess\.namedFilters\)/, "named filters restored through the sanitizer");
    has(/propFilter = Sel18\.sanitizeFilterNode\(u\.propFilter\)/, "active property filter restored through the sanitizer");
    assert.ok(/propFilter\?: SessionFilterNode;/.test(sessionSrc), "SessionUi carries propFilter");
  });

  console.log(`\n=== Result: ${pass} passed, ${fail} failed ===`);
  if (fail) process.exit(1);
} catch (e) {
  console.log("FATAL: " + (e && e.message));
  process.exit(1);
}
