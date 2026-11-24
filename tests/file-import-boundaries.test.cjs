/* File-import boundary hardening (issue #90): adversarial inputs + proof that
 * every boundary validates before parsing.
 *
 * Behaviour: pure modules compiled with tsc (same pattern as
 * tests/file-guard.test.cjs and tests/safe-load.test.cjs). Adversarial cases
 * cover malformed / truncated / oversized / deeply-nested / traversal
 * inputs for every format this PR bounds. Ordering: static source checks
 * that each call site invokes its guard before the read / parse sink.
 *
 * Run: npm run test:file-import-boundaries
 */
const { execFileSync } = require("node:child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const root = path.resolve(__dirname, "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "obs-import90-"));
fs.writeFileSync(path.join(out, "package.json"), '{"type":"commonjs"}');
fs.symlinkSync(path.join(root, "node_modules"), path.join(out, "node_modules"), "junction");
execFileSync("npx", ["tsc",
  "src/core/file-guard.ts", "src/core/safeLoad.ts",
  "src/modules/gis/gis-core.ts", "src/modules/schedule-4d/factor-import.ts",
  "src/modules/families/type-catalog.ts", "src/modules/drawings/landxml.ts",
  "src/modules/families/shared-parameters.ts",
  "--outDir", out, "--module", "commonjs", "--target", "es2020",
  "--moduleResolution", "node", "--esModuleInterop", "--skipLibCheck", "--noCheck"],
  { cwd: root, stdio: "inherit" });
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
const G = require(find("file-guard.js"));
const gis = require(find("gis-core.js"));
const factors = require(find("factor-import.js"));
const catalogs = require(find("type-catalog.js"));
const landxml = require(find("landxml.js"));
const shared = require(find("shared-parameters.js"));

