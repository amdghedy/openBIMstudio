// Block-library store (item 19, cad-viewer leg 2): the persistence that used to
// live inline in src/features/cad-viewer.ts now lives in
// src/modules/drawings/block-library-store.ts. These tests prove the extracted
// module persists/loads exactly what cad-viewer did before — same storage key,
// same stored bytes, same fail-soft behaviour — using a fake storage object.
// No browser, no real localStorage.
const { execSync } = require("child_process"); const fs = require("fs"); const os = require("os"); const path = require("path");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ci-"));
execSync(`npx tsc src/modules/drawings/cad-blocks.ts src/modules/drawings/block-library-store.ts --outDir ${out} --module commonjs --target es2020 --lib es2020,dom --skipLibCheck --ignoreDeprecations 5.0`, { stdio: "inherit" });
// NOTE: `--lib es2020,dom` (not plain es2020 as in cad-insert.test.cjs): the
// store resolves `localStorage` like the rest of the codebase, so the compile
// needs the DOM lib, exactly as the project's own tsconfig provides.
const files = []; (function w(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? w(p) : files.push(p); } })(out);
const req = n => require(files.find(f => f.endsWith("/" + n + ".js")));
const B = req("cad-blocks"), S = req("block-library-store");
let pass = 0, fail = 0; const t = (n, fn) => { try { fn(); pass++; console.log("  PASS", n); } catch (e) { fail++; console.log("  FAIL", n + ": " + e.message); } };
const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((m || "") + " got " + JSON.stringify(a) + " want " + JSON.stringify(b)); };
const sq = (layer = "A") => [{ type: "LINE", layer, start: { x: 10, y: 10 }, end: { x: 20, y: 10 } }, { type: "LINE", layer, start: { x: 20, y: 10 }, end: { x: 20, y: 20 } }, { type: "CIRCLE", layer, center: { x: 15, y: 15 }, radius: 2 }];
const layers = [{ name: "A", color: 1 }, { name: "B", color: 3 }];
class FakeStorage {
  constructor(seed = {}) { this.map = new Map(Object.entries(seed)); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
}
class ThrowingStorage {
  getItem() { throw new Error("denied"); }
  setItem() { throw new Error("denied"); }
}
const KEY = "obs.cad.blocks";

t("storage key is exactly the key cad-viewer always used", () => {
  if (S.BLOCK_LIBRARY_STORAGE_KEY !== KEY) throw new Error(S.BLOCK_LIBRARY_STORAGE_KEY);
});

t("round trip through fake storage preserves names, geometry, base, description", () => {
  const store = new FakeStorage();
  const lib = new B.BlockLibrary();
  lib.add(B.makeBlock("Door 900", sq(), { x: 10, y: 10 }, layers, "Front door"));
  lib.add(B.makeBlock("Win", sq("B"), { x: 0, y: 0 }, layers));
  if (S.saveBlockLibrary(lib, store) !== true) throw new Error("save should return true");
  // The stored bytes must be exactly what the old inline code wrote:
  // JSON.stringify(lib.toJSON()) under the same key.
  eq(store.getItem(KEY), JSON.stringify(lib.toJSON()), "stored bytes differ from old inline write");
  const back = S.loadBlockLibrary(store);
  // NOTE: BlockLibrary.names() returns the lower-cased lookup keys (pre-existing
  // cad-blocks behaviour — the stored definition keeps its display case).
  eq(back.names(), ["door 900", "win"]);
  if (back.get("door 900").name !== "Door 900") throw new Error("definition lost its display-case name");
  eq(back.get("door 900").entities, lib.get("Door 900").entities);
  eq(back.get("door 900").base, { x: 10, y: 10 });
  if (back.get("door 900").description !== "Front door") throw new Error("description lost");
  eq(back.get("win").entities[2], { type: "CIRCLE", layer: "B", center: { x: 15, y: 15 }, radius: 2 });
});

t("loads bytes written by the old inline cad-viewer code (hand-built payload)", () => {
  // Exactly what `localStorage.setItem("obs.cad.blocks", JSON.stringify(blockLib.toJSON()))`
  // stored before the extraction: a bare JSON array of block definitions.
  const oldBytes = JSON.stringify([{
    name: "Legacy", base: { x: 1, y: 2 },
    entities: [{ type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 5, y: 0 } }],
    layers: [{ name: "0", color: 7 }], description: "saved before item 19",
  }]);
  const back = S.loadBlockLibrary(new FakeStorage({ [KEY]: oldBytes }));
  if (back.size !== 1 || !back.has("legacy")) throw new Error("legacy payload not loaded");
  eq(back.get("legacy").base, { x: 1, y: 2 });
  if (back.get("legacy").description !== "saved before item 19") throw new Error("description lost");
});

