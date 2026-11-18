/**
 * Schedule ↔ classification bridge suite.
 *
 * Closes the gap "SCHEDULES still group by their own free-text rule/category
 * strings": industry classification codes assigned to elements (UniFormat II /
 * Uniclass 2015 EF / OmniClass Table 21) now reach every schedule as real row
 * values, group by full code or hierarchical prefix, and roll quantities up
 * with per-group subtotals. The assignments themselves travel with the
 * project document (previously browser-storage-only — a project opened on
 * another machine lost every code).
 *
 * Sections:
 *   A. Code tokenization — cumulative prefixes for all three published systems
 *   B. Hierarchical group cuts (classificationGroup depth semantics)
 *   C. Element resolution — deterministic first-assignment semantics
 *   D. Row values — coded vs uncoded elements
 *   E. Assignment persistence — serialize → JSON → restore round trip,
 *      tolerant restore, legacy-document no-op
 *   F. Group/subtotal roll-up integration (mirrors the generator's bucketing)
 *   G. Source pins — generator wiring, type union, template, column
 *      templates, project hooks, CI registration, DOM-free guard
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

/* ── Node compile helper (same flow as clash-scenarios suite) ────────── */
function compileFiles(relFiles) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "sched-class-"));
  const files = relFiles.map((f) => JSON.stringify(path.join(ROOT, f))).join(" ");
  execSync(
    `npx tsc ${files} --outDir ${JSON.stringify(out)} --module commonjs ` +
      `--target es2020 --skipLibCheck --strict --ignoreDeprecations 5.0`,
    { cwd: ROOT, stdio: "pipe" },
  );
  const found = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) found.push(p);
    }
  })(out);
  return found;
}

/* ── localStorage stub BEFORE requiring the classification module ─────── */
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

console.log("\n compiling schedule-classification.ts + classification/index.ts …");
const emitted = compileFiles([
  "src/modules/schedules/schedule-classification.ts",
  "src/modules/classification/index.ts",
]);
const bridgePath = emitted.find((p) => p.endsWith("schedule-classification.js"));
const classifPath = emitted.find((p) => p.endsWith("index.js") && p.includes("classification"));
assert.ok(bridgePath && classifPath, `both modules emitted: ${emitted.join(", ")}`);
const bridge = require(bridgePath);
const cl = require(classifPath);

/* Seeded tables (verified subsets — see classification.test.cjs) */
const EF = "uniclass-2015-ef", UF = "uniformat-ii", OC = "omniclass-21";
const systems = cl.listSystems();
assert.ok(systems.some((s) => s.id === EF), "uniclass table seeded");
assert.ok(systems.some((s) => s.id === UF), "uniformat table seeded");
assert.ok(systems.some((s) => s.id === OC), "omniclass table seeded");

console.log("\nA. classificationSegments — cumulative prefixes");
test("A1 Uniclass EF_25_10_25 → 4 cumulative prefixes", () => {
  assert.deepStrictEqual(
    bridge.classificationSegments("EF_25_10_25"),
    ["EF", "EF_25", "EF_25_10", "EF_25_10_25"],
  );
});
test("A2 OmniClass '21-02 20 10' → space-separated cumulative", () => {
  assert.deepStrictEqual(
    bridge.classificationSegments("21-02 20 10"),
    ["21-02", "21-02 20", "21-02 20 10"],
  );
});
test("A3 UniFormat B2010 → B → B2 → B2010 (letter + 3 digits)", () => {
  assert.deepStrictEqual(bridge.classificationSegments("B2010"), ["B", "B2", "B2010"]);
  assert.deepStrictEqual(bridge.classificationSegments("G2030"), ["G", "G2", "G2030"]);
});
test("A4 opaque / empty / junk → safe shapes", () => {
  assert.deepStrictEqual(bridge.classificationSegments("XYZ"), ["XYZ"]);
  assert.deepStrictEqual(bridge.classificationSegments(""), []);
  assert.deepStrictEqual(bridge.classificationSegments("   "), []);
  assert.deepStrictEqual(bridge.classificationSegments(null), []);
  assert.deepStrictEqual(bridge.classificationSegments(undefined), []);
  assert.deepStrictEqual(bridge.classificationSegments(42), ["42"]);
});

