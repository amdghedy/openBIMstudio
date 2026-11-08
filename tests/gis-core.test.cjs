// GeoJSON / Shapefile / DBF readers and local projection (pure, no DOM).
const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "gis-"));
execSync(`npx tsc src/modules/gis/gis-core.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck --strict`, { stdio: "pipe" });
const find = (n) => { const w = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { const r = w(p); if (r) return r; } else if (f.name === n) return p; } }; return w(out); };
const G = require(find("gis-core.js"));
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const near = (a, b, e) => ok(Math.abs(a - b) <= e, `${a} !~ ${b} (±${e})`);

// ---- GeoJSON
const gj = JSON.stringify({ type: "FeatureCollection", features: [
  { type: "Feature", properties: { name: "Plot", floors: 3, nested: { a: 1 } }, geometry: { type: "Polygon", coordinates: [[[10, 50], [10.001, 50], [10.001, 50.001], [10, 50.001], [10, 50]]] } },
  { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[10, 50], [10.001, 50.001]] } },
  { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [10.0005, 50.0005] } },
  { type: "Feature", properties: {}, geometry: null },
  { type: "Feature", properties: {}, geometry: { type: "Point", coordinates: ["x"] } },
] });
let L = G.parseGeoJson(gj, "site");
ok(L.features.length === 3, "3 usable features: " + L.features.length);
ok(L.features[0].kind === "polygon" && L.features[0].props.floors === 3 && L.features[0].props.nested === '{"a":1}', "props");
ok(L.warnings.length === 1 && /skipped/.test(L.warnings[0]), "skipped warning");
let P = G.toLocal(L);
ok(P.geographic && /WGS84/.test(P.crsNote), "geographic detected");
// 0.001° lat ≈ 111.3 m ; 0.001° lon at 50° ≈ 71.5 m
near(P.heightM, 111.3, 0.5); near(P.widthM, 71.55, 0.5);
const poly = P.features[0].parts[0];
near(poly[0][0], -P.widthM / 2, 1e-6); near(poly[2][1], P.heightM / 2, 1e-6);
ok(G.parseGeoJson(JSON.stringify({ type: "Point", coordinates: [1, 2] })).features.length === 1, "bare geometry");
assert.throws(() => G.parseGeoJson("{nope"), /valid JSON/); n++;
assert.throws(() => G.parseGeoJson("[1]"), /Not GeoJSON/); n++;
ok(G.parseGeoJson(JSON.stringify({ type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[5, 5], [6, 5], [6, 6], [5, 5]]]] })).features[0].parts.length === 2, "multipolygon parts");

