/* Clash scenarios — project-document persistence + clash matrix (scenario-io.ts).
 *
 * Round-15: saved clash scenarios (named tests) used to live only in
 * localStorage, so a project opened on another machine lost every saved
 * test. They now serialize into the project document (clashScenarios) and
 * the HTML report carries a category × category clash matrix.
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");

const out = fs.mkdtempSync(path.join(os.tmpdir(), "csc-"));
execSync(`npx tsc src/modules/clash/scenario-io.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict --ignoreDeprecations 5.0`, { stdio: "inherit" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const m = require(find(out, "scenario-io.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n) } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message) } };

const fullScenario = {
  id: "sc-1",
  name: "Duct vs Structure",
  createdAt: 1765300000000,
  updatedAt: 1765300005000,
  testName: "Level 1 coordination",
  tolerance: 0.005,
  clearance: 0.05,
  cropMargin: 0.3,
  scope: "both",
  method: "hard-triangle",
  selectionA: ["IFCWALL", "IFCBEAM"],
  selectionB: ["IFCDUCT", "IFCPIPE"],
  clashStates: {
    "model-a:12|model-b:7|intersect": {
      status: "approved",
      assignee: "Dana",
      updatedAt: 1765300004123,
      comments: [
        { id: "c1", author: "Dana", date: 1765300004100, text: "Reroute through shaft — approved as-is." },
      ],
    },
  },
  lastRun: { total: 3, intersect: 2, touching: 0, clearance: 1, duplicate: 0, at: 1765300005000 },
};

/* ── A. serialization dialect ─────────────────────────────────────────── */

t("A1 fully-populated scenario survives serialize → JSON → parse", () => {
  const clean = m.serializeScenarios([fullScenario]);
  assert.strictEqual(clean.length, 1);
  const back = m.parseScenarios(JSON.parse(JSON.stringify(clean)));
  assert.deepStrictEqual(back, clean);
  const s = back[0];
  assert.strictEqual(s.id, "sc-1");
  assert.strictEqual(s.name, "Duct vs Structure");
  assert.strictEqual(s.testName, "Level 1 coordination");
  assert.strictEqual(s.tolerance, 0.005);
  assert.strictEqual(s.clearance, 0.05);
  assert.strictEqual(s.cropMargin, 0.3);
  assert.strictEqual(s.scope, "both");
  assert.strictEqual(s.method, "hard-triangle");
  assert.deepStrictEqual(s.selectionA, ["IFCWALL", "IFCBEAM"]);
  assert.deepStrictEqual(s.selectionB, ["IFCDUCT", "IFCPIPE"]);
  const st = s.clashStates["model-a:12|model-b:7|intersect"];
  assert.strictEqual(st.status, "approved");
  assert.strictEqual(st.assignee, "Dana");
  assert.strictEqual(st.updatedAt, 1765300004123);
  assert.strictEqual(st.comments.length, 1);
  assert.strictEqual(st.comments[0].text, "Reroute through shaft — approved as-is.");
  assert.deepStrictEqual(s.lastRun, { total: 3, intersect: 2, touching: 0, clearance: 1, duplicate: 0, at: 1765300005000 });
});

t("A2 serialize→parse is the same dialect (writer = reader)", () => {
  const clean = m.serializeScenarios([fullScenario]);
  assert.deepStrictEqual(m.serializeScenarios(clean), clean);
});

t("A3 malformed rows are dropped without throwing", () => {
  const list = m.parseScenarios([null, "junk", 42, {}, fullScenario]);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].id, "sc-1");
});

t("A4 rows without an id, or with duplicate ids, are dropped", () => {
  const noId = { ...fullScenario, id: "   " };
  const dup = [{ ...fullScenario }, { ...fullScenario, name: "Second" }];
  const a = m.parseScenarios([noId]);
  assert.strictEqual(a.length, 0);
  const b = m.parseScenarios(dup);
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].name, "Duct vs Structure");
});

t("A5 unknown statuses reset to 'new'; whitelist is the five review states", () => {
  const s = m.parseScenarios([{ id: "x", clashStates: { k: { status: "bogus" } } }])[0];
  assert.strictEqual(s.clashStates.k.status, "new");
  for (const ok of ["new", "active", "reviewed", "approved", "resolved"]) {
    const r = m.parseScenarios([{ id: "x", clashStates: { k: { status: ok } } }])[0];
    assert.strictEqual(r.clashStates.k.status, ok);
  }
});