console.log("\nB. classificationGroup — depth cuts");
test("B1 Uniclass depth 2 → EF_25, depth 3 → EF_25_10, depth 1 → EF", () => {
  assert.strictEqual(bridge.classificationGroup("EF_25_10_25", 2), "EF_25");
  assert.strictEqual(bridge.classificationGroup("EF_25_10_25", 3), "EF_25_10");
  assert.strictEqual(bridge.classificationGroup("EF_25_10_25", 1), "EF");
});
test("B2 depth beyond hierarchy → full code", () => {
  assert.strictEqual(bridge.classificationGroup("EF_25_10_25", 9), "EF_25_10_25");
});
test("B3 non-integer depth clamps to ≥ 1", () => {
  assert.strictEqual(bridge.classificationGroup("EF_25_10_25", 0), "EF");
  assert.strictEqual(bridge.classificationGroup("EF_25_10_25", -3), "EF");
  assert.strictEqual(bridge.classificationGroup("EF_25_10_25", 2.9), "EF_25");
});
test("B4 OmniClass depth 2 → '21-02 20'; UniFormat depth 2 → B2", () => {
  assert.strictEqual(bridge.classificationGroup("21-02 20 10", 2), "21-02 20");
  assert.strictEqual(bridge.classificationGroup("B2010", 2), "B2");
  assert.strictEqual(bridge.classificationGroup("B2010", 3), "B2010");
});
test("B5 default depth is 2; empty code → ''", () => {
  assert.strictEqual(bridge.classificationGroup("EF_25_10_25"), "EF_25");
  assert.strictEqual(bridge.classificationGroup("", 2), "");
  assert.strictEqual(bridge.classificationGroup(null, 2), "");
});

console.log("\nC. resolveElementClassification — first-assignment semantics");
const SYS = systems;
test("C1 valid assignment resolves with system name + published title", () => {
  const r = bridge.resolveElementClassification(
    "w1",
    [{ elementId: "w1", systemId: EF, code: "EF_25_10_25" }],
    SYS,
  );
  assert.ok(r, "resolves");
  assert.strictEqual(r.code, "EF_25_10_25");
  assert.strictEqual(r.title, "External walls");
  assert.strictEqual(r.systemId, EF);
  assert.strictEqual(r.systemName, "Uniclass 2015 (EF)");
});
test("C2 code not in its system table → skipped, next assignment wins", () => {
  const r = bridge.resolveElementClassification(
    "w1",
    [
      { elementId: "w1", systemId: EF, code: "EF_99_99_99" }, // fabricated
      { elementId: "w1", systemId: UF, code: "B2010" },
    ],
    SYS,
  );
  assert.ok(r);
  assert.strictEqual(r.systemId, UF);
  assert.strictEqual(r.code, "B2010");
});
test("C3 unknown system skipped → null when nothing valid", () => {
  assert.strictEqual(
    bridge.resolveElementClassification("w1", [{ elementId: "w1", systemId: "nope", code: "X" }], SYS),
    null,
  );
  assert.strictEqual(
    bridge.resolveElementClassification("w1", [{ elementId: "w1", systemId: EF, code: "XX" }], SYS),
    null,
  );
});
test("C4 blank elementId and junk rows tolerated, never throws", () => {
  assert.strictEqual(bridge.resolveElementClassification("", [{ elementId: "", systemId: EF, code: "EF_25_10_25" }], SYS), null);
  // junk entries are skipped without throwing; the valid row among them matches:
  const r = bridge.resolveElementClassification("w1", [null, "junk", 42, { elementId: "w1", systemId: OC, code: "21-02 20 10" }], SYS);
  assert.ok(r);
  assert.strictEqual(r.systemName, "OmniClass Table 21 (Elements)");
  assert.strictEqual(r.code, "21-02 20 10");
});
test("C5 no assignments → null", () => {
  assert.strictEqual(bridge.resolveElementClassification("w1", [], SYS), null);
});

console.log("\nD. classificationRowValues");
test("D1 coded element → three populated values", () => {
  const v = bridge.classificationRowValues("w1", [{ elementId: "w1", systemId: EF, code: "EF_25_10_25" }], SYS);
  assert.strictEqual(v.classification, "EF_25_10_25");
  assert.strictEqual(v.classificationTitle, "External walls");
  assert.strictEqual(v.classificationSystem, "Uniclass 2015 (EF)");
});
test("D2 uncoded element → three empty strings (schedule renders 'Uncoded')", () => {
  const v = bridge.classificationRowValues("w2", [], SYS);
  assert.strictEqual(v.classification, "");
  assert.strictEqual(v.classificationTitle, "");
  assert.strictEqual(v.classificationSystem, "");
});