let pass = 0, fail = 0;
const pending = [];
const t = (n, f) => { try { const r = f(); if (r && typeof r.then === "function") { pending.push(r.then(() => { pass++; console.log("  PASS " + n); }, (e) => { fail++; console.log("  FAIL " + n + ": " + e.message); })); return; } pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const sliceFn = (src, from, to) => { const a = src.indexOf(from); assert.ok(a >= 0, `missing ${from}`); const b = to ? src.indexOf(to, a + 1) : src.length; return src.slice(a, b < 0 ? src.length : b); };
const u8 = (s) => new Uint8Array(Buffer.from(s, "latin1"));

// ── A. Shared guard: new per-format limits ──────────────────────────────
console.log("=== A. file-guard limits ===");
t("new kinds have the documented limits and reject over-limit/empty files", () => {
  const expect = { frag: 4096 * 1024 * 1024, geojson: 20 * 1024 * 1024, shapefile: 256 * 1024 * 1024,
    mesh: 200 * 1024 * 1024, solid: 200 * 1024 * 1024, landxml: 5 * 1024 * 1024,
    factors: 5 * 1024 * 1024, "type-catalog": 5 * 1024 * 1024 };
  for (const [k, v] of Object.entries(expect)) {
    assert.strictEqual(G.FILE_LIMITS[k], v, k);
    assert.ok(G.guardSize(k, v).ok, `${k} at limit`);
    assert.ok(!G.guardSize(k, v + 1).ok, `${k} over limit`);
    assert.ok(!G.guardSize(k, 0).ok, `${k} empty`);
  }
});

// ── B. ZIP central-directory audit (zip bombs / traversal) ──────────────
console.log("=== B. ZIP audit ===");
function zipBytes({ entries = 1, comp = 100, raw = 100, name = "model.ifc", flags = 0 } = {}) {
  const nameB = Buffer.from(name, "latin1");
  const cdLen = 46 + nameB.length;
  const cd = Buffer.alloc(cdLen);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(comp, 20); cd.writeUInt32LE(raw, 24);
  cd.writeUInt16LE(nameB.length, 28);
  nameB.copy(cd, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries, 8); eocd.writeUInt16LE(entries, 10);
  eocd.writeUInt32LE(cdLen, 12); eocd.writeUInt32LE(0, 16);
  return new Uint8Array(Buffer.concat([cd, eocd]));
}
t("well-formed single-entry archive passes", () => { assert.ok(G.guardZipDirectory(zipBytes()).ok); });
t("zip bomb: implausible compression ratio is rejected", () => {
  const r = G.guardZipDirectory(zipBytes({ comp: 10, raw: 1_000_000 }));
  assert.ok(!r.ok && /ratio/.test(r.reason), r.reason);
});
t("path traversal entry is rejected", () => {
  const r = G.guardZipDirectory(zipBytes({ name: "../evil.ifc" }));
  assert.ok(!r.ok && /unsafe path/.test(r.reason), r.reason);
  assert.ok(!G.guardZipDirectory(zipBytes({ name: "/abs/model.ifc" })).ok);
  assert.ok(!G.guardZipDirectory(zipBytes({ name: "C:\\model.ifc" })).ok);
});
t("too many entries are rejected before the directory is walked", () => {
  const r = G.guardZipDirectory(zipBytes({ entries: 20001 }));
  assert.ok(!r.ok && /entries/.test(r.reason), r.reason);
});
t("truncated archive and lying stored entry are rejected", () => {
  assert.ok(!G.guardZipDirectory(new Uint8Array(10)).ok);
  assert.ok(!G.guardZipDirectory(zipBytes({ comp: 0, raw: 100, flags: 1 })).ok);
  assert.ok(!G.guardZipDirectory(zipBytes({ raw: 2 * 1024 * 1024 * 1024 })).ok);
});

// ── C. GeoJSON via safeLoad ─────────────────────────────────────────────
console.log("=== C. GeoJSON ===");
const gjPoint = (x = 10, y = 50) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [x, y] } });
t("valid FeatureCollection loads; bare geometry loads", () => {
  const doc = JSON.stringify({ type: "FeatureCollection", features: [gjPoint(), gjPoint(11, 51)] });
  assert.strictEqual(gis.parseGeoJson(doc, "site").features.length, 2);
  assert.strictEqual(gis.parseGeoJson(JSON.stringify({ type: "Point", coordinates: [1, 2] })).features.length, 1);
});
t("malformed JSON and non-GeoJSON keep the old error wording", () => {
  assert.throws(() => gis.parseGeoJson("{nope"), /valid JSON/);
  assert.throws(() => gis.parseGeoJson("[1]"), /Not GeoJSON/);
  assert.throws(() => gis.parseGeoJson("{}"), /Not GeoJSON/);
});
t("deeply nested geometry (>32 levels) is rejected, not stack-overflowed", () => {
  let g = { type: "Point", coordinates: [0, 0] };
  for (let i = 0; i < 40; i++) g = { type: "GeometryCollection", geometries: [g] };
  assert.throws(() => gis.parseGeoJson(JSON.stringify({ type: "Feature", properties: {}, geometry: g })), /too deeply nested|too large/);
});
t("oversized GeoJSON (>20 MB) is rejected before parsing", () => {
  assert.throws(() => gis.parseGeoJson(" ".repeat(21 * 1024 * 1024)), /exceeds the 20 MB/);
});
t("feature cap: 100,001 points stop at 100,000 with a warning", () => {
  const feats = new Array(100001).fill(gjPoint());
  const layer = gis.parseGeoJson(JSON.stringify({ type: "FeatureCollection", features: feats }));
  assert.strictEqual(layer.features.length, 100000);
  assert.ok(layer.warnings.some((w) => /100,000 features/.test(w)), layer.warnings.join(" | "));
});
t("vertex cap: 5M+ vertices stop with a warning (shared refs, no 300 MB fixture)", () => {
  const coords = new Array(5_000_001).fill([10, 50]);
  const layer = gis.parseGeoJsonDoc({ type: "FeatureCollection", features: [
    { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } },
  ] });
  assert.strictEqual(layer.features.length, 0);
  assert.ok(layer.warnings.some((w) => /5,000,000 vertices/.test(w)), layer.warnings.join(" | "));
});
t("non-finite coordinates are dropped, not rendered as NaN geometry", () => {
  // NB: the literal 1e999 must be in the FILE TEXT — JSON.stringify(1e999)
  // would already have turned it into null before the parser sees it.
  const layer = gis.parseGeoJson('{"type":"FeatureCollection","features":[' +
    '{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[1e999,50]}},' +
    '{"type":"Feature","properties":{},"geometry":{"type":"Point","coordinates":[10,50]}}]}');
  assert.strictEqual(layer.features.length, 1);
});

