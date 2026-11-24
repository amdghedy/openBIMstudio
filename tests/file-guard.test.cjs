/* Pre-parse guards for non-JSON untrusted files (issue #90): behaviour + proof that every boundary calls them first. */
const { execSync } = require("child_process"); const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.join(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "fg-"));
execSync(`npx tsc src/core/file-guard.ts --outDir ${out} --module commonjs --target es2020 --lib es2020,dom --skipLibCheck${process.env.TSC_IGNORE_CONFIG ? " --ignoreConfig" : ""}`, { stdio: "pipe", cwd: root });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r } else if (f.name === n) return p } };
const G = require(find(out, "file-guard.js"));
let pass = 0, fail = 0; const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n) } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message) } };
const u8 = (s) => new Uint8Array(Buffer.from(s, "latin1"));

// ---- size ----
t("empty and oversized files are rejected per kind", () => {
  assert.strictEqual(G.guardSize("ids", 0).ok, false);
  assert.strictEqual(G.guardSize("ids", G.FILE_LIMITS.ids + 1).ok, false);
  assert.strictEqual(G.guardSize("ids", 1000).ok, true);
  for (const k of Object.keys(G.FILE_LIMITS)) assert.strictEqual(G.guardSize(k, G.FILE_LIMITS[k] + 1).ok, false, k);
  assert.strictEqual(G.guardSize("ifc", NaN).ok, false);
});
// ---- signatures ----
t("DWG signature", () => { assert.ok(G.guardSignature("dwg", u8("AC1032\0\0\0\0\0\0")).ok); assert.ok(!G.guardSignature("dwg", u8("hello world")).ok); assert.ok(!G.guardSignature("dwg", u8("PK\u0003\u0004")).ok); });
t("PDF signature", () => { assert.ok(G.guardSignature("pdf", u8("%PDF-1.7\n")).ok); assert.ok(!G.guardSignature("pdf", u8("<html>")).ok); });
t("DXF signature: ascii, comment-prefixed, binary; rejects others", () => {
  assert.ok(G.guardSignature("dxf", u8("  0\r\nSECTION\r\n  2\r\nHEADER\r\n")).ok);
  assert.ok(G.guardSignature("dxf", u8("999\nmade by x\n0\nSECTION\n")).ok);
  assert.ok(G.guardSignature("dxf", u8("AutoCAD Binary DXF\r\n\u001a\0")).ok);
  assert.ok(!G.guardSignature("dxf", u8("AC1032\0\0")).ok);
  assert.ok(!G.guardSignature("dxf", u8("{\"json\":1}")).ok);
});
t("BCF requires a ZIP signature", () => { assert.ok(G.guardSignature("bcf", u8("PK\u0003\u0004rest")).ok); assert.ok(!G.guardSignature("bcf", u8("<xml/>")).ok); });
// ---- LAS ----
const las = (over = {}) => { const b = new Uint8Array(500); b.set(u8("LASF"), 0); const dv = new DataView(b.buffer); dv.setUint32(96, over.offset ?? 227, true); dv.setUint16(105, over.rec ?? 20, true); dv.setUint32(107, over.count ?? 10, true); return b; };
t("LAS header: valid, wrong magic, lying point count, bad record length, bad offset", () => {
  assert.ok(G.guardLasHeader(las()).ok);
  const b = las(); b[0] = 0x58; assert.ok(!G.guardLasHeader(b).ok);
  assert.ok(!G.guardLasHeader(las({ count: 4_000_000_000 })).ok);
  assert.ok(!G.guardLasHeader(las({ rec: 2 })).ok);
  assert.ok(!G.guardLasHeader(las({ offset: 10_000 })).ok);
  assert.ok(!G.guardLasHeader(new Uint8Array(100)).ok);
});
t("LAS header: 1000-point file accepted when the guard sees the whole file", () => {
  // Regression (refs #90): parseLas used to pass only the first 4096 bytes to the guard,
  // which falsely rejects any file declaring more than floor((4096 - 227) / recLen) points.
  const b = new Uint8Array(227 + 1000 * 20); b.set(u8("LASF"), 0);
  const dv = new DataView(b.buffer); dv.setUint32(96, 227, true); dv.setUint16(105, 20, true); dv.setUint32(107, 1000, true);
  assert.ok(G.guardLasHeader(b).ok);
  // …while the same header over a 4 KiB window is (correctly, for a truncated buffer) rejected —
  // this is why the caller must pass the full buffer, not a window.
  assert.ok(!G.guardLasHeader(b.subarray(0, 4096)).ok);
});
// ---- XML ----
t("XML: entity declarations and inline DOCTYPE subsets rejected", () => {
  assert.ok(G.guardXmlText('<ids xmlns="http://standards.buildingsmart.org/IDS"><info/></ids>').ok);
  assert.ok(!G.guardXmlText('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>').ok);
  assert.ok(!G.guardXmlText('<!DOCTYPE x [ ]><x/>').ok);
  assert.ok(!G.guardXmlText("x".repeat(G.FILE_LIMITS.ids + 1)).ok);
});
// ---- ZIP ----
function zip(entries, opts = {}) {
  const parts = [], cd = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "latin1"), data = Buffer.from(e.data ?? "x");
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.method ?? 0, 10);
    ch.writeUInt32LE(e.comp ?? data.length, 20); ch.writeUInt32LE(e.raw ?? data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    cd.push(ch, name); off += 30 + name.length + data.length;
  }
  const cdBuf = Buffer.concat(cd), eo = Buffer.alloc(22);
  eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(opts.entries ?? entries.length, 10); eo.writeUInt32LE(cdBuf.length, 12); eo.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...parts, cdBuf, eo]));
}
t("ZIP: normal archive accepted", () => assert.ok(G.guardZipDirectory(zip([{ name: "bcf.version" }, { name: "a/b/markup.bcf" }])).ok));
for (const name of ["../evil.txt", "a/../../evil", "/abs/path", "C:\\x", "a\\b", "a\0b"]) t(`ZIP: unsafe path rejected: ${JSON.stringify(name)}`, () => assert.ok(!G.guardZipDirectory(zip([{ name }])).ok));
t("ZIP: bomb ratio, huge entry, too many entries, no directory, truncation, ZIP64", () => {
  assert.ok(!G.guardZipDirectory(zip([{ name: "b", comp: 10, raw: 100_000_000 }])).ok);
  assert.ok(!G.guardZipDirectory(zip([{ name: "b", comp: 4_294_967_295 / 2, raw: 4_294_967_295 }])).ok); // uint32-max entry: above the 4095 MiB/entry bound
  assert.ok(!G.guardZipDirectory(zip([{ name: "a", comp: 2_200_000_000, raw: 2_200_000_000 }, { name: "b", comp: 2_200_000_000, raw: 2_200_000_000 }])).ok); // 2 × 2.05 GiB entries pass the per-entry bound but blow the 4096 MiB total
  assert.ok(!G.guardZipDirectory(zip([{ name: "a" }], { entries: 30000 })).ok);
  assert.ok(!G.guardZipDirectory(u8("PK\u0003\u0004 not really a zip at all, long enough to scan....")).ok);
  assert.ok(!G.guardZipDirectory(zip([{ name: "a" }]).subarray(0, 40)).ok);
  assert.ok(!G.guardZipDirectory(zip([{ name: "a" }], { entries: 0xffff })).ok);
});
t("ZIP: guard is linear — 20000 entries audited quickly", () => {
  const e = Array.from({ length: 20000 }, (_, i) => ({ name: `f${i}.xml`, data: "x" })); const z = zip(e);
  const t0 = Date.now(); const r = G.guardZipDirectory(z); assert.ok(r.ok); assert.ok(Date.now() - t0 < 1500);
});
t("assertFileAllowed throws a FileGuardError that promises unchanged state", () => {
  assert.throws(() => G.assertFileAllowed("dwg", "x.dwg", 10, u8("garbage garbage garbage garbage")), (e) => e.name === "FileGuardError" && /project is unchanged/.test(e.message));
  G.assertFileAllowed("dwg", "x.dwg", 10, u8("AC1027\0\0\0\0\0\0\0"));
});