console.log("\nE. assignment persistence — project document round trip");
test("E1 setAssignment → serializeAssignments → JSON → restoreAssignments → identical", () => {
  store.clear();
  assert.strictEqual(cl.setAssignment("w1", EF, "EF_25_10_25").ok, true);
  assert.strictEqual(cl.setAssignment("w2", UF, "B2010").ok, true);
  assert.strictEqual(cl.setAssignment("w3", OC, "21-02 20 10").ok, true);
  const snap = JSON.parse(JSON.stringify(cl.serializeAssignments()));
  assert.strictEqual(snap.length, 3);
  // Persisted order is sorted (elementId, systemId, code) — deterministic.
  const sorted = [...snap].sort(
    (a, b) =>
      a.elementId.localeCompare(b.elementId) ||
      a.systemId.localeCompare(b.systemId) ||
      a.code.localeCompare(b.code),
  );
  assert.deepStrictEqual(snap, sorted);
  // Wipe the working copy, then restore from the document payload.
  store.clear();
  cl.restoreAssignments(snap);
  assert.deepStrictEqual(cl.serializeAssignments(), snap);
});
test("E2 restore tolerance: junk rows, unknown systems/codes, duplicates", () => {
  store.clear();
  cl.restoreAssignments([
    null,
    "junk",
    42,
    { elementId: "w1", systemId: EF, code: "EF_25_10_25" },
    { elementId: "w1", systemId: EF, code: "EF_25_10_25" }, // duplicate collapses
    { elementId: "  w2  ", systemId: UF, code: " B2010 " }, // trimmed
    { elementId: "w3", systemId: "ghost", code: "X" }, // unknown system dropped
    { elementId: "w3", systemId: EF, code: "EF_00_00_00" }, // unknown code dropped
    { elementId: "", systemId: EF, code: "EF_25_10_25" }, // blank field dropped
  ]);
  const list = cl.serializeAssignments();
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual(list, [
    { elementId: "w1", systemId: EF, code: "EF_25_10_25" },
    { elementId: "w2", systemId: UF, code: "B2010" },
  ]);
});
test("E3 legacy documents: restoreAssignments(null) and undefined are no-ops", () => {
  const before = cl.serializeAssignments();
  cl.restoreAssignments(null);
  cl.restoreAssignments(undefined);
  assert.deepStrictEqual(cl.serializeAssignments(), before);
});
test("E4 restoreAssignments([]) clears the working copy", () => {
  assert.ok(cl.serializeAssignments().length > 0, "precondition: non-empty");
  cl.restoreAssignments([]);
  assert.strictEqual(cl.serializeAssignments().length, 0);
});
test("E5 non-array payload → empty set (defensive, never throws)", () => {
  cl.restoreAssignments({ elementId: "w1" });
  cl.restoreAssignments("junk");
  assert.strictEqual(cl.serializeAssignments().length, 0);
});

console.log("\nF. group/subtotal roll-up integration (generator bucket semantics)");
test("F1 hierarchical buckets partition rows; per-group sums match the grand total", () => {
  // Mirror bucketValue(): classificationGroup at depth 2, uncoded → label.
  const UNCODED = bridge.UNCODED_LABEL;
  const rows = [
    { id: "w1", code: "EF_25_10_25", volume: 23.271 },
    { id: "w2", code: "EF_25_10_25", volume: 63.872 },
    { id: "d1", code: "B2010", volume: 1.5 },
    { id: "x1", code: "", volume: 4.25 }, // uncoded element
  ];
  const buckets = new Map();
  for (const r of rows) {
    const key = r.code ? bridge.classificationGroup(r.code, 2) : UNCODED;
    const arr = buckets.get(key) ?? [];
    arr.push(r);
    buckets.set(key, arr);
  }
  assert.deepStrictEqual([...buckets.keys()].sort(), ["B2", "EF_25", UNCODED].sort());
  let grand = 0;
  for (const [key, group] of buckets) {
    const s = group.reduce((a, r) => a + r.volume, 0);
    grand += s;
    if (key === "EF_25") assert.ok(Math.abs(s - (23.271 + 63.872)) < 1e-9, "EF_25 subtotal");
    if (key === "B2") assert.strictEqual(s, 1.5, "B2 subtotal (both B2010 walls under B2)");
    if (key === UNCODED) assert.strictEqual(s, 4.25, "Uncoded subtotal");
  }
  const expected = rows.reduce((a, r) => a + r.volume, 0);
  assert.ok(Math.abs(grand - expected) < 1e-9, "per-group subtotals add up to the grand total");
});
test("F2 full-code level keeps separate codes that share a group prefix", () => {
  const a = bridge.classificationGroup("EF_25_10_25", 3);
  const b = bridge.classificationGroup("EF_25_30_97", 3);
  assert.strictEqual(bridge.classificationGroup("EF_25_10_25", 2), bridge.classificationGroup("EF_25_30_97", 2));
  assert.notStrictEqual(a, b);
});

