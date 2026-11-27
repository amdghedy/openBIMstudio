// 2D-20 — dynamic-block parameter values survive QSAVE/DXF as XDATA.
// Writer emits one group 1000 `DYN:{id, v}` per value under app
// OPENBIMSTUDIO (registered in the APPID table); the TS reader parses
// them back on native INSERTs. No mocks: the real writer + reader.
//
// Fail-without-fix: on the base the writer has no dynValues branch, so
// the round-trip test finds no dynValues on the parsed INSERT (and the
// XDATA/APPID assertions find no OPENBIMSTUDIO groups at all).
//
// DWG leg (probed 2026-11-27 with the real WASM converter, /tmp scratch):
// the acadrust converter expands INSERTs into block-body geometry on
// read-back (no INSERT, no block table survive), so dynValues cannot
// survive a DWG round-trip however they are encoded — Rust-side, out of
// reach. The DXF leg above is the fix; the DWG limit is documented, not
// hidden.
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "dyn-xdata-"));
try { fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* zod is a runtime dep of compiled safeLoad (PE-20) */ }
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
execSync(`npx tsc src/modules/drawings/dxf-reader.ts src/modules/drawings/dxf-writer.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop${flag}`, { stdio: "pipe", cwd: root });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const { parseDxf } = require(find(out, "dxf-reader.js"));
const { writeDxf } = require(find(out, "dxf-writer.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };
const NATIVE = { nativeBlocks: true };
const D = (...a) => a.flat().join("\n") + "\n";
const LINE = (x1, y1, x2, y2, layer = "0") => D(0, "LINE", 8, layer, 10, x1, 20, y1, 11, x2, 21, y2);
const BLOCK = (name, bx, by, body) => D(0, "BLOCK", 8, "0", 2, name, 70, 0, 10, bx, 20, by, 3, name) + body + D(0, "ENDBLK", 8, "0");
const file = (blocks, ents) => D(0, "SECTION", 2, "BLOCKS") + blocks + D(0, "ENDSEC", 0, "SECTION", 2, "ENTITIES") + ents + D(0, "ENDSEC", 0, "EOF");
const SQ = { name: "SQ", base: { x: 1, y: 1 }, entities: [{ type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 4, y: 0 } }], attdefs: [] };
const P = (x, y) => ({ x, y, z: 0 });
const docWith = (dynValues) => ({
  units: "mm",
  layers: [{ name: "0", color: 7 }],
  entities: [{ type: "INSERT", layer: "0", name: "SQ", position: P(5, 5), ...(dynValues !== undefined ? { dynValues } : {}) }],
  blocks: { SQ },
});

t("DXF round-trip preserves dynValues (number, string, boolean) on a native INSERT", () => {
  const want = { W: 1200, flip: true, label: "A-1" };
  const back = parseDxf(writeDxf(docWith(want)), NATIVE);
  assert.equal(back.entities.length, 1);
  assert.equal(back.entities[0].type, "INSERT");
  assert.deepStrictEqual(back.entities[0].dynValues, want);
});

t("writer emits XDATA groups and registers the APPID table", () => {
  const text = writeDxf(docWith({ W: 1200 }));
  assert.ok(text.includes("1001\nOPENBIMSTUDIO"), "no 1001 OPENBIMSTUDIO group");
  assert.ok(text.includes('DYN:{"id":"W","v":1200}'), "no DYN value string");
  assert.ok(text.includes("2\nOPENBIMSTUDIO"), "no APPID record for OPENBIMSTUDIO");
});

t("a doc without dynValues writes no XDATA and is byte-identical with an empty dynValues object", () => {
  const a = writeDxf(docWith(undefined));
  const b = writeDxf(docWith({}));
  assert.equal(a, b, "empty dynValues changed the output");
  assert.ok(!a.includes("OPENBIMSTUDIO"), "XDATA leaked into a dynValues-free save");
});

t("dynValues on an INSERT inside a block body survive", () => {
  const outer = {
    name: "OUTER", base: { x: 0, y: 0 },
    entities: [{ type: "INSERT", layer: "0", name: "SQ", position: P(10, 0), dynValues: { H: 42 } }],
    attdefs: [],
  };
  const d = { units: "mm", layers: [{ name: "0", color: 7 }], entities: [], blocks: { SQ, OUTER: outer } };
  const back = parseDxf(writeDxf(d), NATIVE);
  const inner = back.blocks.OUTER.entities.find((e) => e.type === "INSERT");
  assert.ok(inner, "nested INSERT lost");
  assert.deepStrictEqual(inner.dynValues, { H: 42 });
});

t("reader ignores foreign XDATA and malformed DYN strings", () => {
  const sq = BLOCK("SQ", 1, 1, LINE(0, 0, 4, 0));
  const ins = (xdata) => D(0, "INSERT", 8, "0", 2, "SQ", 10, 0, 20, 0) + xdata;
  // Another application's XDATA, even with a DYN-looking string, is not ours.
  const foreign = parseDxf(file(sq, ins(D(1001, "OTHERAPP", 1000, 'DYN:{"id":"W","v":5}'))), NATIVE);
  assert.equal(foreign.entities[0].dynValues, undefined);
  // Our application, but a malformed value string, a null value, and an
  // empty id are all skipped; a well-formed sibling still parses.
  const mixed = parseDxf(file(sq, ins(D(1001, "OPENBIMSTUDIO", 1000, "DYN:not-json", 1000, 'DYN:{"id":"W","v":null}', 1000, 'DYN:{"id":"","v":1}', 1000, 'DYN:{"id":"H","v":7}'))), NATIVE);
  assert.deepStrictEqual(mixed.entities[0].dynValues, { H: 7 });
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
