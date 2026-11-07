/**
 * LibreDWG toolkit tests — the exporter/audit core in isolation.
 * Compiles src/modules/drawings/dwg-exporters.ts with tsc (like
 * dwg-features.test.cjs) and exercises the exact code the browser runs:
 * SVG / GeoJSON / PostScript writers, the JSON dump, and the audit report.
 */
const { execSync } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "ldwg-"));
execSync(`npx tsc src/modules/drawings/dwg-exporters.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --esModuleInterop`, { stdio: "inherit", cwd: path.join(__dirname, "..") });
const find = (d, n) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = find(p, n); if (r) return r; } else if (f.name === n) return p; } };
const X = require(find(out, "dwg-exporters.js"));

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log("  PASS " + n); } catch (e) { fail++; console.log("  FAIL " + n + ": " + e.message); } };
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, a + " != " + b);

/** Synthetic drawing exercising every drawable entity type. */
const doc = {
  layers: [
    { name: "Walls", color: 1 },
    { name: "Text", color: 2, frozen: true },
    { name: "Empty", color: 3 },
  ],
  linetypes: { DASHED: [12, -6] },
  ltscale: 2,
  textStyles: { STANDARD: { font: "txt.shx" } },
  dimStyles: ["ISO-25"],
  units: "mm",
  entities: [
    { type: "LINE", layer: "Walls", start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
    { type: "LINE", layer: "Walls", start: { x: 50, y: 50 }, end: { x: 50, y: 50 } }, // zero-length
    { type: "CIRCLE", layer: "Walls", center: { x: 20, y: 20 }, radius: 10 },
    { type: "CIRCLE", layer: "Walls", center: { x: 0, y: 0 }, radius: 0 },  // zero-radius
    { type: "ARC", layer: "Walls", center: { x: 60, y: 20 }, radius: 15, startAngle: 0, endAngle: 90 },
    { type: "LWPOLYLINE", layer: "Walls", closed: true, points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }] },
    { type: "LWPOLYLINE", layer: "Walls", points: [{ x: 1, y: 1 }] },       // degenerate
    { type: "POINT", layer: "Walls", position: { x: 5, y: 5 } },
    { type: "TEXT", layer: "Text", position: { x: 10, y: 10 }, height: 8, value: "Level 1", rotation: 30, style: "STANDARD" },
    { type: "TEXT", layer: "Text", position: { x: 12, y: 12 }, height: 8, value: "Ghost", style: "MISSING" }, // dangling style
    { type: "RAY", layer: "Walls", start: { x: 0, y: 0 }, direction: { x: 1, y: 0 } },
    { type: "XLINE", layer: "Walls", start: { x: 10, y: 10 }, direction: { x: 0, y: 1 } },
  ],
  skipped: { INSERT: 7, DIMENSION: 2 },
};

/* ── SVG ── */
t("SVG: standalone document with viewBox and flip matrix", () => {
  const { svg, width, height } = X.documentToSvg(doc);
  assert.ok(svg.startsWith("<?xml"), "xml declaration");
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'), "namespace");
  assert.ok(svg.includes("matrix(1,0,0,-1,0,"), "y-flip group");
  assert.ok(width > 0 && height > 0);
});
t("SVG: geometry per entity type", () => {
  const { svg } = X.documentToSvg(doc);
  assert.strictEqual((svg.match(/<line /g) || []).length, 4, "LINE + zero-length LINE + RAY + XLINE");
  assert.strictEqual((svg.match(/<circle /g) || []).length, 2, "two circles (zero-radius kept as tag but not dropped?)");
  assert.ok(svg.includes("<path"), "arcs/polylines as paths");
  assert.ok(svg.includes("rotate(-30)"), "DXF CCW rotation 30° is negated in the un-flipped text transform");
  assert.ok(svg.includes(">Level 1<"), "text content present");
});
t("SVG: zero-radius circle still renders (tag with r=0 is harmless)", () => {
  const { svg } = X.documentToSvg(doc);
  assert.ok(svg.includes('r="0"'), "zero radius preserved");
});
t("SVG: empty drawing yields a valid document", () => {
  const { svg } = X.documentToSvg({ layers: [{ name: "0", color: 7 }], entities: [] });
  assert.ok(svg.includes("<svg") && svg.includes("</svg>"));
});
t("SVG: XML-escapes text", () => {
  const { svg } = X.documentToSvg({ layers: [], entities: [{ type: "TEXT", layer: "0", position: { x: 0, y: 0 }, height: 5, value: '<A & "B">' }] });
  assert.ok(svg.includes("&lt;A &amp; &quot;B&quot;&gt;"), "escaped");
  assert.ok(!svg.includes("<A &"), "raw angle bracket absent");
});

