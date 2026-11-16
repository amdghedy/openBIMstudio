/**
 * Classification systems unit tests — pure module from
 * src/modules/classification/index.ts (house pattern: compile with tsc, require).
 *
 * Locks the semantics that make this real classification data and not a
 * made-up table:
 *   • the seed subsets are present with VERIFIED codes/titles (UniFormat II
 *     Level 1-3 incl. sitework from NISTIR 6389; Uniclass 2015 EF from the
 *     published NBS table; OmniClass Table 21 extracts)
 *   • codes are unique per system, every code has a title and a sane level
 *   • assignments are validated (unknown system/code/element rejected with a
 *     reason), one code per (element, system), removal by null
 *   • assignments pointing at unknown systems or codes are dropped on read —
 *     stale storage can never resurrect a fabricated code
 *   • search ranks prefix/exact matches first and respects the limit
 *   • CSV import extends built-ins only, dedupes, reports malformed rows and
 *     honours the per-system cap
 *   • buildIfcClassifications groups by system, restricts to exported
 *     elements and maps 1:1 onto the IfcClassificationInput shape
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

// Node has no localStorage — the module persists assignments/imports there.
const mem = new Map();
globalThis.localStorage = {
  getItem(k) { return mem.has(k) ? mem.get(k) : null; },
  setItem(k, v) { mem.set(k, String(v)); },
  removeItem(k) { mem.delete(k); },
};

const out = fs.mkdtempSync(path.join(os.tmpdir(), "classif-"));
execSync(
  `npx tsc src/modules/classification/index.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict --ignoreDeprecations 5.0`,
  { stdio: "inherit" },
);
const compiled = fs.existsSync(path.join(out, "classification", "index.js"))
  ? path.join(out, "classification", "index.js")
  : path.join(out, "index.js");
assert.ok(fs.existsSync(compiled), "expected compiled module — got: " +
  JSON.stringify(fs.readdirSync(out, { recursive: true })));
let m = require(compiled);

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };

/* ── seed integrity ─────────────────────────────────────────────────────── */

t("three built-in systems with stable ids", () => {
  const sys = m.listSystems();
  assert.deepStrictEqual(sys.map((s) => s.id), ["uniformat-ii", "uniclass-2015-ef", "omniclass-21"]);
});

t("UniFormat II: full Level 1-3 subset incl. sitework, verified codes", () => {
  const s = m.getSystem("uniformat-ii");
  assert.ok(s.codes.length >= 100, "expected >=100 codes, got " + s.codes.length);
  const get = (c) => s.codes.find((x) => x.code === c);
  assert.strictEqual(get("A1010").title, "Standard Foundations");
  assert.strictEqual(get("B2010").title, "Exterior Walls");
  assert.strictEqual(get("C1010").title, "Partitions");
  assert.strictEqual(get("C3030").title, "Ceiling Finishes");
  assert.strictEqual(get("D3040").title, "Distribution Systems");
  assert.strictEqual(get("F2020").title, "Hazardous Components Abatement");
  assert.strictEqual(get("G2030").title, "Pedestrian Paving");
  assert.strictEqual(get("G9090").title, "Other Site Systems & Equipment");
  assert.strictEqual(get("B2010").level, 3);
  assert.strictEqual(get("B20").level, 2);
  assert.strictEqual(get("B").level, 1);
});

t("Uniclass 2015 EF: verified starter subset from the published NBS table", () => {
  const s = m.getSystem("uniclass-2015-ef");
  assert.ok(s.codes.length >= 30, "expected >=30 codes, got " + s.codes.length);
  const get = (c) => s.codes.find((x) => x.code === c);
  assert.strictEqual(get("EF_25_10_25").title, "External walls");
  assert.strictEqual(get("EF_25_10_40").title, "Internal walls");
  assert.strictEqual(get("EF_25_30_25").title, "Doors");
  assert.strictEqual(get("EF_25_30_97").title, "Windows");
  assert.strictEqual(get("EF_30_20_93").title, "Upper floors");
  assert.strictEqual(get("EF_30_10").title, "Roofs");
  assert.strictEqual(get("EF_35_10_40").title, "Internal stairs");
  assert.strictEqual(get("EF_25_10_25").level, 3);
  assert.strictEqual(get("EF_25_10").level, 2);
  assert.strictEqual(get("EF_25").level, 1);
  assert.ok(s.location && s.location.includes("identifier.buildingsmart.org"), "Uniclass carries its bS identifier URI");
});

t("OmniClass Table 21: verified subset, deep level-5 codes", () => {
  const s = m.getSystem("omniclass-21");
  assert.ok(s.codes.length >= 10, "expected >=10 codes, got " + s.codes.length);
  const get = (c) => s.codes.find((x) => x.code === c);
  assert.strictEqual(get("21-02 20 10").title, "Exterior Walls");
  assert.strictEqual(get("21-02 20 20").title, "Exterior Windows");
  assert.strictEqual(get("21-01 10 10 10").title, "Wall Foundations");
  assert.strictEqual(get("21-02 20 20 30").title, "Exterior Window Wall");
  assert.strictEqual(get("21-01 10 10 10").level, 4);
  assert.strictEqual(get("21-02 20 20 30").level, 4);
  assert.strictEqual(get("21-02 20 10").level, 3);
  assert.strictEqual(get("21-02 10").level, 2);
});