t("A6 comment rows without text are dropped; ids/fields coerced", () => {
  const s = m.parseScenarios([{
    id: "x",
    clashStates: { k: { comments: [{ author: "A", text: "keep me" }, null, { text: "" }, { id: "c9", author: 42, text: "coerce" }] } },
  }])[0];
  const c = s.clashStates.k.comments;
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c[0].id, "c-1"); // fallback id generated positionally
  assert.strictEqual(c[1].id, "c9");
  assert.strictEqual(c[1].author, ""); // non-string author coerced
});

t("A7 scenario cap: a 250-row payload keeps only the first 200", () => {
  const rows = [];
  for (let i = 0; i < 250; i++) rows.push({ id: `s${i}`, name: `n${i}` });
  const list = m.parseScenarios(rows);
  assert.strictEqual(list.length, 200);
  assert.strictEqual(list[199].id, "s199");
});

t("A8 selection keys: non-strings dropped, dupes deduped", () => {
  const s = m.parseScenarios([{ id: "x", selectionA: ["A", "A", 3, null, "B"], selectionB: "not-an-array" }])[0];
  assert.deepStrictEqual(s.selectionA, ["A", "B"]);
  assert.deepStrictEqual(s.selectionB, []);
});

t("A9 numeric coercion: negatives clamp to 0, junk falls back, over-cap clamps to cap", () => {
  const s = m.parseScenarios([{ id: "x", tolerance: -5, clearance: "junk", cropMargin: 99 }])[0];
  assert.strictEqual(s.tolerance, 0);
  assert.strictEqual(s.clearance, 0);
  assert.strictEqual(s.cropMargin, 10); // 99 exceeds the 10 cap → clamped
  const d = m.parseScenarios([{ id: "y" }])[0]; // absent cropMargin → fallback 0.3
  assert.strictEqual(d.cropMargin, 0.3);
});

t("A10 object wrapper and junk payloads: {clashScenarios:[…]} accepted, garbage → []", () => {
  const wrapped = m.parseScenarios({ clashScenarios: [fullScenario] });
  assert.strictEqual(wrapped.length, 1);
  assert.deepStrictEqual(m.parseScenarios("nope"), []);
  assert.deepStrictEqual(m.parseScenarios({ clashScenarios: "nope" }), []);
  assert.deepStrictEqual(m.parseScenarios(null), []);
});

t("A11 name/testName fallbacks and scope whitelist", () => {
  const s = m.parseScenarios([{ id: "x", scope: "bogus-scope", method: 42 }])[0];
  assert.strictEqual(s.name, "Scenario");
  assert.strictEqual(s.testName, "Test 1");
  assert.strictEqual(s.scope, undefined);
  assert.strictEqual(s.method, undefined);
  const s2 = m.parseScenarios([{ id: "y", scope: "aOnly", method: "convex-gjk" }])[0];
  assert.strictEqual(s2.scope, "aOnly");
  assert.strictEqual(s2.method, "convex-gjk");
});

/* ── B. run summary ───────────────────────────────────────────────────── */

t("B1 summarizeRun counts by kind, unknown kinds keep their own bucket", () => {
  const sum = m.summarizeRun([
    { kind: "intersect" }, { kind: "intersect" }, { kind: "touching" },
    { kind: "clearance" }, { kind: "duplicate" }, { kind: "exotic" },
    null, { kind: "" },
  ]);
  assert.strictEqual(sum.total, 7);
  assert.strictEqual(sum.byKind.intersect, 2);
  assert.strictEqual(sum.byKind.touching, 1);
  assert.strictEqual(sum.byKind.clearance, 1);
  assert.strictEqual(sum.byKind.duplicate, 1);
  assert.strictEqual(sum.byKind.other, 1); // empty string → 'other'
  assert.strictEqual(sum.byKind.exotic, 1);
});

/* ── C. clash matrix ──────────────────────────────────────────────────── */

t("C1 matrix is order-normalized: wall×duct and duct×wall are one cell", () => {
  const m1 = m.buildClashMatrix([
    { a: { category: "Wall" }, b: { category: "Duct" } },
    { a: { category: "Duct" }, b: { category: "Wall" } },
  ]);
  assert.strictEqual(m1.total, 2);
  assert.deepStrictEqual(m1.categories, ["Duct", "Wall"]);
  assert.strictEqual(m1.cells.length, 1);
  assert.strictEqual(m1.cells[0].a, "Duct"); // lexicographic low first
  assert.strictEqual(m1.cells[0].b, "Wall");
  assert.strictEqual(m1.cells[0].count, 2);
});

