/* ByBlock colour / linetype / lineweight inside blocks resolve to the INSERT's own values (engine JSON -> DxfDocument). */
const { execSync } = require("child_process"); const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "acadb-"));
execSync(`npx tsc src/modules/drawings/acad-engine.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`, { stdio: "pipe" });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const E = require(find(out, "acad-engine.js"));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n) } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message) } };
const ents = (raw) => { const d = E.mapDocument(raw, "dwg"); return d.entities ?? d.model ?? []; };
const base = (extra) => ({
  entities: [
    { handle: "1", type: "INSERT", block: "B", layer: "A", position: [0, 0, 0], rotation: 0, scale: [1, 1, 1], color: { t: "index", v: 1 }, lineType: "DASHED", lineWeight: 50, ...extra },
    { handle: "2", type: "LINE", layer: "0", start: [0, 0, 0], end: [1, 0, 0], color: { t: "byBlock" }, lineType: "ByBlock", lineWeight: "byBlock" },
    { handle: "3", type: "LINE", layer: "0", start: [0, 1, 0], end: [1, 1, 0], color: { t: "index", v: 3 }, lineType: "ByLayer", lineWeight: "byLayer" },
  ],
  blockRecords: [{ name: "B", entityHandles: ["2", "3"] }], layers: [], linetypes: [],
});
t("ByBlock colour, linetype and lineweight take the INSERT's values", () => {
  const l = ents(base()).filter((e) => e.type === "LINE");
  const a = l.find((e) => e.start.y === 0);
  assert.strictEqual(a.color, 1); assert.strictEqual(a.lineType, "DASHED"); assert.strictEqual(a.lineweight, 0.5); assert.strictEqual(a.layer, "A");
});
t("explicit properties inside the block are kept", () => {
  const b = ents(base()).filter((e) => e.type === "LINE").find((e) => e.start.y === 1);
  assert.strictEqual(b.color, 3); assert.strictEqual(b.lineType, undefined);
});
t("an INSERT that is itself ByLayer leaves ByBlock content ByLayer (no stray colour)", () => {
  const a = ents(base({ color: { t: "byLayer" }, lineType: "ByLayer", lineWeight: "byLayer" })).filter((e) => e.type === "LINE").find((e) => e.start.y === 0);
  assert.strictEqual(a.color, undefined); assert.strictEqual(a.lineType, undefined);
});
t("true-colour INSERT passes its RGB down", () => {
  const a = ents(base({ color: { t: "rgb", r: 255, g: 128, b: 0 } })).filter((e) => e.type === "LINE").find((e) => e.start.y === 0);
  assert.strictEqual(a.rgb, 0xff8000);
});
t("explicit lineweight, linetype scale and transparency inside a block survive the INSERT transform", () => {
  const r = base(); r.entities[2].lineWeight = 25; r.entities[2].ltScale = 2; r.entities[2].transparency = 128;
  const b = ents(r).filter((e) => e.type === "LINE").find((e) => e.start.y === 1);
  assert.strictEqual(b.lineweight, 0.25); assert.strictEqual(b.ltScale, 2); assert.ok(b.transparency > 0);
});
t("one INSERT that expands to 150 000 entities converts without a stack overflow", () => {
  const n = 150000, hs = [], ents = [{ handle: "1", type: "INSERT", block: "BIG", layer: "A", position: [0, 0, 0], rotation: 0, scale: [1, 1, 1], color: { t: "byLayer" }, lineType: "ByLayer", lineWeight: "byLayer" }];
  for (let i = 0; i < n; i++) { const h = String(100 + i); hs.push(h); ents.push({ handle: h, type: "LINE", layer: "0", start: [i, 0, 0], end: [i, 1, 0], color: { t: "byLayer" }, lineType: "ByLayer", lineWeight: "byLayer" }); }
  const d = E.mapDocument({ entities: ents, blockRecords: [{ name: "BIG", entityHandles: hs }], layers: [], linetypes: [] }, "dwg");
  assert.strictEqual((d.entities ?? []).filter((e) => e.type === "LINE").length, n);
});
console.log(`acad-byblock: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