// ── D. Carbon factors ───────────────────────────────────────────────────
console.log("=== D. carbon factors ===");
t("valid CSV and JSON factor files import", () => {
  const csv = factors.parseFactors("type,unit,kgCO2e_per_unit,note\nIfcWall,m3,120,ok\nIfcSlab,m2,80,ok");
  assert.strictEqual(Object.keys(csv.factors).length, 2);
  assert.strictEqual(csv.factors.wall.kgCO2ePerUnit, 120);
  const js = factors.parseFactors(JSON.stringify([{ type: "IfcBeam", unit: "m", kgCO2ePerUnit: 5 }]));
  assert.strictEqual(Object.keys(js.factors).length, 1);
});
t("oversized factor text is reported with no factors merged", () => {
  const r = factors.parseFactors("x".repeat(5 * 1024 * 1024 + 1));
  assert.strictEqual(Object.keys(r.factors).length, 0);
  assert.ok(r.errors.some((e) => /exceeds the 5 MB/.test(e)), r.errors.join(" | "));
});
t("more than 50,000 factor rows are refused with no factors merged", () => {
  const rows = ["type,unit,kg"] .concat(new Array(50001).fill("IfcWall,m3,1"));
  const r = factors.parseFactors(rows.join("\n"));
  assert.strictEqual(Object.keys(r.factors).length, 0);
  assert.ok(r.errors.some((e) => /50,000/.test(e)), r.errors.join(" | "));
  const bigJson = JSON.stringify(new Array(50001).fill({ type: "IfcWall", unit: "m3", kgCO2ePerUnit: 1 }));
  const r2 = factors.parseFactors(bigJson);
  assert.strictEqual(Object.keys(r2.factors).length, 0);
});
t("invalid JSON factor file records an error instead of throwing", () => {
  const r = factors.parseFactors("{nope");
  assert.strictEqual(Object.keys(r.factors).length, 0);
  assert.ok(r.errors.some((e) => /invalid JSON/.test(e)));
});

// ── E. Type catalogs ────────────────────────────────────────────────────
console.log("=== E. type catalogs ===");
const validCatalog = "##TYPE\nDoor,Width##length<meters>,Height##length<meters>\nD1,0.9,2.1\nD2,1.0,2.1\n";
t("valid catalog parses; bad rows still throw with a row number", () => {
  const c = catalogs.TypeCatalogManager.parseCSV(validCatalog);
  assert.strictEqual(c.familyName, "Door");
  assert.strictEqual(c.types.length, 2);
  assert.strictEqual(c.types[0].values.Width, 0.9);
  assert.throws(() => catalogs.TypeCatalogManager.parseCSV("##TYPE\nDoor,Width##length<meters>\nD1,not-a-number\n"), /Row 3/);
});
t("oversized catalog, >10,000 rows and >500 parameters are refused", () => {
  assert.throws(() => catalogs.TypeCatalogManager.parseCSV("x".repeat(5 * 1024 * 1024 + 1)), /exceeds the 5 MB/);
  const rows = ["##TYPE", "Fam,W##length<meters>"].concat(new Array(10001).fill("T1,1"));
  assert.throws(() => catalogs.TypeCatalogManager.parseCSV(rows.join("\n")), /10,000 type rows/);
  const header = ["##TYPE", ["Fam"].concat(new Array(501).fill("P##length<meters>")).join(",")];
  assert.throws(() => catalogs.TypeCatalogManager.parseCSV(header.concat(["T1"].concat(new Array(501).fill("1")).join(",")).join("\n")), /500 parameters/);
});
t("loadFromFile checks size before reading the blob", async () => {
  const ok = await catalogs.TypeCatalogManager.loadFromFile(new Blob([validCatalog]));
  assert.strictEqual(ok.types.length, 2);
  await assert.rejects(
    catalogs.TypeCatalogManager.loadFromFile(new Blob(["x".repeat(5 * 1024 * 1024 + 1)])),
    /exceeds the 5 MB/,
  );
});