t("every seed code is unique with a non-empty title and sane level", () => {
  for (const s of m.listSystems()) {
    const seen = new Set();
    for (const c of s.codes) {
      assert.ok(!seen.has(c.code), `duplicate code ${c.code} in ${s.id}`);
      seen.add(c.code);
      assert.ok(c.title && c.title.trim(), `empty title for ${c.code}`);
      assert.ok(Number.isInteger(c.level) && c.level >= 1 && c.level <= 5, `bad level ${c.level} for ${c.code}`);
    }
  }
});

/* ── assignment store ───────────────────────────────────────────────────── */

t("setAssignment validates: unknown system, unknown code, empty element", () => {
  assert.strictEqual(m.setAssignment("", "uniformat-ii", "B2010").ok, false);
  assert.ok(m.setAssignment("", "uniformat-ii", "B2010").reason.includes("elementId"));
  assert.strictEqual(m.setAssignment("w1", "nope-9x", "B2010").ok, false);
  assert.ok(m.setAssignment("w1", "nope-9x", "B2010").reason.includes("unknown classification system"));
  assert.strictEqual(m.setAssignment("w1", "uniformat-ii", "Z9999").ok, false);
  assert.ok(m.setAssignment("w1", "uniformat-ii", "Z9999").reason.includes("unknown UniFormat II code"));
});

t("assign → read → replace → remove, one code per (element, system)", () => {
  mem.clear();
  assert.deepStrictEqual(m.getAssignments(), []);
  assert.strictEqual(m.setAssignment("w1", "uniformat-ii", "B2010").ok, true);
  assert.strictEqual(m.setAssignment("w1", "uniclass-2015-ef", "EF_25_10_25").ok, true);
  let asg = m.getElementAssignments("w1");
  assert.strictEqual(asg.length, 2);
  // replacing the UniFormat code must not duplicate the slot
  assert.strictEqual(m.setAssignment("w1", "uniformat-ii", "C1010").ok, true);
  asg = m.getElementAssignments("w1");
  assert.strictEqual(asg.length, 2);
  assert.strictEqual(asg.find((a) => a.systemId === "uniformat-ii").code, "C1010");
  // remove by null
  assert.strictEqual(m.setAssignment("w1", "uniformat-ii", null).ok, true);
  asg = m.getElementAssignments("w1");
  assert.strictEqual(asg.length, 1);
  assert.strictEqual(asg[0].systemId, "uniclass-2015-ef");
  // empty string also removes
  assert.strictEqual(m.setAssignment("w1", "uniclass-2015-ef", "").ok, true);
  assert.deepStrictEqual(m.getElementAssignments("w1"), []);
});

t("stale storage entries (unknown system/code) are dropped on read", () => {
  mem.clear();
  m.setAssignment("w2", "uniformat-ii", "B2010");
  const raw = JSON.parse(mem.get("obs.classification.assignments"));
  raw.push({ elementId: "ghost", systemId: "deleted-system", code: "X0000" });
  raw.push({ elementId: "w2", systemId: "uniformat-ii", code: "NOT-A-CODE" });
  raw.push({ elementId: "", systemId: "uniformat-ii", code: "B2010" });
  mem.set("obs.classification.assignments", JSON.stringify(raw));
  const asg = m.getAssignments();
  assert.strictEqual(asg.length, 1, "only the valid assignment survives");
  assert.strictEqual(asg[0].elementId, "w2");
  assert.strictEqual(asg[0].code, "B2010");
});

t("corrupted assignment JSON reads back as empty, never throws", () => {
  mem.set("obs.classification.assignments", "{not json");
  assert.deepStrictEqual(m.getAssignments(), []);
  mem.set("obs.classification.assignments", "42");
  assert.deepStrictEqual(m.getAssignments(), []);
});

t("assignments survive a module reload (localStorage persistence)", () => {
  mem.clear();
  assert.strictEqual(m.setAssignment("w3", "uniclass-2015-ef", "EF_25_30_97").ok, true);
  delete require.cache[require.resolve(compiled)];
  m = require(compiled);
  const asg = m.getElementAssignments("w3");
  assert.strictEqual(asg.length, 1);
  assert.strictEqual(asg[0].code, "EF_25_30_97");
  assert.strictEqual(asg[0].systemId, "uniclass-2015-ef");
});

/* ── search ─────────────────────────────────────────────────────────────── */