// ---- every boundary calls its guard BEFORE parsing / mutating (static ordering proof) ----
const src = (p) => fs.readFileSync(path.join(root, p), "utf8");
const before = (p, guard, sink, label) => t(`${label}: guard precedes parse (${p})`, () => {
  const s = src(p); const g = s.indexOf(guard), k = s.indexOf(sink);
  assert.ok(g >= 0, `guard ${guard} missing`); assert.ok(k >= 0, `sink ${sink} missing`); assert.ok(g < k, "guard must come first");
});
before("src/modules/cad-link/index.ts", 'assertFileAllowed("dwg", file.name, file.size, await readHead(file, 32));\n  const bytes = await file.arrayBuffer();\n  const id = ++nextParseId;\n  const run = (): Promise<{ doc', "const run = (): Promise<{ doc", "DWG read");
t("DWG thumbnail and DXF link guarded", () => { const s = src("src/modules/cad-link/index.ts"); assert.ok(/readDwgThumbnail[\s\S]{0,200}assertFileAllowed\("dwg"/.test(s)); assert.ok(s.includes('assertFileAllowed("dxf", file.name, file.size, await readHead(file, 256));\n    const doc = parseDxf(')); });
before("src/modules/drawings/dxf-reader.ts", 'assertFileAllowed("dxf"', "const buf = await file.arrayBuffer();", "DXF reader");
before("src/features/ids-panel.ts", 'assertFileAllowed("ids"', "parseIdsXml(xml)", "IDS");
before("src/features/ids-panel.ts", "guardXmlText(xml)", "parseIdsXml(xml)", "IDS xml");
before("src/features/standards-panel.ts", 'guardSize("standards-pack"', "loadPackText(await f.text())", "standards pack");
before("src/modules/pdf-underlay/pdf-underlay.ts", 'assertFileAllowed("pdf"', "PDFDocument.load(bytes)", "PDF");
before("src/modules/point-cloud/point-cloud.ts", 'assertFileAllowed("point-cloud"', "const buf = await file.arrayBuffer();", "PLY");
before("src/modules/point-cloud/parsers.ts", "guardLasHeader(", "const vMajor", "LAS");
before("src/modules/issues/bcf.ts", "guardZipDirectory(bcfBytes)", "JSZip.loadAsync(bcfBytes)", "BCF");
before("src/modules/issues/bcf.ts", "guardZipDirectory(bcfBytes)", "const imported: Issue[]", "BCF state");
before("src/features/importer.ts", "guardZipDirectory(zipBytes)", "JSZip.loadAsync(zipBytes", "IFCZIP");
before("src/features/importer.ts", 'assertFileAllowed("ifc"', "preflightStep(bytes)", "IFC");
before("src/features/importer.ts", "preflightStep(bytes)", "detectSchema(bytes)", "IFC pre-flight");
console.log(`file-guard: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
