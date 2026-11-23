/* M2a: native BLOCK/INSERT model. Reader (native mode), resolver limits, edits, writer round trips,
 * and equivalence with the legacy copy-expanding reader. */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "blk-"));
try { fs.symlinkSync(path.join(__dirname, "..", "node_modules"), path.join(out, "node_modules"), "junction"); } catch { /* zod is a runtime dep of compiled safeLoad (PE-20) */ }
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
execSync(`npx tsc src/modules/drawings/dxf-reader.ts src/modules/drawings/dxf-writer.ts src/modules/drawings/block-refs.ts src/modules/cad-viewer/modify-math.ts src/modules/cad-viewer/viewer-math.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop${flag}`, { stdio: "pipe", cwd: root });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const { parseDxf } = require(find(out, "dxf-reader.js"));
const { writeDxf } = require(find(out, "dxf-writer.js"));
const B = require(find(out, "block-refs.js"));
const M = require(find(out, "modify-math.js"));
const V = require(find(out, "viewer-math.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };
const D = (...a) => a.flat().join("\n") + "\n";
const near = (a, b, eps = 1e-6, m = "") => assert.ok(Math.abs(a - b) <= eps, `${m} ${a} != ${b}`);

const LINE = (x1, y1, x2, y2, layer = "0") => D(0, "LINE", 8, layer, 10, x1, 20, y1, 11, x2, 21, y2);
const CIRC = (x, y, r, layer = "0") => D(0, "CIRCLE", 8, layer, 10, x, 20, y, 40, r);
const BLOCK = (name, bx, by, body) => D(0, "BLOCK", 8, "0", 2, name, 70, 0, 10, bx, 20, by, 3, name) + body + D(0, "ENDBLK", 8, "0");
const INS = (name, x, y, o = {}) => {
  const a = [0, "INSERT", 8, o.layer ?? "L", 2, name, 10, x, 20, y];
  if (o.sx !== undefined) a.push(41, o.sx);
  if (o.sy !== undefined) a.push(42, o.sy);
  if (o.rot !== undefined) a.push(50, o.rot);
  if (o.attribs) a.push(66, 1);
  if (o.cols) a.push(70, o.cols, 71, o.rows, 44, o.dc, 45, o.dr);
  return D(...a) + (o.attribs ?? "") + (o.attribs ? D(0, "SEQEND", 8, o.layer ?? "L") : "");
};
const ATTRIB = (tag, val, x, y, h = 1, flags = 0) => D(0, "ATTRIB", 8, "L", 10, x, 20, y, 40, h, 1, val, 2, tag, 70, flags);
const ATTDEF = (tag, def, x, y, flags = 0) => D(0, "ATTDEF", 8, "0", 10, x, 20, y, 40, 1, 1, def, 3, "prompt " + tag, 2, tag, 70, flags);
const file = (blocks, ents) => D(0, "SECTION", 2, "BLOCKS") + blocks + D(0, "ENDSEC", 0, "SECTION", 2, "ENTITIES") + ents + D(0, "ENDSEC", 0, "EOF");
const NATIVE = { nativeBlocks: true };
const sortKey = (e) => JSON.stringify(e, (k, v) => typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v);
const prim = (ents) => ents.map((e) => ({ type: e.type, layer: e.layer, ...(e.start ? { start: [e.start.x, e.start.y], end: [e.end.x, e.end.y] } : {}), ...(e.center ? { center: [e.center.x, e.center.y], radius: e.radius } : {}), ...(e.position ? { position: [e.position.x, e.position.y], value: e.value } : {}) })).map(sortKey).sort();

const SQ = BLOCK("SQ", 1, 1, LINE(0, 0, 4, 0) + LINE(4, 0, 4, 4) + CIRC(2, 2, 1) + LINE(0, 0, 0, 4, "G"));
const NEST = BLOCK("OUTER", 0, 0, INS("SQ", 10, 0, { sx: 2, sy: 2, rot: 30 }) + LINE(0, 0, 1, 1));

t("native read keeps INSERT + block table and copies no geometry", () => {
  const d = parseDxf(file(SQ, INS("SQ", 5, 5, { sx: 2, sy: 3, rot: 40 }) + INS("SQ", 50, 50)), NATIVE);
  assert.equal(d.entities.length, 2); assert.ok(d.entities.every((e) => e.type === "INSERT"));
  assert.deepEqual(Object.keys(d.blocks), ["SQ"]);
  assert.equal(d.blocks.SQ.entities.length, 4); assert.deepEqual(d.blocks.SQ.base, { x: 1, y: 1, z: 0 });
  const e = d.entities[0]; assert.equal(e.name, "SQ"); assert.deepEqual([e.scale.x, e.scale.y, e.rotation], [2, 3, 40]);
  assert.equal(d.entities[0].layer, "L");
});
t("default read is unchanged: copies, no block table", () => {
  const d = parseDxf(file(SQ, INS("SQ", 5, 5)));
  assert.equal(d.blocks, undefined); assert.ok(d.entities.every((e) => e.type !== "INSERT")); assert.equal(d.entities.length, 4);
});
t("resolved native geometry equals the legacy expanded copies (rotation, non-uniform scale, mirror, nesting, MINSERT)", () => {
  const cases = [INS("SQ", 5, 5), INS("SQ", 5, 5, { rot: 33 }), INS("SQ", -3, 8, { sx: 2, sy: 2, rot: 70 }), INS("SQ", 0, 0, { sx: -1, sy: 1 }), INS("SQ", 7, 7, { sx: -2, sy: -2, rot: 15 }),
    INS("SQ", 4, 4, { sx: 1, sy: -1, rot: 20 }), INS("OUTER", 3, 3, { rot: 25 }), INS("OUTER", 3, 3, { sx: 1.5, sy: -1.5, rot: 25 }), INS("SQ", 0, 0, { cols: 3, rows: 2, dc: 10, dr: 7, rot: 20 })];
  for (const c of cases) {
    const txt = file(SQ + NEST, c);
    const nat = B.flattenInserts(parseDxf(txt, NATIVE)), leg = parseDxf(txt);
    assert.deepEqual(prim(nat.entities), prim(leg.entities), c.replace(/\n/g, " ").slice(0, 80));
  }
});
t("layer 0 inside a block takes the reference layer; other layers keep theirs", () => {
  const d = B.flattenInserts(parseDxf(file(SQ, INS("SQ", 0, 0, { layer: "WALLS" })), NATIVE));
  assert.ok(d.entities.some((e) => e.layer === "WALLS") && d.entities.some((e) => e.layer === "G"));
  assert.ok(!d.entities.some((e) => e.layer === "0"));
});
t("two references share one definition; editing it updates both", () => {
  const d = parseDxf(file(SQ, INS("SQ", 0, 0) + INS("SQ", 100, 0)), NATIVE);
  B.bindDocumentBlocks(d);
  const [a, b] = d.entities;
  const before = [V.entityBBox(a), V.entityBBox(b)];
  assert.equal(before[0].maxX - before[0].minX, before[1].maxX - before[1].minX);
  d.blocks.SQ.entities.push({ type: "LINE", layer: "0", start: { x: 0, y: 0, z: 0 }, end: { x: 40, y: 0, z: 0 } });
  B.touchBlocks(d.blocks);
  assert.ok(V.entityBBox(a).maxX - V.entityBBox(a).minX > 30 && V.entityBBox(b).maxX - V.entityBBox(b).minX > 30);
});
t("cycle A->B->A terminates and is reported", () => {
  const txt = file(BLOCK("A", 0, 0, LINE(0, 0, 1, 1) + INS("B", 1, 1)) + BLOCK("B", 0, 0, LINE(0, 0, 2, 2) + INS("A", 2, 2)), INS("A", 0, 0));
  const d = parseDxf(txt, NATIVE); const rep = { problems: [], truncated: false };
  const r = B.resolveInsert(d.blocks, d.entities[0], rep);
  assert.ok(r.length >= 2 && r.length < 100); assert.ok(rep.problems.some((p) => p.reason === "cycle"));
});
t("self reference terminates", () => {
  const d = parseDxf(file(BLOCK("S", 0, 0, LINE(0, 0, 1, 1) + INS("S", 1, 1)), INS("S", 0, 0)), NATIVE);
  const rep = { problems: [], truncated: false }; B.resolveInsert(d.blocks, d.entities[0], rep);
  assert.ok(rep.problems.some((p) => p.reason === "cycle"));
});
t("deep nesting chain is cut at the depth limit", () => {
  let blocks = BLOCK("N0", 0, 0, LINE(0, 0, 1, 0));
  for (let i = 1; i <= 30; i++) blocks += BLOCK("N" + i, 0, 0, INS("N" + (i - 1), 1, 0));
  const d = parseDxf(file(blocks, INS("N30", 0, 0)), NATIVE); const rep = { problems: [], truncated: false };
  B.resolveInsert(d.blocks, d.entities[0], rep);
  assert.ok(rep.problems.some((p) => p.reason === "depth"));
});
t("MINSERT bomb is clamped and bounded in time", () => {
  let body = ""; for (let i = 0; i < 400; i++) body += LINE(i, 0, i, 1);
  const d = parseDxf(file(BLOCK("BIG", 0, 0, body), INS("BIG", 0, 0, { cols: 99999, rows: 99999, dc: 1, dr: 1 })), NATIVE);
  assert.equal(d.entities[0].columns, 500); const t0 = Date.now(); const rep = { problems: [], truncated: false };
  const r = B.resolveInsert(d.blocks, d.entities[0], rep);
  assert.ok(r.length <= B.MAX_RESOLVED_ENTITIES && rep.truncated, "budget enforced"); assert.ok(Date.now() - t0 < 8000, "took " + (Date.now() - t0));
});
t("missing block: INSERT kept, reported, resolves to nothing, bbox falls back to the insertion point", () => {
  const d = parseDxf(file("", INS("NOPE", 9, 9)), NATIVE);
  assert.equal(d.entities[0].type, "INSERT"); assert.equal(d.skipped["INSERT (missing block)"], 1);
  B.bindDocumentBlocks(d); const bb = V.entityBBox(d.entities[0]); assert.deepEqual([bb.minX, bb.maxX], [9, 9]);
});
t("attributes: ATTRIB values attach to the reference; ATTDEF is stored in the block; invisible/constant handled", () => {
  const blk = BLOCK("TAGB", 0, 0, LINE(0, 0, 2, 0) + ATTDEF("NUM", "0", 0.5, 0.5) + ATTDEF("HID", "h", 0, 1, 1) + ATTDEF("CST", "FIXED", 0, 2, 2));
  const d = parseDxf(file(blk, INS("TAGB", 10, 10, { attribs: ATTRIB("NUM", "A-17", 10.5, 10.5) + ATTRIB("HID", "secret", 10, 11, 1, 1) })), NATIVE);
  assert.equal(d.blocks.TAGB.attdefs.length, 3); assert.equal(d.blocks.TAGB.attdefs[1].invisible, true); assert.equal(d.blocks.TAGB.attdefs[2].constant, true);
  const ins = d.entities[0]; assert.equal(ins.attributes.length, 2); assert.equal(ins.attributes[0].value, "A-17");
  const texts = B.resolveInsert(d.blocks, ins).filter((e) => e.type === "TEXT").map((e) => e.value).sort();
  assert.deepEqual(texts, ["A-17", "FIXED"]);
});
t("writer round trip is lossless and stable over repeated cycles", () => {
  const blk = SQ + NEST + BLOCK("TAGB", 0, 0, LINE(0, 0, 2, 0) + ATTDEF("NUM", "0", 0.5, 0.5));
  const ents = INS("SQ", 5, 5, { sx: 2, sy: -2, rot: 40 }) + INS("OUTER", 1, 2, { rot: 10 }) + INS("TAGB", 3, 3, { attribs: ATTRIB("NUM", "Z9", 3.5, 3.5) }) + INS("SQ", 0, 0, { cols: 3, rows: 2, dc: 12, dr: 9 });
  let d = parseDxf(file(blk, ents), NATIVE); const shape = (x) => JSON.stringify({ e: x.entities, b: x.blocks }, (k, v) => typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v);
  const first = shape(d);
  for (let i = 0; i < 3; i++) { const txt = writeDxf(d); d = parseDxf(txt, NATIVE); assert.equal(shape(d), first, "cycle " + i); }
  const txt = writeDxf(d); assert.ok(/\n0\nBLOCK_RECORD\n/.test(txt)); assert.ok((txt.match(/\n0\nINSERT\n/g) || []).length >= 4);
  assert.ok(/\n0\nATTDEF\n/.test(txt) && /\n0\nSEQEND\n/.test(txt));
});
t("a written native document reads back as flat geometry with the default reader too (compatibility)", () => {
  const d = parseDxf(file(SQ, INS("SQ", 5, 5, { rot: 20 })), NATIVE); const txt = writeDxf(d);
  assert.deepEqual(prim(parseDxf(txt).entities), prim(B.flattenInserts(d).entities));
});
t("move/rotate/scale/mirror on INSERT equal transforming the resolved geometry", () => {
  const d = parseDxf(file(SQ, INS("SQ", 5, 5, { sx: 2, sy: 1.5, rot: 25 })), NATIVE); B.bindDocumentBlocks(d); const e = d.entities[0];
  const check = (name, edited, fn) => {
    B.bindInsert(edited, d.blocks);
    const got = prim(B.resolveInsert(d.blocks, edited)), want = prim(B.resolveInsert(d.blocks, e).flatMap((x) => [fn(x)]));
    assert.deepEqual(got, want, name);
  };
  check("translate", M.translateEnt(e, 7, -3), (x) => M.translateEnt(x, 7, -3));
  check("rotate", M.rotateEnt(e, 1, 2, 37), (x) => M.rotateEnt(x, 1, 2, 37));
  check("mirror", M.mirrorEnt(e, { x: 0, y: 0 }, { x: 3, y: 1 }), (x) => M.mirrorEnt(x, { x: 0, y: 0 }, { x: 3, y: 1 }));
});
t("uniform scale on INSERT equals scaling the resolved geometry", () => {
  const d = parseDxf(file(SQ, INS("SQ", 5, 5, { sx: 2, sy: 2, rot: 25 })), NATIVE); const e = d.entities[0];
  const s = M.scaleEnt(e, 1, 1, 2.5); B.bindInsert(s, d.blocks);
  assert.deepEqual(prim(B.resolveInsert(d.blocks, s)), prim(B.resolveInsert(d.blocks, e).map((x) => M.scaleEnt(x, 1, 1, 2.5))));
});
t("pick, spatial index and snaps see inside the reference; insertion snap present", () => {
  const d = parseDxf(file(SQ, INS("SQ", 5, 5)), NATIVE); B.bindDocumentBlocks(d); const e = d.entities[0];
  near(V.distToEntity(e, 6, 4), 0, 1e-9, "on the resolved line"); assert.ok(V.distToEntity(e, 100, 100) > 50);
  const bb = V.entityBBox(e); near(bb.minX, 4); near(bb.maxX, 8); near(bb.maxY, 8);
  const idx = V.buildIndex(d.entities, { minX: 0, minY: 0, maxX: 20, maxY: 20 });
  const ep = V.findSnap(idx, d.entities, 4.02, 4.02, 0.5, ["endpoint"]); assert.ok(ep && ep.kind === "endpoint"); near(ep.x, 4); near(ep.y, 4);
  const ins = V.findSnap(idx, d.entities, 5.01, 5.01, 0.2, ["insertion"]); assert.ok(ins && ins.kind === "insertion"); near(ins.x, 5);
  const cen = V.findSnap(idx, d.entities, 6.05, 6.0, 0.3, ["center"]); assert.ok(cen && cen.kind === "center"); near(cen.x, 6); near(cen.y, 6);
});
t("EXPLODE one level: nested references stay references; attributes become text", () => {
  const d = parseDxf(file(SQ + NEST, INS("OUTER", 0, 0)), NATIVE);
  const ex = B.explodeInsert(d.blocks, d.entities[0]);
  assert.equal(ex.length, 2); assert.equal(ex.filter((x) => x.type === "INSERT").length, 1);
  const inner = ex.find((x) => x.type === "INSERT"); near(inner.rotation, 30); near(inner.scale.x, 2);
});
t("unusedBlocks lists definitions nothing references (directly or transitively)", () => {
  const d = parseDxf(file(SQ + NEST + BLOCK("ORPHAN", 0, 0, LINE(0, 0, 1, 1)), INS("OUTER", 0, 0)), NATIVE);
  assert.deepEqual(B.unusedBlocks(d), ["ORPHAN"]);
});
t("flattenInserts does not mutate its input and drops the block table", () => {
  const d = parseDxf(file(SQ, INS("SQ", 5, 5)), NATIVE); const snap = JSON.stringify(d);
  const f = B.flattenInserts(d); assert.equal(JSON.stringify(d), snap); assert.equal(f.blocks, undefined); assert.equal(f.entities.length, 4);
});
t("extents of a native document cover the resolved geometry", () => {
  const d = parseDxf(file(SQ, INS("SQ", 100, 200)), NATIVE);
  assert.ok(d.extents.max.x >= 103 && d.extents.max.y >= 203 && d.extents.min.x <= 101);
});
t("hostile/malformed references never throw", () => {
  for (const bad of [D(0, "INSERT", 8, "L", 2, "SQ", 10, "NaN", 20, "x", 41, 0, 42, 0), D(0, "INSERT", 8, "L", 10, 1, 20, 1), D(0, "INSERT", 8, "L", 2, "SQ", 10, 1, 20, 1, 41, 1e308, 42, 1e308, 70, -5, 71, 0)]) {
    const d = parseDxf(file(SQ, bad), NATIVE); B.bindDocumentBlocks(d); for (const e of d.entities) { V.entityBBox(e); V.distToEntity(e, 0, 0); B.resolveInsert(d.blocks, e); }
    writeDxf(d);
  }
});
console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