t("C2 same-category clashes land on the diagonal as one cell", () => {
  const m1 = m.buildClashMatrix([
    { a: { category: "Wall" }, b: { category: "Wall" } },
    { a: { category: "Wall" }, b: { category: "Wall" } },
    { a: { category: "Wall" }, b: { category: "Wall" } },
  ]);
  assert.strictEqual(m1.categories.length, 1);
  assert.strictEqual(m1.cells.length, 1);
  assert.deepStrictEqual([m1.cells[0].a, m1.cells[0].b], ["Wall", "Wall"]);
  assert.strictEqual(m1.cells[0].count, 3);
});

t("C3 cells sorted, categories sorted, totals honest", () => {
  const m1 = m.buildClashMatrix([
    { a: { category: "Pipe" }, b: { category: "Beam" } },
    { a: { category: "Beam" }, b: { category: "Duct" } },
    { a: { category: "Duct" }, b: { category: "Wall" } },
    { a: { category: "Pipe" }, b: { category: "Beam" } },
  ]);
  assert.deepStrictEqual(m1.categories, ["Beam", "Duct", "Pipe", "Wall"]);
  const keys = m1.cells.map((c) => `${c.a}|${c.b}`);
  assert.deepStrictEqual(keys, ["Beam|Duct", "Beam|Pipe", "Duct|Wall"]);
  assert.strictEqual(m1.total, 4);
  assert.deepStrictEqual(m1.cells.map((c) => c.count), [1, 2, 1]);
});

t("C4 missing categories fall into 'Uncategorized'; empty input → empty matrix", () => {
  const m1 = m.buildClashMatrix([
    { a: {}, b: { category: "Duct" } },
    { a: { category: "" }, b: { category: "Wall" } },
  ]);
  assert.deepStrictEqual(m1.categories, ["Duct", "Uncategorized", "Wall"]);
  assert.strictEqual(m1.total, 2);
  const empty = m.buildClashMatrix([]);
  assert.deepStrictEqual(empty, { categories: [], cells: [], total: 0 });
});

t("C5 matrix JSON is deterministic (same input → same document)", () => {
  const rows = [
    { a: { category: "Wall" }, b: { category: "Duct" } },
    { a: { category: "Duct" }, b: { category: "Wall" } },
    { a: { category: "Wall" }, b: { category: "Wall" } },
  ];
  assert.strictEqual(
    JSON.stringify(m.buildClashMatrix(rows)),
    JSON.stringify(m.buildClashMatrix([...rows].reverse())),
  );
});

/* ── D. source-level guards (the browser uses this exact module) ─────── */

t("D1 scenario-io is DOM-free: no window/document/three and no window.__obs globals", () => {
  const src = fs.readFileSync("src/modules/clash/scenario-io.ts", "utf8");
  assert.ok(!/window\./.test(src), "no window access");
  assert.ok(!/document\./.test(src), "no document access");
  assert.ok(!/__obs/.test(src), "no honesty-ratchet globals");
  assert.ok(!/from ["']three["']/.test(src), "no THREE dependency");
});

t("D2 project save/restore wiring is pinned in source", () => {
  const projects = fs.readFileSync("src/modules/projects/projects.ts", "utf8");
  assert.ok(
    projects.includes("(current as any).clashScenarios = clash?.serializeScenarios?.() ?? [];"),
    "saveProject flushes clashScenarios",
  );
  assert.ok(
    projects.includes("clash?.restoreScenarios?.((doc as any).clashScenarios);"),
    "openProject restores clashScenarios",
  );
  assert.ok(
    projects.includes("if ((doc as any).clashScenarios != null)"),
    "legacy projects without scenarios keep their localStorage working copy",
  );
});

t("D3 ClashService interface declares the scenario persistence pair", () => {
  const svc = fs.readFileSync("src/core/services.ts", "utf8");
  assert.ok(/serializeScenarios\(\): unknown\[\];/.test(svc));
  assert.ok(/restoreScenarios\(raw: unknown\): void;/.test(svc));
});

t("D4 clash.ts service actually registers both methods", () => {
  const src = fs.readFileSync("src/features/clash.ts", "utf8");
  assert.ok(src.includes("serializeScenarios: () => serializeScenarios(listScenarios())"));
  assert.ok(src.includes("restoreScenarios: (raw: unknown) =>"));
  assert.ok(src.includes("import { serializeScenarios, parseScenarios } from \"../modules/clash/scenario-io\";"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