// ── F. LandXML ──────────────────────────────────────────────────────────
console.log("=== F. LandXML ===");
const cg = (n, x, y) => `<CgPoint name="P${n}">${y} ${x}</CgPoint>`;
t("valid CgPoints parse (northing easting → y x); unparsable coords skipped", () => {
  const pts = landxml.parseLandXmlPoints(`<LandXML><CgPoints>${cg(1, 100, 200)}${cg(2, 101, 201)}<CgPoint name="bad">oops nope</CgPoint></CgPoints></LandXML>`);
  assert.strictEqual(pts.length, 2);
  assert.strictEqual(pts[0].x, 100);
  assert.strictEqual(pts[0].y, 200);
  assert.strictEqual(landxml.isLandXml(`<LandXML><CgPoints>`), true);
});
t("more than 100,000 CgPoints are refused, not half-imported", () => {
  let s = "<LandXML><CgPoints>";
  for (let i = 0; i < 100001; i++) s += cg(i, i, i);
  s += "</CgPoints></LandXML>";
  assert.throws(() => landxml.parseLandXmlPoints(s), /100,000 CgPoints/);
});

// ── G. Shared parameters ────────────────────────────────────────────────
console.log("=== G. shared parameters ===");
t("valid import merges; bad JSON, non-array and oversize are refused", () => {
  const m = new shared.SharedParameterManager(null);
  const got = m.import(JSON.stringify([
    { guid: "11111111-1111-4111-8111-111111111111", name: "Width", group: "Dims", type: "length", defaultValue: 1, isInstance: true },
    { name: "Note", type: "string", defaultValue: "x", isInstance: false },
  ]));
  assert.strictEqual(got.length, 2);
  assert.throws(() => m.import("{nope"), /not valid JSON/);
  assert.throws(() => m.import(JSON.stringify({ a: 1 })), /must be a JSON array/);
  assert.throws(() => m.import("x".repeat(1024 * 1024 + 1)), /exceeds the 1 MB/);
  assert.throws(() => m.import(JSON.stringify(new Array(10001).fill({ name: "P" }))), /10,000 parameters/);
});