// ---- Shapefile (built by hand)
function shp(type, records) {
  const bodies = records.map((r) => r);
  const total = 100 + bodies.reduce((s, b) => s + 8 + b.byteLength, 0);
  const buf = new ArrayBuffer(total), dv = new DataView(buf);
  dv.setInt32(0, 9994, false); dv.setInt32(24, total / 2, false); dv.setInt32(28, 1000, true); dv.setInt32(32, type, true);
  let o = 100;
  bodies.forEach((b, i) => { dv.setInt32(o, i + 1, false); dv.setInt32(o + 4, b.byteLength / 2, false); new Uint8Array(buf).set(new Uint8Array(b), o + 8); o += 8 + b.byteLength; });
  return buf;
}
function polyRec(type, parts) {
  const np = parts.flat().length;
  const b = new ArrayBuffer(44 + parts.length * 4 + np * 16), d = new DataView(b);
  d.setInt32(0, type, true); d.setInt32(36, parts.length, true); d.setInt32(40, np, true);
  let idx = 0; parts.forEach((p, i) => { d.setInt32(44 + i * 4, idx, true); idx += p.length; });
  let o = 44 + parts.length * 4; for (const [x, y] of parts.flat()) { d.setFloat64(o, x, true); d.setFloat64(o + 8, y, true); o += 16; }
  return b;
}
function point(x, y) { const b = new ArrayBuffer(20), d = new DataView(b); d.setInt32(0, 1, true); d.setFloat64(4, x, true); d.setFloat64(12, y, true); return b; }
// projected metres (outside lon/lat range)
const sq = [[500000, 4000000], [500100, 4000000], [500100, 4000050], [500000, 4000050], [500000, 4000000]];
const nullRec = (() => { const b = new ArrayBuffer(4); new DataView(b).setInt32(0, 0, true); return b; })();
let S = G.parseShapefile(shp(5, [polyRec(5, [sq]), nullRec, polyRec(5, [sq, sq.slice(0, 4).concat([sq[0]])])]), undefined, "parcels");
ok(S.features.length === 2 && S.features[0].kind === "polygon" && S.features[1].parts.length === 2, "polygons + null skipped + multi-ring");
ok(S.warnings.some((w) => /no \.dbf/i.test(w)), "dbf missing warning");
P = G.toLocal(S);
ok(!P.geographic && /NOT verified/.test(P.crsNote), "projected assumption disclosed");
near(P.widthM, 100, 1e-9); near(P.features[0].parts[0][0][0], -50, 1e-9);
ok(G.parseShapefile(shp(3, [polyRec(3, [[[0, 0], [10, 10]], [[5, 5], [6, 6], [7, 5]]])])).features[0].parts.length === 2, "polyline parts");
ok(G.parseShapefile(shp(1, [point(1, 2), point(3, 4)])).features.length === 2, "points");
// PointZ layout (type 11) read as x,y
const pz = (() => { const b = new ArrayBuffer(36), d = new DataView(b); d.setInt32(0, 11, true); d.setFloat64(4, 7, true); d.setFloat64(12, 8, true); return b; })();
ok(G.parseShapefile(shp(11, [pz])).features[0].parts[0][0][1] === 8, "PointZ");
// multipatch is reported
const mp = (() => { const b = new ArrayBuffer(8); new DataView(b).setInt32(0, 31, true); return b; })();
ok(G.parseShapefile(shp(31, [mp])).warnings.some((w) => /unsupported/.test(w)), "unsupported reported");
assert.throws(() => G.parseShapefile(new ArrayBuffer(200)), /bad file code/); n++;
assert.throws(() => G.parseShapefile(new ArrayBuffer(10)), /small/); n++;
// truncated record must not throw or loop
const t = shp(1, [point(1, 2)]).slice(0, 110);
ok(G.parseShapefile(t).warnings.some((w) => /truncated/.test(w)), "truncated handled");
// hostile counts
const evil = (() => { const b = new ArrayBuffer(44); const d = new DataView(b); d.setInt32(0, 5, true); d.setInt32(36, 1e9, true); d.setInt32(40, 1e9, true); return b; })();
ok(G.parseShapefile(shp(5, [evil])).features.length === 0, "hostile counts ignored");

// ---- DBF
function dbf(rows) {
  const fields = [["NAME", "C", 10], ["AREA", "N", 8], ["OK", "L", 1]];
  const headLen = 32 + fields.length * 32 + 1, recLen = 1 + 19;
  const b = new ArrayBuffer(headLen + rows.length * recLen), d = new DataView(b), u = new Uint8Array(b);
  d.setUint32(4, rows.length, true); d.setUint16(8, headLen, true); d.setUint16(10, recLen, true);
  fields.forEach(([nm, ty, ln], i) => { const o = 32 + i * 32; u.set(new TextEncoder().encode(nm), o); u[o + 11] = ty.charCodeAt(0); u[o + 16] = ln; });
  u[headLen - 1] = 0x0d;
  rows.forEach((r, i) => { let o = headLen + i * recLen; u[o++] = 0x20; for (const [k, , ln] of fields) { const s = String(r[k]).padEnd(ln, " "); u.set(new TextEncoder().encode(s), o); o += ln; } });
  return b;
}
const rows = G.parseDbf(dbf([{ NAME: "Lot 1", AREA: 12.5, OK: "T" }, { NAME: "Lot 2", AREA: "", OK: "F" }]));
ok(rows.length === 2 && rows[0].NAME === "Lot 1" && rows[0].AREA === 12.5 && rows[0].OK === true && rows[1].AREA === null && rows[1].OK === false, "dbf types");
S = G.parseShapefile(shp(5, [polyRec(5, [sq]), polyRec(5, [sq])]), dbf([{ NAME: "A", AREA: 1, OK: "T" }, { NAME: "B", AREA: 2, OK: "T" }]));
ok(S.features[1].props.NAME === "B", "attributes joined by record order");
ok(G.parseDbf(new ArrayBuffer(3)).length === 0, "tiny dbf");
// empty layer
ok(G.toLocal({ name: "e", features: [], warnings: [] }).features.length === 0, "empty layer");
console.log(`gis-core: ${n} assertions passed`);
