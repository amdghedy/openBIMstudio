/* Phase 2: XREF engine — separate from the host DB, statuses, paths, nesting, cycles, units, clip, compare. */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "xref-"));
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
execSync(`npx tsc src/modules/drawings/xref-engine.ts src/modules/drawings/dxf-reader.ts src/modules/drawings/dxf-writer.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop${flag}`, { stdio: "pipe", cwd: root });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const X = require(find(out, "xref-engine.js")), { parseDxf } = require(find(out, "dxf-reader.js")), { writeDxf } = require(find(out, "dxf-writer.js"));
let pass = 0, fail = 0;
const t = async (n, f) => { try { await f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };
const near = (a, b, m = "") => assert.ok(Math.abs(a - b) < 1e-6, `${m} ${a} != ${b}`);
const line = (x1, y1, x2, y2, layer = "0") => ({ type: "LINE", layer, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } });
const mk = (ents, extra = {}) => ({ layers: [{ name: "0", color: 7 }, { name: "A", color: 1 }], entities: ents, ...extra });
const files = {};
const loader = (p) => files[p.toLowerCase()] ?? null;
const D = (...a) => a.flat().join("\n") + "\n";

(async () => {
  await t("paths: absolute <-> relative round trip, drive handling", () => {
    const host = "/proj/dwg/main.dxf";
    assert.strictEqual(X.toRelativePath("/proj/refs/a.dxf", host), "../refs/a.dxf");
    assert.strictEqual(X.resolvePath("../refs/a.dxf", host), "/proj/refs/a.dxf");
    assert.strictEqual(X.toRelativePath("D:/x/a.dxf", "C:/proj/main.dxf"), "D:/x/a.dxf");
    assert.strictEqual(X.pathMode("a.dxf"), "relative"); assert.strictEqual(X.pathMode("/a.dxf"), "absolute"); assert.strictEqual(X.pathMode("C:\\a.dxf"), "absolute");
  });
  await t("attach keeps geometry OUT of the host document", async () => {
    files["/proj/refs/a.dxf"] = mk([line(0, 0, 10, 0, "A")]);
    const host = mk([line(0, 0, 1, 1)]); const s = new X.XrefStore("/proj/main.dxf", loader);
    const r = await s.attach("refs/a.dxf"); assert.strictEqual(r.status, "loaded");
    assert.strictEqual(host.entities.length, 1); assert.ok(s.docOf(r.id) && s.docOf(r.id) !== host);
  });
  await t("missing -> reload resolves it; repath converts to relative", async () => {
    const s = new X.XrefStore("/proj/main.dxf", loader);
    const r = await s.attach("gone/b.dxf"); assert.strictEqual(r.status, "missing"); assert.match(r.message, /not found/i);
    files["/proj/moved/b.dxf"] = mk([line(0, 0, 1, 0)]);
    await s.repath(r.id, "/proj/moved/b.dxf", "relative");
    assert.strictEqual(r.status, "loaded"); assert.strictEqual(r.path, "moved/b.dxf");
  });
  await t("unload drops geometry but keeps the definition; reload brings it back with new content", async () => {
    const s = new X.XrefStore("/proj/main.dxf", loader); const r = await s.attach("refs/a.dxf");
    s.unload(r.id); assert.strictEqual(r.status, "unloaded"); assert.ok(!s.docOf(r.id));
    files["/proj/refs/a.dxf"] = mk([line(0, 0, 10, 0, "A"), line(0, 0, 0, 10, "A")]);
    await s.reload(r.id); assert.strictEqual(s.docOf(r.id).entities.length, 2);
  });
  await t("nested attach is loaded; nested overlay is not propagated; detach removes the tree", async () => {
    files["/proj/refs/mid.dxf"] = mk([line(0, 0, 1, 0)], { xrefs: [{ name: "leaf", path: "leaf.dxf", kind: "attach" }, { name: "ov", path: "ov.dxf", kind: "overlay" }] });
    files["/proj/refs/leaf.dxf"] = mk([line(0, 0, 0, 5)]); files["/proj/refs/ov.dxf"] = mk([line(9, 9, 9, 9)]);
    const s = new X.XrefStore("/proj/main.dxf", loader); const r = await s.attach("refs/mid.dxf");
    assert.strictEqual(r.nested.length, 1); const rep = s.report(); assert.deepStrictEqual(rep.map((x) => x.nestedLevel), [0, 1]);
    assert.strictEqual(s.detach(r.id).length, 2); assert.strictEqual(s.list().length, 0);
  });
  await t("circular references are detected, not looped", async () => {
    files["/proj/refs/c1.dxf"] = mk([line(0, 0, 1, 0)], { xrefs: [{ name: "c2", path: "c2.dxf", kind: "attach" }] });
    files["/proj/refs/c2.dxf"] = mk([line(0, 0, 1, 0)], { xrefs: [{ name: "c1", path: "c1.dxf", kind: "attach" }] });
    const s = new X.XrefStore("/proj/main.dxf", loader); await s.attach("refs/c1.dxf");
    assert.ok(s.list().some((r) => r.status === "cycle"), JSON.stringify(s.report()));
    assert.ok(s.list().length <= 4);
  });
  await t("compose: unit conversion, scale, rotation, insertion, layer prefix, hidden layers", async () => {
    files["/proj/refs/u.dxf"] = mk([line(0, 0, 1, 0, "A"), line(0, 0, 0, 1, "0")], { units: "m" });
    const s = new X.XrefStore("/proj/main.dxf", loader); const r = await s.attach("refs/u.dxf", { insertion: { x: 100, y: 0 }, rotation: 90 });
    const c = X.composeXrefs(s, { units: "mm" })[0];
    const l = c.entities.find((e) => e.layer === "u|A"); near(l.start.x, 100); near(l.end.x, 100); near(l.end.y, 1000);
    r.hiddenLayers = ["0"]; const c2 = X.composeXrefs(s, { units: "mm" })[0]; assert.strictEqual(c2.entities.length, 1); assert.strictEqual(c2.hidden, 1);
  });
  await t("clip polygon hides entities outside, keeps spanning ones", async () => {
    files["/proj/refs/k.dxf"] = mk([line(0, 0, 1, 1), line(50, 50, 51, 51), line(-100, 5, 100, 5)]);
    const s = new X.XrefStore("/proj/main.dxf", loader); const r = await s.attach("refs/k.dxf");
    r.clip = [{ x: -5, y: -5 }, { x: 5, y: -5 }, { x: 5, y: 10 }, { x: -5, y: 10 }];
    const c = X.composeXrefs(s, {})[0]; assert.strictEqual(c.entities.length, 2); assert.strictEqual(c.clipped, 1);
  });
  await t("nested placement composes parent transform", async () => {
    files["/proj/refs/p.dxf"] = mk([], { xrefs: [{ name: "q", path: "q.dxf", kind: "attach" }] }); files["/proj/refs/q.dxf"] = mk([line(0, 0, 1, 0)]);
    const s = new X.XrefStore("/proj/main.dxf", loader); await s.attach("refs/p.dxf", { insertion: { x: 10, y: 0 } });
    const c = X.composeXrefs(s, {}); const q = c.find((x) => x.ref.name === "q"); near(q.entities[0].start.x, 10);
  });
  await t("compare is geometric: moved line = removed + added, counts alone would say equal", () => {
    const a = mk([line(0, 0, 1, 0), line(0, 0, 0, 1)]), b = mk([line(0, 0, 1, 0), line(0, 0, 0, 2)], { layers: [{ name: "0", color: 7 }, { name: "N", color: 1 }] });
    const d = X.compareXref(a, b); assert.deepStrictEqual([d.added, d.removed, d.unchanged], [1, 1, 1]); assert.deepStrictEqual(d.layersAdded, ["N"]); assert.deepStrictEqual(d.layersRemoved, ["A"]);
  });
  await t("DXF reader captures XREF block declarations (flag 4, path, overlay flag 8)", () => {
    const dxf = D(0,"SECTION",2,"BLOCKS",0,"BLOCK",8,"0",2,"SITE",70,4,10,0,20,0,30,0,1,"..\\site\\site.dxf",3,"SITE",0,"ENDBLK",8,"0",
      0,"BLOCK",8,"0",2,"OVL",70,12,10,0,20,0,30,0,1,"ov.dxf",3,"OVL",0,"ENDBLK",8,"0",0,"ENDSEC",0,"SECTION",2,"ENTITIES",0,"ENDSEC",0,"EOF");
    const d = parseDxf(dxf);
    assert.deepStrictEqual(d.xrefs, [{ name: "SITE", path: "..\\site\\site.dxf", kind: "attach" }, { name: "OVL", path: "ov.dxf", kind: "overlay" }]);
  });
  await t("writer round-trips XREF declarations (path and overlay kind)", () => {
    const d = mk([line(0, 0, 1, 1)], { xrefs: [{ name: "SITE", path: "..\\site\\site.dxf", kind: "attach" }, { name: "OVL", path: "ov.dxf", kind: "overlay" }] });
    const back = parseDxf(writeDxf(d));
    assert.deepStrictEqual(back.xrefs, d.xrefs); assert.strictEqual(back.entities.length, 1);
  });
  console.log(`\ncad-xref-engine: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