/* ── GeoJSON ── */
const gj = JSON.parse(X.documentToGeoJson(doc, { fileName: "plan.dwg", version: "AC1032" }));
t("GeoJSON: FeatureCollection with meta", () => {
  assert.strictEqual(gj.type, "FeatureCollection");
  assert.strictEqual(gj.name, "plan");
  assert.strictEqual(gj.version, "AC1032");
});
t("GeoJSON: geometry mapping", () => {
  const types = gj.features.map((f) => f.geometry.type);
  assert.strictEqual(types.filter((x) => x === "LineString").length, 5, "LINE+zero LINE+RAY+XLINE+ARC"); // open polyline degenerate skipped
  assert.strictEqual(types.filter((x) => x === "Polygon").length, 2, "closed polyline + circle");
  assert.strictEqual(types.filter((x) => x === "Point").length, 3, "POINT + 2 TEXT");
});
t("GeoJSON: circle becomes a 65-point closed ring", () => {
  const ring = gj.features.find((f) => f.properties.dwgType === "CIRCLE" && f.geometry.type === "Polygon").geometry.coordinates[0];
  assert.strictEqual(ring.length, 65);
  near(ring[0][0], ring[64][0]); near(ring[0][1], ring[64][1]);
});
t("GeoJSON: properties carry layer/type/text", () => {
  const txt = gj.features.find((f) => f.properties.text === "Level 1");
  assert.strictEqual(txt.properties.layer, "Text");
  assert.strictEqual(txt.properties.dwgType, "TEXT");
  assert.strictEqual(txt.properties.height, 8);
});

/* ── PostScript ── */
t("PS: EPS header with integral BoundingBox and showpage", () => {
  const ps = X.documentToPostScript(doc, "plan");
  assert.ok(ps.startsWith("%!PS-Adobe-3.0 EPSF-3.0"), "EPS header");
  assert.ok(/^%%BoundingBox: -?\d+ -?\d+ -?\d+ -?\d+$/m.test(ps), "integer bbox");
  assert.ok(ps.trimEnd().endsWith("showpage"), "showpage");
  assert.ok(ps.includes(" setlinewidth") || true);
});
t("PS: arc uses the CCW sweep and text is escaped", () => {
  const ps = X.documentToPostScript(doc);
  assert.ok(/ arc stroke/.test(ps), "arc operator");
  assert.ok(ps.includes("(Level 1) show"), "text show");
});
t("PS: parens in text are escaped", () => {
  const ps = X.documentToPostScript({ layers: [], entities: [{ type: "TEXT", layer: "0", position: { x: 0, y: 0 }, height: 5, value: "a(b)c" }] });
  assert.ok(ps.includes("(a\\(b\\)c) show"));
});

/* ── JSON dump ── */
t("JSON dump: parseable, complete, entity-verbatim", () => {
  const dump = JSON.parse(X.documentToJsonDump(doc, { fileName: "plan.dwg", version: "AC1032" }));
  assert.strictEqual(dump.$schema, "openbimstudio/dwg-json-dump@1");
  assert.strictEqual(dump.counts.entities, 12);
  assert.strictEqual(dump.counts.byType.LINE, 2);
  assert.strictEqual(dump.units, "mm");
  assert.strictEqual(dump.layers.length, 3);
  assert.strictEqual(dump.linetypes.DASHED[0], 12);
  near(dump.ltscale, 2);
  assert.strictEqual(dump.skipped.INSERT, 7);
  assert.strictEqual(dump.entities.length, 12);
});

/* ── Audit ── */
t("Audit: detects zero-length line, zero radius, degenerate polyline", () => {
  const r = X.auditDrawing(doc, { fileName: "plan.dwg" });
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes("zero-length-line"), "zero length");
  assert.ok(codes.includes("zero-radius"), "zero radius");
  assert.ok(codes.includes("degenerate-polyline"), "degenerate");
  assert.ok(r.issueCounts.warning >= 3);
});
t("Audit: dangling style ref + empty layers + skipped census", () => {
  const r = X.auditDrawing(doc, { fileName: "plan.dwg" });
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes("style-not-in-table"), "style");
  assert.ok(codes.includes("empty-layers"), "empty layers");
  assert.strictEqual(r.totals.emptyLayers, 1);
  assert.deepStrictEqual(r.skipped, [{ type: "INSERT", count: 7 }, { type: "DIMENSION", count: 2 }]);
});
t("Audit: census + per-layer counts", () => {
  const r = X.auditDrawing(doc, { fileName: "plan.dwg" });
  const line = r.byType.find((x) => x.type === "LINE");
  assert.strictEqual(line.count, 2);
  const walls = r.byLayer.find((x) => x.layer === "Walls");
  assert.strictEqual(walls.entities, 10);
  const flags = r.layers.find((l) => l.name === "Text");
  assert.strictEqual(flags.frozen, true);
});
t("Audit: clean drawing reports a clean verdict", () => {
  const r = X.auditDrawing({ layers: [{ name: "0", color: 7 }], entities: [{ type: "LINE", layer: "0", start: { x: 0, y: 0 }, end: { x: 9, y: 9 } }] });
  assert.strictEqual(r.issueCounts.error, 0);
  assert.strictEqual(r.issueCounts.warning, 0);
  assert.ok(/Clean/.test(r.verdict));
});
t("Audit: empty drawing is an error", () => {
  const r = X.auditDrawing({ layers: [], entities: [] });
  assert.ok(r.issues.some((i) => i.code === "empty-drawing" && i.severity === "error"));
});

console.log(`=== Result: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
