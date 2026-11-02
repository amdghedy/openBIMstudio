const { execSync } = require("child_process");
const fs = require("fs"), path = require("path"), assert = require("assert");
const out = fs.mkdtempSync(path.join(require("os").tmpdir(), "pc-"));
execSync(`npx tsc src/modules/point-cloud/parsers.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`, { stdio: "pipe" });
const m = require(path.join(out, "parsers.js"));
let n = 0; const ok = (c, s) => { assert.ok(c, s); n++; };
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

// ── build a LAS 1.2, point format 2 (xyz + rgb), 3 points, UTM-sized coordinates
function las(pts, fmt = 2, ver = [1, 2]) {
  const recLen = fmt === 2 ? 26 : 20, hdr = 227, buf = Buffer.alloc(hdr + pts.length * recLen), dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  buf.write("LASF", 0, "ascii"); buf[24] = ver[0]; buf[25] = ver[1];
  dv.setUint16(94, hdr, true); dv.setUint32(96, hdr, true); buf[104] = fmt; dv.setUint16(105, recLen, true); dv.setUint32(107, pts.length, true);
  const sc = 0.001, off = [500000, 3000000, 100];
  [sc, sc, sc].forEach((v, i) => dv.setFloat64(131 + i * 8, v, true)); off.forEach((v, i) => dv.setFloat64(155 + i * 8, v, true));
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y), zs = pts.map((p) => p.z);
  dv.setFloat64(179, Math.max(...xs), true); dv.setFloat64(187, Math.min(...xs), true);
  dv.setFloat64(195, Math.max(...ys), true); dv.setFloat64(203, Math.min(...ys), true);
  dv.setFloat64(211, Math.max(...zs), true); dv.setFloat64(219, Math.min(...zs), true);
  pts.forEach((p, i) => {
    const o = hdr + i * recLen;
    dv.setInt32(o, Math.round((p.x - off[0]) / sc), true); dv.setInt32(o + 4, Math.round((p.y - off[1]) / sc), true); dv.setInt32(o + 8, Math.round((p.z - off[2]) / sc), true);
    if (fmt === 2) { dv.setUint16(o + 20, p.r, true); dv.setUint16(o + 22, p.g, true); dv.setUint16(o + 24, p.b, true); }
  });
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
}
const pts = [{ x: 500010, y: 3000020, z: 105, r: 65535, g: 0, b: 0 }, { x: 500020, y: 3000040, z: 110, r: 0, g: 65535, b: 0 }, { x: 500030, y: 3000060, z: 115, r: 0, g: 0, b: 65535 }];
let r = m.parseLas(las(pts));
ok(r.total === 3 && r.kept === 3 && r.format === "las", "counts");
ok(near(r.origin[0], 500020) && near(r.origin[1], 110) && near(r.origin[2], 3000040), "origin = centre in project axes (x, up=z, north=y)");
ok(near(r.positions[0], -10) && near(r.positions[1], -5) && near(r.positions[2], -20), "first point relative to origin, axes mapped");
ok(near(r.positions[0] + r.origin[0], 500010) && near(r.positions[2] + r.origin[2], 3000020), "true coordinates recoverable");
ok(r.colors && near(r.colors[0], 1) && near(r.colors[4], 1) && near(r.colors[8], 1), "16-bit colours normalised");
// no colour (format 0)
r = m.parseLas(las(pts.map((p) => ({ ...p })), 0));
ok(r.colors === null, "format 0 has no colour");
// decimation
r = m.parseLas(las(pts), 2); ok(r.kept === 2 && r.total === 3, "decimated to budget");
// errors
let e1 = ""; try { m.parseLas(new ArrayBuffer(300)); } catch (e) { e1 = e.message; }
ok(/LASF/.test(e1), "not a LAS");
const laz = Buffer.from(new Uint8Array(las(pts))); laz[104] = 2 | 0x80;
let e2 = ""; try { m.parseLas(laz.buffer.slice(laz.byteOffset, laz.byteOffset + laz.length)); } catch (e) { e2 = e.message; }
ok(/LAZ/.test(e2), "LAZ rejected with guidance");

// ── PTX: 2x1 scan, identity matrix with translation, one invalid 0 0 0 point
const ptx = ["2", "1", "0 0 0", "1 0 0", "0 1 0", "0 0 1", "1 0 0 0", "0 1 0 0", "0 0 1 0", "10 20 30 1", "1 2 3 0.5 255 0 0", "0 0 0 0 0 0 0"].join("\\n").replace(/\\n/g, "\n");
r = m.parsePtx(ptx);
ok(r.format === "ptx" && r.kept === 1 && r.total === 2, "ptx counts (invalid point dropped)");
ok(near(r.origin[0], 11) && near(r.origin[1], 33) && near(r.origin[2], 22), "ptx matrix applied, axes mapped");
ok(r.colors && near(r.colors[0], 1) && near(r.colors[1], 0), "ptx rgb");
let e3 = ""; try { m.parsePtx("hello\nworld"); } catch (e) { e3 = e.message; }
ok(/PTX/.test(e3), "bad ptx");
// unsupported table
ok(m.UNSUPPORTED_POINT_CLOUD.rwcx && /RealWorks/.test(m.UNSUPPORTED_POINT_CLOUD.rwcx.name) && m.UNSUPPORTED_POINT_CLOUD.rcp, "proprietary formats listed with export instructions");
console.log(`point-cloud-parsers: ${n} checks OK`);
