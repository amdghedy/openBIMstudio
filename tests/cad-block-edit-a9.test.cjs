// AutoCAD 2D parity A9 — BEDIT in-place block editor session (node test).
//
// Proved fail-without-fix against the base: `cad-block-edit-a9.ts` is new
// here, so the tsc compile below fails there (TS6053) and the suite never
// runs. The base-point test also fails on the old REFEDIT semantics:
// REFCLOSE rebuilds through makeBlock, which forces the base to 0,0 and
// writes only the library copy — BEDIT must redefine the native definition
// with the edited entities and the ORIGINAL base point.
//
// No mocks: the real session open/close functions and the real
// validateBlockName / counting helpers are the shipped ones.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-block-edit-a9-"));
try { fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* zod is a runtime dep of compiled safeLoad (PE-20) */ }
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
execSync(
  "npx tsc src/modules/cad-viewer/cad-block-edit-a9.ts src/modules/drawings/block-edit.ts src/modules/drawings/block-refs.ts src/modules/cad-viewer/modify-math.ts " +
    "--outDir " + out + " --module commonjs --target es2020 --skipLibCheck --esModuleInterop",
  { cwd: root, stdio: "pipe" },
);
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const B = require(find(out, "cad-block-edit-a9.js"));

const def = {
  name: "Chair",
  base: { x: 10, y: 20 },
  entities: [
    { type: "LINE", layer: "0", start: { x: 10, y: 20 }, end: { x: 30, y: 20 } },
    { type: "LWPOLYLINE", layer: "0", points: [{ x: 10, y: 20 }, { x: 10, y: 40 }, { x: 30, y: 40 }] },
  ],
  attdefs: [{ tag: "NAME", prompt: "Name", defaultValue: "Chair", position: { x: 10, y: 20 }, height: 2.5 }],
  description: "A chair",
};

(async () => {
  await t("open: the session is a deep clone — editing it never touches the definition", async () => {
    const s = B.openBlockEditSession(def);
    assert.strictEqual(s.name, "Chair");
    assert.deepStrictEqual(s.base, { x: 10, y: 20 });
    assert.strictEqual(s.entities.length, 2);
    s.entities[0].end.x = 99;
    s.entities.push({ type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 1, y: 1 } });
    s.base.x = 0;
    assert.strictEqual(def.entities[0].end.x, 30, "definition mutated through the session");
    assert.strictEqual(def.entities.length, 2, "definition gained an entity through the session");
    assert.strictEqual(def.base.x, 10, "definition base mutated through the session");
  });

  await t("close: the redefined definition keeps the ORIGINAL base point, attdefs and description", async () => {
    const s = B.openBlockEditSession(def);
    const edited = [
      ...s.entities,
      { type: "LINE", layer: "0", start: { x: 15, y: 25 }, end: { x: 25, y: 25 } },
    ];
    const out = B.closeBlockEditSession(s, edited);
    assert.strictEqual(out.name, "Chair");
    assert.deepStrictEqual(out.base, { x: 10, y: 20 }, "REFEDIT semantics would force 0,0 here");
    assert.strictEqual(out.entities.length, 3);
    assert.deepStrictEqual(out.attdefs, def.attdefs);
    assert.strictEqual(out.description, "A chair");
    // Closing clones the edited list too: later edits to it do not leak in.
    edited.push({ type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 1, y: 1 } });
    assert.strictEqual(out.entities.length, 3);
  });

  await t("close: saving an empty session throws (a definition must not be empty)", async () => {
    const s = B.openBlockEditSession(def);
    assert.throws(() => B.closeBlockEditSession(s, []), /cannot be saved empty/);
  });

  await t("open: an invalid block name throws", async () => {
    assert.throws(() => B.openBlockEditSession({ ...def, name: "Bad/Name" }), /contains one of/);
  });

  await t("countBlockInstances: counts INSERTs across lists, case-insensitive, nothing else", async () => {
    const model = [
      { type: "INSERT", layer: "0", name: "Chair", position: { x: 0, y: 0 } },
      { type: "INSERT", layer: "0", name: "CHAIR", position: { x: 100, y: 0 } },
      { type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
    ];
    const layout = [{ type: "INSERT", layer: "0", name: "Table", position: { x: 0, y: 0 } }];
    assert.strictEqual(B.countBlockInstances("chair", model, layout), 2);
    assert.strictEqual(B.countBlockInstances("Table", model, layout), 1);
    assert.strictEqual(B.countBlockInstances("Missing", model, layout), 0);
  });

  await t("2D-23: BCLOSE redefines the library copy of a library block, never a doc-only one", async () => {
    const cv = fs.readFileSync(path.join(root, "src", "features", "cad-viewer.ts"), "utf8");
    // The sync is conditional on library membership: a document-only block
    // (imported, never added to the library) must not be stocked into the
    // catalog by editing it.
    assert.ok(/if \(blockLib\.has\(def\.name\)\) \{/.test(cv), "library sync must be gated on membership");
    assert.ok(/blockLib\.add\(makeBlock\(def\.name, def\.entities, def\.base, doc\.layers as any, def\.description \?\? prev\?\.description\), true\)/.test(cv), "library redefine must rebuild via makeBlock with the edited entities + original base");
    assert.ok(/persistBlockLib\(\)/.test(cv.split("2D-23:")[1] ?? ""), "library redefine must be persisted");
    assert.ok(/Library copy updated\./.test(cv), "BCLOSE must report the library update in its log line");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
