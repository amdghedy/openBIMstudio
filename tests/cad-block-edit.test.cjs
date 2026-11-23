/* Phase 1: editor-native BLOCK / INSERT / MINSERT / EXPLODE / ATTEDIT / WBLOCK / PURGE on the canonical model. */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "blked-"));
try { fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* zod is a runtime dep of compiled safeLoad (PE-20) */ }
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
execSync(`npx tsc src/modules/drawings/block-edit.ts src/modules/drawings/dxf-writer.ts src/modules/drawings/dxf-reader.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop${flag}`, { stdio: "pipe", cwd: root });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const E = require(find(out, "block-edit.js")), B = require(find(out, "block-refs.js"));
const { writeDxf } = require(find(out, "dxf-writer.js")), { parseDxf } = require(find(out, "dxf-reader.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };
const near = (a, b, m = "") => assert.ok(Math.abs(a - b) < 1e-6, `${m} ${a} != ${b}`);
const line = (x1, y1, x2, y2, layer = "0") => ({ type: "LINE", layer, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });
const mk = () => ({ layers: [{ name: "0", color: 7 }, { name: "A", color: 1 }], entities: [] });

t("createBlock moves base to origin and rejects bad/duplicate names", () => {
  const d = mk(); const def = E.createBlock(d, "BOX", [line(10, 10, 20, 10, "A")], { base: { x: 10, y: 10 } });
  assert.deepStrictEqual(def.entities[0].start, { x: 0, y: 0 }); assert.ok(d.blocks.BOX);
  assert.throws(() => E.createBlock(d, "box", [], { base: { x: 0, y: 0 } }), /already exists/);
  assert.throws(() => E.createBlock(d, "a/b", [], { base: { x: 0, y: 0 } }));
  assert.throws(() => E.createBlock(d, "*U1", [], { base: { x: 0, y: 0 } }));
  E.createBlock(d, "BOX", [line(0, 0, 5, 0)], { base: { x: 0, y: 0 }, overwrite: true });
  assert.strictEqual(d.blocks.BOX.entities[0].end.x, 5);
});
t("INSERT resolves with scale/rotation and does not copy geometry", () => {
  const d = mk(); E.createBlock(d, "B", [line(0, 0, 10, 0, "A")], { base: { x: 0, y: 0 } });
  const i = E.makeInsert(d, "B", { x: 100, y: 0 }, { scale: 2, rotation: 90 }); d.entities.push(i);
  const r = B.resolvedOf(i)[0]; near(r.start.x, 100); near(r.end.x, 100); near(r.end.y, 20);
  assert.strictEqual(r.layer, "A"); assert.strictEqual(d.entities.length, 1);
});
t("redefining a block updates every reference (cache invalidated)", () => {
  const d = mk(); E.createBlock(d, "B", [line(0, 0, 10, 0)], { base: { x: 0, y: 0 } });
  const i = E.makeInsert(d, "B", { x: 0, y: 0 }); d.entities.push(i);
  near(B.resolvedOf(i)[0].end.x, 10);
  E.createBlock(d, "B", [line(0, 0, 30, 0)], { base: { x: 0, y: 0 }, overwrite: true });
  near(B.resolvedOf(i)[0].end.x, 30);
});
t("layer 0 children inherit the reference layer", () => {
  const d = mk(); E.createBlock(d, "B", [line(0, 0, 1, 0, "0")], { base: { x: 0, y: 0 } });
  const i = E.makeInsert(d, "B", { x: 0, y: 0 }, { layer: "A" }); assert.strictEqual(B.resolvedOf(i)[0].layer, "A");
});
t("MINSERT array", () => {
  const d = mk(); E.createBlock(d, "B", [line(0, 0, 1, 0)], { base: { x: 0, y: 0 } });
  const i = E.makeInsert(d, "B", { x: 0, y: 0 }, { columns: 3, rows: 2, columnSpacing: 5, rowSpacing: 7 });
  assert.strictEqual(B.resolvedOf(i).length, 6);
});
t("nested blocks and cycle rejection", () => {
  const d = mk(); E.createBlock(d, "IN", [line(0, 0, 1, 0)], { base: { x: 0, y: 0 } });
  const inner = E.makeInsert(d, "IN", { x: 5, y: 0 });
  E.createBlock(d, "OUT", [inner], { base: { x: 0, y: 0 } });
  const o = E.makeInsert(d, "OUT", { x: 10, y: 0 }); d.entities.push(o);
  near(B.resolvedOf(o)[0].start.x, 15);
  assert.throws(() => E.createBlock(d, "IN", [E.makeInsert(d, "OUT", { x: 0, y: 0 })], { base: { x: 0, y: 0 }, overwrite: true }), /itself/);
  assert.throws(() => E.makeInsert(d, "OUT", { x: 0, y: 0 }, {}, "IN"), /cycle/);
});
t("EXPLODE replaces the reference by transformed children, one level", () => {
  const d = mk(); E.createBlock(d, "IN", [line(0, 0, 1, 0)], { base: { x: 0, y: 0 } });
  E.createBlock(d, "OUT", [E.makeInsert(d, "IN", { x: 5, y: 0 })], { base: { x: 0, y: 0 } });
  d.entities.push(line(0, 0, 0, 1), E.makeInsert(d, "OUT", { x: 10, y: 0 }));
  const r = E.explodeInDoc(d, [1]); assert.strictEqual(r.exploded, 1);
  assert.strictEqual(r.entities.length, 2); assert.strictEqual(r.entities[1].type, "INSERT");
  near(r.entities[1].position.x, 15);
});
t("ATTEDIT changes values, reports unknown tags, keeps the original", () => {
  const d = mk(); E.createBlock(d, "T", [line(0, 0, 1, 0)], { base: { x: 0, y: 0 }, attdefs: [{ tag: "NAME", prompt: "n", defaultValue: "x", position: { x: 1, y: 1 }, height: 2 }] });
  const i = E.makeInsert(d, "T", { x: 10, y: 10 }, {}); assert.strictEqual(i.attributes[0].value, "x"); near(i.attributes[0].position.x, 11);
  const r = E.atteditInsert(i, { name: "Door", NOPE: "1" });
  assert.deepStrictEqual(r.changed, ["NAME"]); assert.deepStrictEqual(r.unknown, ["NOPE"]);
  assert.strictEqual(i.attributes[0].value, "x"); assert.strictEqual(r.insert.attributes[0].value, "Door");
});
t("WBLOCK carries nested definitions, layers and base shift; source untouched", () => {
  const d = mk(); E.createBlock(d, "IN", [line(0, 0, 1, 0, "A")], { base: { x: 0, y: 0 } });
  const sel = [E.makeInsert(d, "IN", { x: 100, y: 100 })];
  const w = E.wblockDocument(d, { entities: sel, base: { x: 100, y: 100 } });
  assert.ok(w.blocks.IN); near(w.entities[0].position.x, 0); assert.ok(w.layers.some((l) => l.name === "A"));
  const w2 = E.wblockDocument(d, { block: "IN" }); assert.strictEqual(w2.entities.length, 1);
  assert.ok(!d.blocks.OTHER);
});
t("PURGE removes only unreferenced blocks", () => {
  const d = mk(); E.createBlock(d, "USED", [line(0, 0, 1, 0)], { base: { x: 0, y: 0 } }); E.createBlock(d, "DEAD", [line(0, 0, 1, 0)], { base: { x: 0, y: 0 } });
  d.entities.push(E.makeInsert(d, "USED", { x: 0, y: 0 }));
  assert.deepStrictEqual(E.purgeBlocks(d), ["DEAD"]); assert.ok(d.blocks.USED && !d.blocks.DEAD);
});
t("DXF round trip keeps native blocks, attributes and arrays", () => {
  const d = mk(); E.createBlock(d, "T", [line(0, 0, 1, 0, "A")], { base: { x: 0, y: 0 }, attdefs: [{ tag: "NAME", prompt: "n", defaultValue: "x", position: { x: 1, y: 1 }, height: 2 }] });
  d.entities.push(E.makeInsert(d, "T", { x: 10, y: 10 }, { rotation: 30, columns: 2, rows: 2, columnSpacing: 4, rowSpacing: 4, values: { NAME: "Z" } }));
  const back = parseDxf(writeDxf(d), { nativeBlocks: true });
  const i = back.entities.find((e) => e.type === "INSERT");
  assert.ok(i && back.blocks.T); assert.strictEqual(i.columns, 2); assert.strictEqual(i.attributes[0].value, "Z"); near(i.rotation, 30);
  assert.strictEqual(B.resolvedOf(i).filter((e) => e.type === "LINE").length, 4);
});
console.log(`\ncad-block-edit: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