t("missing key loads an empty library", () => {
  if (S.loadBlockLibrary(new FakeStorage()).size !== 0) throw new Error("expected empty");
});

t("corrupt JSON loads an empty library and never throws", () => {
  const back = S.loadBlockLibrary(new FakeStorage({ [KEY]: "{not json" }));
  if (back.size !== 0) throw new Error("expected empty on corrupt JSON");
});

t("hostile stored records are skipped, valid ones kept", () => {
  const raw = JSON.stringify([null, { name: "x/y" }, { name: "ok", base: { x: 0, y: 0 }, entities: [] },
    { name: "ok2", base: { x: "a", y: 0 }, entities: [{}] }, 5,
    { name: "Good", base: { x: 3, y: 4 }, entities: sq(), layers: [] }]);
  const back = S.loadBlockLibrary(new FakeStorage({ [KEY]: raw }));
  if (back.size !== 1 || !back.has("good")) throw new Error("expected only Good, got " + back.names());
});

t("rename/remove persist across a save/load cycle (BLOCKLIB path)", () => {
  const store = new FakeStorage();
  const lib = new B.BlockLibrary();
  lib.add(B.makeBlock("A", sq(), { x: 0, y: 0 }));
  lib.add(B.makeBlock("B", sq(), { x: 0, y: 0 }));
  lib.rename("A", "Alpha");
  lib.remove("B");
  if (!S.saveBlockLibrary(lib, store)) throw new Error("save failed");
  const back = S.loadBlockLibrary(store);
  eq(back.names(), ["alpha"]); // lower-cased key; see note in the round-trip test above
  if (back.get("alpha").name !== "Alpha") throw new Error("renamed definition lost its display-case name");
});

t("storage that throws (private mode / blocked) fails soft: load empty, save false", () => {
  if (S.loadBlockLibrary(new ThrowingStorage()).size !== 0) throw new Error("expected empty");
  if (S.saveBlockLibrary(new B.BlockLibrary(), new ThrowingStorage()) !== false) throw new Error("expected false");
});

t("no storage at all fails soft: load empty, save false", () => {
  if (S.loadBlockLibrary(null).size !== 0) throw new Error("expected empty");
  if (S.saveBlockLibrary(new B.BlockLibrary(), null) !== false) throw new Error("expected false");
});

t("shared singleton loads without localStorage and persistBlockLib writes it", () => {
  // In Node there is no localStorage, so the import-time singleton must be an
  // empty BlockLibrary, not a throw — same as the old module-level IIFE.
  if (!(S.blockLib instanceof B.BlockLibrary)) throw new Error("singleton is not a BlockLibrary");
  if (S.blockLib.size !== 0) throw new Error("singleton should start empty without storage");
  const store = new FakeStorage();
  S.blockLib.add(B.makeBlock("Shared", sq(), { x: 0, y: 0 }));
  if (S.persistBlockLib(store) !== true) throw new Error("persist should return true");
  const back = S.loadBlockLibrary(store);
  if (!back.has("shared")) throw new Error("singleton was not persisted");
  S.blockLib.remove("Shared");
  S.persistBlockLib(store);
  if (S.loadBlockLibrary(store).size !== 0) throw new Error("singleton removal was not persisted");
});

t("cad-viewer.ts no longer owns block-library persistence; its 5 exports are unchanged", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "features", "cad-viewer.ts"), "utf8");
  for (const gone of ["obs.cad.blocks", "BLOCK_LIB_KEY", "new BlockLibrary()", "BlockLibrary.fromJSON"]) {
    if (src.includes(gone)) throw new Error("cad-viewer still contains " + gone);
  }
  if (!src.includes('from "../modules/drawings/block-library-store"')) throw new Error("cad-viewer does not import the store");
  if (!src.includes("import { blockLib, persistBlockLib }")) throw new Error("cad-viewer does not import blockLib/persistBlockLib");
  for (const fn of ["export function openCadViewer", "export function closeCadViewer", "export function getCadAiState", "export function runCadAiCommand", "export function getCadCommandCatalog"]) {
    if (!src.includes(fn)) throw new Error("missing export: " + fn);
  }
});

console.log(`block-library-store: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