t("searchCodes ranks exact/prefix code hits first", () => {
  const r = m.searchCodes("uniclass-2015-ef", "EF_25_10_25");
  assert.strictEqual(r[0].code, "EF_25_10_25");
  const r2 = m.searchCodes("uniformat-ii", "B20");
  assert.ok(r2.some((c) => c.code === "B2010"), "prefix search finds B2010");
  assert.ok(r2.some((c) => c.code === "B2020"));
  assert.strictEqual(r2[0].rank === undefined, true, "public shape is plain codes");
});

t("searchCodes matches titles case-insensitively and honours the limit", () => {
  const all = m.searchCodes("uniformat-ii", "walls");
  assert.ok(all.length >= 2, "walls matches Exterior Walls + Basement Walls");
  assert.ok(all.every((c) => c.title.toLowerCase().includes("walls")));
  const limited = m.searchCodes("uniformat-ii", "", 5);
  assert.strictEqual(limited.length, 5);
  const kw = m.searchCodes("uniclass-2015-ef", "partition");
  assert.strictEqual(kw[0].code, "EF_25_10_40", "keyword 'partition' lands Internal walls (title substring)");
});

t("searchCodes on an unknown system returns empty", () => {
  assert.deepStrictEqual(m.searchCodes("nope-9x", "walls"), []);
});

/* ── CSV import ─────────────────────────────────────────────────────────── */

t("importCodesFromCsv extends a built-in system, dedupes and skips the header", () => {
  mem.clear();
  const csv = [
    "Code,Title",
    "EF_25_10_25,External walls",            // duplicate of the seed → skipped
    "EF_25_10_99,Imported test wall",
    "EF_30_99_10,Imported test roof,roof;test",  // keywords live in CSV column 3
    "",
  ].join("\n");
  const r = m.importCodesFromCsv("uniclass-2015-ef", csv);
  assert.strictEqual(r.ok, true, "errors: " + JSON.stringify(r.errors));
  assert.strictEqual(r.added, 2);
  assert.strictEqual(r.skipped, 1);
  const s = m.getSystem("uniclass-2015-ef");
  const added = s.codes.find((c) => c.code === "EF_25_10_99");
  assert.ok(added, "imported code is visible through getSystem");
  assert.strictEqual(added.title, "Imported test wall");
  const kw = s.codes.find((c) => c.code === "EF_30_99_10");
  assert.deepStrictEqual(kw.keywords, ["roof", "test"]);
});

t("importCodesFromCsv reports malformed rows and enforces the cap", () => {
  mem.clear();
  const r = m.importCodesFromCsv("uniformat-ii", "GOODCODE,First\n,\nOTHER,Second", { maxCodes: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.added, 1, "cap of 1 stops after GOODCODE");
  assert.ok(r.errors.some((e) => e.includes("code and title are required")));
  assert.ok(r.errors.some((e) => e.includes("1-code cap")));
});

t("importCodesFromCsv rejects unknown systems and never replaces seeds", () => {
  const r = m.importCodesFromCsv("nope-9x", "A,AAA");
  assert.strictEqual(r.ok, false);
  assert.ok(r.reason.includes("unknown classification system"));
  const s = m.getSystem("uniformat-ii");
  assert.ok(!s.codes.some((c) => c.code === "A" && c.title === "AAA"), "seed table untouched");
});

/* ── IFC payload ────────────────────────────────────────────────────────── */

t("buildIfcClassifications groups by system and restricts to exported elements", () => {
  mem.clear();
  assert.strictEqual(m.setAssignment("e1", "uniformat-ii", "B2010").ok, true);
  assert.strictEqual(m.setAssignment("e2", "uniformat-ii", "B2010").ok, true);
  assert.strictEqual(m.setAssignment("e1", "uniclass-2015-ef", "EF_25_10_25").ok, true);
  assert.strictEqual(m.setAssignment("ghost", "omniclass-21", "21-02 20 10").ok, true);
  const out = m.buildIfcClassifications([{ id: "e1" }, { id: "e2" }, { id: "unrelated" }]);
  assert.strictEqual(out.length, 2);
  const uni = out.find((s) => s.id === "uniformat-ii");
  assert.strictEqual(uni.name, "UniFormat II");
  assert.strictEqual(uni.edition, "ASTM E1557-97 / NISTIR 6389 (1999)");
  assert.deepStrictEqual(uni.items.map((i) => i.elementId), ["e1", "e2"], "items sorted by element");
  const uc = out.find((s) => s.id === "uniclass-2015-ef");
  assert.strictEqual(uc.items.length, 1);
  assert.strictEqual(uc.items[0].code, "EF_25_10_25");
  assert.ok(uc.location.includes("identifier.buildingsmart.org"), "system location rides along for IFC");
  assert.ok(!out.find((s) => s.id === "omniclass-21"), "assignment to a non-exported element is excluded");
});

t("buildIfcClassifications with no assignments returns empty", () => {
  mem.clear();
  assert.deepStrictEqual(m.buildIfcClassifications([{ id: "e1" }]), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
