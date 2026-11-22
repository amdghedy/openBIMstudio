/* Phase 1: the DWG/DXF engine reader keeps block references native (real wasm engine, no mocks). */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const flag = process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : "";
const out = fs.mkdtempSync(path.join(os.tmpdir(), "engnb-"));
execSync(`npx tsc src/modules/drawings/acad-engine.ts src/modules/drawings/block-refs.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop${flag}`, { stdio: "pipe", cwd: root });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const acad = require(find(out, "acad-engine.js")), B = require(find(out, "block-refs.js"));
let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + (e.stack || e.message).split("\n").slice(0, 3).join(" | ")); } };
const D = (...a) => a.flat().join("\n") + "\n";
const dxf = D(0,"SECTION",2,"HEADER",9,"$ACADVER",1,"AC1015",0,"ENDSEC",
  0,"SECTION",2,"TABLES",0,"TABLE",2,"LAYER",70,1,0,"LAYER",2,"0",70,0,62,7,6,"CONTINUOUS",0,"ENDTAB",0,"ENDSEC",
  0,"SECTION",2,"BLOCKS",
  0,"BLOCK",8,"0",2,"IN",70,0,10,0,20,0,30,0,3,"IN",0,"LINE",8,"0",10,0,20,0,30,0,11,1,21,0,31,0,0,"ENDBLK",8,"0",
  0,"BLOCK",8,"0",2,"TAGB",70,2,10,0,20,0,30,0,3,"TAGB",0,"LINE",8,"0",10,0,20,0,30,0,11,1,21,0,31,0,
  0,"INSERT",8,"0",2,"IN",10,3,20,0,30,0,
  0,"ATTDEF",8,"0",10,1,20,1,30,0,40,2,1,"dflt",3,"Prompt?",2,"NAME",70,0,0,"ENDBLK",8,"0",0,"ENDSEC",
  0,"SECTION",2,"ENTITIES",0,"INSERT",8,"0",66,1,2,"TAGB",10,10,20,10,30,0,41,2,42,2,43,2,50,30,70,3,71,2,44,5,45,6,
  0,"ATTRIB",8,"0",10,11,20,11,30,0,40,2,1,"Val",2,"NAME",70,0,0,"SEQEND",8,"0",0,"ENDSEC",0,"EOF");
(async () => {
  const wasm = fs.readFileSync(path.join(root, "public", "cad-engine", "obim-cad-engine.wasm"));
  if (!(await acad.setAcadEngineForTests(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength)))) { console.log("  SKIP engine unavailable"); return; }
  const bytes = new TextEncoder().encode(dxf);
  const nat = await acad.parseWithAcadEngine(bytes, "n.dxf", { nativeBlocks: true });
  const leg = await acad.parseWithAcadEngine(bytes, "n.dxf");
  t("native mode keeps INSERT with transform, MINSERT 3x2 unclamped and attributes", () => {
    const i = nat.doc.entities.find((e) => e.type === "INSERT");
    assert.ok(i, "INSERT missing"); assert.strictEqual(i.name, "TAGB"); assert.strictEqual(i.columns, 3); assert.strictEqual(i.rows, 2);
    assert.strictEqual(i.columnSpacing, 5); assert.ok(Math.abs(i.rotation - 30) < 1e-6); assert.strictEqual(i.scale.x, 2);
    assert.strictEqual(i.attributes[0].tag, "NAME"); assert.strictEqual(i.attributes[0].value, "Val");
  });
  t("definitions once, with ATTDEF and nested reference preserved", () => {
    const d = nat.doc.blocks;
    assert.ok(d.TAGB && d.IN); assert.strictEqual(d.TAGB.attdefs[0].tag, "NAME"); assert.strictEqual(d.TAGB.attdefs[0].defaultValue, "dflt");
    assert.ok(d.TAGB.entities.some((e) => e.type === "INSERT" && e.name === "IN"));
  });
  t("resolved native geometry equals the legacy expanded geometry", () => {
    const i = nat.doc.entities.find((e) => e.type === "INSERT");
    const lines = (list) => list.filter((e) => e.type === "LINE").length;
    const nativeCount = lines(B.resolvedOf(i));
    const legacyCount = lines(leg.doc.entities);
    assert.strictEqual(nativeCount, legacyCount, `${nativeCount} vs ${legacyCount}`);
  });
  t("default mode still expands (backward compatible)", () => {
    assert.ok(!leg.doc.blocks); assert.ok(!leg.doc.entities.some((e) => e.type === "INSERT"));
  });
  for (const f of ["sample_2000.dwg", "sample_2018.dwg"]) {
    const fp = path.join(root, "tests", "fixtures", f);
    if (!fs.existsSync(fp)) continue;
    const b = fs.readFileSync(fp);
    const u8 = new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const a = await acad.parseWithAcadEngine(u8, f, { nativeBlocks: true });
    const l = await acad.parseWithAcadEngine(u8, f);
    t(`${f}: native doc bounded and equal in drawable line count to legacy`, () => {
      const flatN = (list) => list.flatMap((e) => (e.type === "INSERT" ? B.resolvedOf(e) : [e]));
      const cnt = (list, ty) => list.filter((e) => e.type === ty).length;
      const nn = flatN(a.doc.entities), ll = l.doc.entities;
      for (const ty of ["LINE", "CIRCLE", "ARC"]) assert.strictEqual(cnt(nn, ty), cnt(ll, ty), `${ty} ${cnt(nn, ty)} vs ${cnt(ll, ty)}`);
    });
  }
  console.log(`\ncad-engine-native-blocks: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