// ── H. Ordering proofs: guard before read / parse at every new boundary ─
console.log("=== H. guard-before-parse ordering ===");
t("importer: IFCZIP size guard precedes the full read; convert path guards + preflights before WASM", () => {
  const src = read("src/features/importer.ts");
  const exp = sliceFn(src, "export async function expandIfcSources", "\nexport ");
  assert.ok(exp.indexOf('guardSize("ifc"') < exp.indexOf("file.arrayBuffer()"));
  const conv = sliceFn(src, "export async function convertIfcToFragBytes", "\nexport function loadIfcFiles");
  assert.ok(conv.indexOf('assertFileAllowed("ifc"') < conv.indexOf("file.arrayBuffer()"));
  assert.ok(conv.indexOf("preflightStep(bytes)") < conv.indexOf("getImporter().process"));
  const frag = sliceFn(src, "export async function loadFragFiles", "\nexport async function convertIfcToFragBytes");
  assert.ok(frag.indexOf('assertFileAllowed("frag"') < frag.indexOf("file.arrayBuffer()"));
  const task = sliceFn(src, 't.status = "reading"', "t.schema = detectSchema");
  assert.ok(task.indexOf('assertFileAllowed("ifc", t.file.name, t.file.size)') >= 0);
  assert.ok(task.indexOf('assertFileAllowed("ifc", t.file.name, t.file.size)') < task.indexOf("t.file.arrayBuffer()"));
});
t("file-interop: ZIP audit precedes JSZip; geojson/solid/mesh size guards precede reads; restoreAux is bounded", () => {
  const src = read("src/features/file-interop.ts");
  assert.ok(src.indexOf("guardZipDirectory(zipBytes)") < src.indexOf("JSZip.loadAsync(zipBytes)"));
  assert.ok(src.indexOf('guardSize("ifc", file.size)') < src.indexOf("JSZip.loadAsync(zipBytes)"));
  const geo = sliceFn(src, 'if (e === "geojson"', 'if (e === "step"');
  assert.ok(geo.indexOf('guardSize(') < geo.indexOf("file.arrayBuffer()"));
  const solid = sliceFn(src, 'if (e === "step"', 'if (e === "dbf"');
  assert.ok(solid.indexOf('guardSize("solid"') < solid.indexOf("file.arrayBuffer()"));
  const mesh = sliceFn(src, "Everything else", "parseModelBytes(buf");
  assert.ok(mesh.indexOf('guardSize("mesh"') < mesh.indexOf("file.arrayBuffer()"));
  const aux = sliceFn(src, "export async function restoreAux", "async function parseModelBytes");
  assert.ok(aux.indexOf("assertAuxSize(name, blob.size)") < aux.indexOf("blob.arrayBuffer()"));
});
t("cad-viewer: LandXML size + entity ban precede parsing; PDFIN guards before buffering", () => {
  const src = read("src/features/cad-viewer.ts");
  const lx = sliceFn(src, "async function importLandXml", "\n  /** DATAEXTRACT");
  assert.ok(lx.indexOf('guardSize("landxml"') < lx.indexOf("f.text()"));
  assert.ok(lx.indexOf("guardXmlText(text)") < lx.indexOf("parseLandXmlPoints(text)"));
  const pdf = sliceFn(src, "async function importPdfAsDrawing", "\nfunction openBlank");
  assert.ok(pdf.indexOf('assertFileAllowed("pdf"') < pdf.indexOf("file.arrayBuffer()"));
});
t("gis-core routes GeoJSON through safeLoad (no bare JSON.parse of file text)", () => {
  const src = read("src/modules/gis/gis-core.ts");
  assert.ok(src.includes('safeLoad("GeoJSON"'));
  assert.ok(!/JSON\.parse\(text/.test(src));
});
t("rvt-viewer checks RVT_MAX_BYTES before buffering; worker replies are validated", () => {
  const src = read("src/features/rvt-viewer.ts");
  assert.ok(src.indexOf("file.size > RVT_MAX_BYTES") < src.indexOf("file.arrayBuffer()"));
  assert.ok(src.includes("m.glb instanceof Uint8Array"));
});
t("timeline-panel checks the factor size before reading; type-catalog loadFromFile does the same", () => {
  const tl = read("src/features/timeline-panel.ts");
  const pick = sliceFn(tl, "export function pickAndImportFactors", "\nlet curvesEl");
  assert.ok(pick.indexOf("FACTORS_MAX_BYTES") < pick.indexOf("f.text()"));
  const tc = read("src/modules/families/type-catalog.ts");
  const lf = sliceFn(tc, "static async loadFromFile", "\n  /** Reports non-fatal");
  assert.ok(lf.indexOf("TYPE_CATALOG_MAX_BYTES") < lf.indexOf("file.text()"));
});
t("solid reader worker validates the request payload before starting", () => {
  const src = read("src/modules/solids/solid-reader-worker.ts");
  const h = sliceFn(src, 'self.addEventListener("message"', 'post({ id: req.id, kind: "started" })');
  assert.ok(h.includes("SOLID_READER_MAX_BYTES"));
  assert.ok(h.includes("req.bytes instanceof ArrayBuffer"));
});
t("AI provider streams drop overlong lines in all three loops; realtime + agent SSE are size/shape checked", () => {
  const ai = read("src/features/ai-providers.ts");
  assert.strictEqual((ai.match(/buffer\.length > MAX_SSE_LINE_BYTES/g) || []).length, 3);
  const rt = read("src/modules/collaboration/realtime-client.ts");
  assert.ok(rt.indexOf("MAX_SSE_EVENT_BYTES") < rt.indexOf("JSON.parse"));
  assert.ok(rt.includes('typeof change.clientId !== "string"'));
  const ab = read("src/features/agent-bridge.ts");
  assert.ok(ab.includes("MAX_SSE_EVENT_BYTES"));
  assert.ok(ab.indexOf("MAX_SSE_EVENT_BYTES") < ab.indexOf("askAgent(String(data.ask)"));
});
t("CDE requestJson caps the response before parsing; journal lines fail typed, not raw", () => {
  const http = read("src/modules/cde/http.ts");
  assert.ok(http.indexOf("MAX_JSON_RESPONSE_BYTES") < http.indexOf("JSON.parse(text)"));
  assert.ok(http.includes('res.headers.get("content-length")'));
  const j = read("src/modules/projects/indexeddb-journal.ts");
  const ap = sliceFn(j, "async appendLine", "async writeSnapshot");
  assert.ok(ap.indexOf("try {") < ap.indexOf("JSON.parse(line)"));
  assert.ok(ap.includes("Corrupt journal entry"));
});

// ── summary ─────────────────────────────────────────────────────────────
(async () => {
  await Promise.all(pending);
  console.log(`\nfile-import-boundaries: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
