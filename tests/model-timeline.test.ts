/**
 * Model history / time-travel — node suite (differentiation item 7).
 *
 * Runs the REAL pure timeline core in Node (transpile-only, as the repo's
 * own suites do): the project diff, the version-row builder, and the
 * content hash. The IndexedDB journal (capture, list, restore) cannot run
 * in Node without faking the store — which would prove nothing — so it is
 * proven by tests/e2e/model-timeline.spec.ts instead.
 *
 * Run: npx tsx tests/model-timeline.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as assert from "node:assert";
import Module from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const loadTs = (file: string) => {
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const m = new Module(file);
  m.filename = file;
  m.paths = (Module as any)._nodeModulePaths(path.dirname(file));
  (m as any)._compile(js, file);
  return m.exports;
};
const core = loadTs(path.join(ROOT, "src/modules/history/model-timeline-core.ts"));

const el = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "wall", params: { height: 3, ...extra } });

let pass = 0, fail = 0;
const results: string[] = [];
const t = async (n: string, f: () => void | Promise<void>) => {
  try { await f(); pass++; results.push("  PASS " + n); }
  catch (e: any) { fail++; results.push("  FAIL " + n + ": " + e.message); }
};

async function main() {
  await t("diff: added, removed and changed elements are told apart", () => {
    const before = { elements: [el("a"), el("b"), el("c", { height: 3 })], models: [{ id: "m1" }] };
    const after = { elements: [el("a"), el("c", { height: 4 }), el("d")], models: [{ id: "m1" }, { id: "m2" }] };
    const d = core.diffProjectDocs(before, after);
    assert.deepStrictEqual(d.elements.added, ["d"]);
    assert.deepStrictEqual(d.elements.removed, ["b"]);
    assert.deepStrictEqual(d.elements.changed, ["c"]);
    assert.deepStrictEqual(d.models.added, ["m2"]);
    assert.deepStrictEqual(d.models.removed, []);
  });

  await t("diff: identical docs diff to nothing; empty docs are safe", () => {
    const d = core.diffProjectDocs({ elements: [el("a")] }, { elements: [el("a")] });
    assert.deepStrictEqual(d, { elements: { added: [], removed: [], changed: [] }, models: { added: [], removed: [] } });
    assert.strictEqual(core.formatDiff(d), "no changes");
    const empty = core.diffProjectDocs({}, {});
    assert.deepStrictEqual(empty.elements.added, []);
  });

  await t("formatDiff: counts read as +N −M ~K", () => {
    assert.strictEqual(core.formatDiff({
      elements: { added: ["a", "b"], removed: ["c"], changed: ["d"] },
      models: { added: ["m"], removed: [] },
    }), "+2 −1 ~1 elements · +1 model");
    assert.strictEqual(core.formatDiff({
      elements: { added: ["a"], removed: [], changed: [] },
      models: { added: [], removed: [] },
    }), "+1 element");
  });

  await t("buildVersionRows: newest first, each diffed against its predecessor, oldest is the initial version", () => {
    const summaries = [
      { id: 3, createdAt: 3000, reason: "project-save", elementCount: 2, modelCount: 0, missingModelCount: 0 },
      { id: 2, createdAt: 2000, reason: "project-save", elementCount: 1, modelCount: 0, missingModelCount: 0 },
      { id: 1, createdAt: 1000, reason: "model-import", elementCount: 0, modelCount: 1, missingModelCount: 0 },
    ];
    const docsById = new Map<number, any>([
      [3, { elements: [el("a"), el("b")], models: [] }],
      [2, { elements: [el("a")], models: [] }],
      [1, { elements: [], models: [{ id: "m1" }] }],
    ]);
    const rows = core.buildVersionRows(summaries, docsById);
    assert.deepStrictEqual(rows.map((r: any) => r.id), [3, 2, 1]);
    assert.strictEqual(rows[0].diffFromPrevious, "+1 element");
    assert.strictEqual(rows[1].diffFromPrevious, "+1 element · −1 model");
    assert.strictEqual(rows[2].diffFromPrevious, "initial version");
    assert.strictEqual(rows[2].reason, "model-import");
  });

  await t("buildVersionRows: manual labels survive; unknown reasons fall back safely", () => {
    const summaries = [
      { id: 5, createdAt: 5000, reason: "manual-version", label: "Before the big move", elementCount: 1, modelCount: 0, missingModelCount: 0 },
      { id: 4, createdAt: 4000, reason: "something-new", elementCount: 1, modelCount: 0, missingModelCount: 0 },
    ];
    const docsById = new Map<number, any>([
      [5, { elements: [el("a")], models: [] }],
      [4, { elements: [el("a")], models: [] }],
    ]);
    const rows = core.buildVersionRows(summaries, docsById);
    assert.strictEqual(rows[0].label, "Before the big move");
    assert.strictEqual(rows[0].reason, "manual-version");
    assert.strictEqual(rows[1].reason, "project-save");
    assert.strictEqual(rows[0].diffFromPrevious, "no changes");
  });

  await t("contentHash: identical docs match regardless of element order; a changed element does not", () => {
    const a = { elements: [el("a"), el("b")], models: [{ id: "m1" }] };
    const b = { elements: [el("b"), el("a")], models: [{ id: "m1" }] };
    const c = { elements: [el("a"), el("b", { height: 4 })], models: [{ id: "m1" }] };
    assert.strictEqual(core.contentHash(a), core.contentHash(b));
    assert.notStrictEqual(core.contentHash(a), core.contentHash(c));
  });

  for (const r of results) console.log(r);
  console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