console.log("\nG. source pins — wiring survives refactors");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const gen = read("src/modules/schedules/schedule-generator.ts");
const types = read("src/modules/schedules/schedule-types.ts");
const templates = read("src/modules/schedules/schedule-templates.ts");
const builder = read("src/modules/schedules/schedule-builder.ts");
const projects = read("src/modules/projects/projects.ts");
const projTypes = read("src/modules/projects/types.ts");
const classifSrc = read("src/modules/classification/index.ts");
const pkg = JSON.parse(read("package.json"));
const ci = read("scripts/ci-unit-tests.mjs");
const panel = read("src/features/schedules-panel.ts");

test("G1 generator resolves assignments into row values", () => {
  assert.ok(
    gen.includes("classificationRowValues(el.id, getAssignments(), listSystems())"),
    "authoredRow resolves the element classification",
  );
  assert.ok(gen.includes('from "./schedule-classification"'), "generator imports the bridge");
  assert.ok(gen.includes('from "../classification"'), "generator imports the classification module");
});
test("G2 generator applies the classification buckets with the Uncoded label", () => {
  assert.ok(gen.includes('bucket === "classificationGroup" || bucket === "classificationSub"'), "group/sub buckets");
  assert.ok(gen.includes('bucket === "classification"'), "full-code bucket");
  assert.ok(gen.includes("UNCODED_LABEL"), "uncoded label from the bridge");
});
test("G3 GroupLevel bucket union declares all three classification buckets", () => {
  assert.ok(types.includes('| "classification"'), "full code");
  assert.ok(types.includes('| "classificationGroup"'), "2-level prefix");
  assert.ok(types.includes('| "classificationSub"'), "3-level prefix");
});
test("G4 built-in Classification Takeoff template exists with hierarchy grouping", () => {
  assert.ok(templates.includes('"tpl-classification"'), "template id");
  assert.ok(templates.includes('GB("classification", "classificationGroup")'), "group-level bucket");
  assert.ok(templates.includes('GB("classification", "classification")'), "code-level bucket");
  assert.ok(templates.includes("Uncoded"), "uncoded rows documented");
});
test("G5 column templates ship classification / title / system", () => {
  assert.ok(builder.includes('key: "classification"'), "code column");
  assert.ok(builder.includes('key: "classificationTitle"'), "title column");
  assert.ok(builder.includes('key: "classificationSystem"'), "system column");
});
test("G6 project document carries classificationAssignments (save + restore + type)", () => {
  assert.ok(
    projects.includes("(current as any).classificationAssignments = cl.serializeAssignments();"),
    "saveProject flushes assignments",
  );
  assert.ok(
    projects.includes("cl.restoreAssignments((doc as any).classificationAssignments);"),
    "openProject restores assignments",
  );
  assert.ok(
    projects.includes("(doc as any).classificationAssignments != null"),
    "legacy documents keep their working copy",
  );
  assert.ok(projTypes.includes("classificationAssignments?: unknown[]"), "document type field");
});
test("G7 classification module exposes the persistence pair; palette marks dirty", () => {
  assert.ok(classifSrc.includes("export function serializeAssignments()"), "serialize");
  assert.ok(classifSrc.includes("export function restoreAssignments(raw: unknown): void"), "restore");
  const palette = read("src/features/property-palette.ts");
  assert.ok(palette.includes("import { markDirty } from"), "palette imports markDirty");
  assert.ok(palette.includes("try { markDirty(); } catch { /* */ }"), "assignment changes flag the project dirty");
});
test("G8 CI registers the suite", () => {
  assert.ok(pkg.scripts["test:schedule-classification"] === "node tests/schedule-classification.test.cjs", "package.json script");
  assert.ok(ci.includes('"test:schedule-classification"'), "battery list entry");
});
test("G9 panel grouping prompt mentions the classification keys", () => {
  assert.ok(panel.includes("classification, classificationSystem"), "prompt hint");
});
test("G10 schedule-classification.ts stays DOM-free (Node-compilable forever)", () => {
  const src = read("src/modules/schedules/schedule-classification.ts");
  assert.ok(!/window\./.test(src), "no window");
  assert.ok(!/document\./.test(src), "no document");
  assert.ok(!/localStorage/.test(src), "no storage reads — data arrives as arguments");
  assert.ok(!/__obs/.test(src), "no observability mentions");
  assert.ok(!/from ["']three/.test(src), "no scene graph");
});

console.log(`\n all ${passed} assertions passed`);
