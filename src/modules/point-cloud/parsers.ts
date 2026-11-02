/** Point-cloud file parsers (pure, no DOM / three). Output positions are in PROJECT axes
 *  (X east, Y up, Z north) and relative to `origin` so large survey coordinates keep float precision. */
export interface ParsedCloud {
  format: "las" | "ptx";
  /** x,y,z triples relative to `origin`. */
  positions: Float32Array;
  /** r,g,b in 0..1, or null when the file has no colour / intensity. */
  colors: Float32Array | null;
  /** Centre of the cloud in project axes (double precision). Add to positions to get true coordinates. */
  origin: [number, number, number];
  /** Points in the file / points kept after decimation. */
  total: number;
  kept: number;
  info: string;
}

/** Formats that are proprietary or compressed: cannot be decoded in the browser. */
export const UNSUPPORTED_POINT_CLOUD: Record<string, { name: string; how: string }> = {
  rwcx: { name: "Trimble RWCX scan (proprietary)", how: "Use the Trimble import assistant: import the original Siteworks Work Order .SPJ in TBC (Scanning support) or open the source scan data in RealWorks, then export registered points as LAS or PTX. RWCX is not decoded directly in the browser." },
  rwp: { name: "Trimble RealWorks project", how: "In RealWorks export the scans as LAS, E57 or PTX." },
  rcp: { name: "Autodesk ReCap project", how: "In ReCap choose Export > LAS (or E57 / PTS), then link that file." },
  rcs: { name: "Autodesk ReCap scan", how: "Open the project in ReCap and export it as LAS (or E57 / PTS)." },
  fls: { name: "Faro Scene scan", how: "In Faro Scene export the scan as E57, LAS or PTX." },
  fws: { name: "Faro Scene workspace", how: "In Faro Scene export the scans as E57, LAS or PTX." },
  lsproj: { name: "Faro Scene project", how: "In Faro Scene export the scans as E57, LAS or PTX." },
  zfs: { name: "Z+F scan", how: "In Z+F LaserControl export the scan as LAS, E57 or PTX." },
  cpe: { name: "Leica Cyclone", how: "In Cyclone / Register 360 export as LAS, E57 or PTX." },
  imp: { name: "Leica Cyclone", how: "In Cyclone export as LAS, E57 or PTX." },
  pod: { name: "Bentley POD", how: "In Bentley Descartes / MicroStation export as LAS or E57." },
  laz: { name: "Compressed LAS (LAZ)", how: "Decompress it to .las with LAStools (laszip) or CloudCompare, then link the .las." },
  e57: { name: "ASTM E57", how: "Convert to LAS with CloudCompare (File > Save as LAS) or ReCap, then link the .las." },
};

const MAX_DEFAULT = 2_000_000;

function chooseOrigin(min: [number, number, number], max: [number, number, number]): [number, number, number] {
  return [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
}

/** LAS 1.0 - 1.4, point data record formats 0-10 (uncompressed). Source axes: X east, Y north, Z up. */
export function parseLas(buf: ArrayBuffer, maxPoints = MAX_DEFAULT): ParsedCloud {
  const dv = new DataView(buf);
  if (buf.byteLength < 227 || String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== "LASF") {
    throw new Error("Not a LAS file (missing LASF signature).");
  }
  const vMajor = dv.getUint8(24), vMinor = dv.getUint8(25);
  const offsetToPoints = dv.getUint32(96, true);
  const rawFmt = dv.getUint8(104);
  if (rawFmt & 0x80) throw new Error("This is a compressed LAZ file. Decompress it to .las first (LAStools laszip or CloudCompare).");
  const fmt = rawFmt & 0x3f;
  const recLen = dv.getUint16(105, true);
  let total = dv.getUint32(107, true);
  if (vMajor === 1 && vMinor >= 4 && buf.byteLength >= 375) {
    const big = Number(dv.getBigUint64(247, true));
    if (big > 0) total = big;
  }
  const minRec = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67][fmt];
  if (minRec === undefined) throw new Error(`Unsupported LAS point format ${fmt}.`);
  if (recLen < minRec) throw new Error(`LAS record length ${recLen} is too short for point format ${fmt}.`);
  const maxByFile = Math.floor((buf.byteLength - offsetToPoints) / recLen);
  if (total > maxByFile) total = maxByFile;
  if (total < 1) throw new Error("The LAS file contains no points.");
  const sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true);
  const ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
  const maxX = dv.getFloat64(179, true), minX = dv.getFloat64(187, true);
  const maxY = dv.getFloat64(195, true), minY = dv.getFloat64(203, true);
  const maxZ = dv.getFloat64(211, true), minZ = dv.getFloat64(219, true);
  // project axes: X east = LAS X, Y up = LAS Z, Z north = LAS Y
  const origin = chooseOrigin([minX, minZ, minY], [maxX, maxZ, maxY]);
  const rgbOff = ({ 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 } as Record<number, number>)[fmt];
  const step = total > maxPoints ? Math.ceil(total / maxPoints) : 1;
  const kept = Math.ceil(total / step);
  const positions = new Float32Array(kept * 3);
  const colors = rgbOff !== undefined ? new Float32Array(kept * 3) : null;
  let max16 = 0;
  let n = 0;
  for (let i = 0; i < total; i += step) {
    const p = offsetToPoints + i * recLen;
    const x = dv.getInt32(p, true) * sx + ox, y = dv.getInt32(p + 4, true) * sy + oy, z = dv.getInt32(p + 8, true) * sz + oz;
    positions[n * 3] = x - origin[0]; positions[n * 3 + 1] = z - origin[1]; positions[n * 3 + 2] = y - origin[2];
    if (colors) {
      const r = dv.getUint16(p + rgbOff!, true), g = dv.getUint16(p + rgbOff! + 2, true), b = dv.getUint16(p + rgbOff! + 4, true);
      colors[n * 3] = r; colors[n * 3 + 1] = g; colors[n * 3 + 2] = b;
      if (r > max16) max16 = r; if (g > max16) max16 = g; if (b > max16) max16 = b;
    }
    n++;
  }
  if (colors) {
    if (max16 === 0) return { format: "las", positions, colors: null, origin, total, kept: n, info: `LAS ${vMajor}.${vMinor} format ${fmt}` };
    const div = max16 > 255 ? 65535 : 255; // 8-bit colour stored in the 16-bit field is common
    for (let i = 0; i < colors.length; i++) colors[i] /= div;
  }
  return { format: "las", positions, colors, origin, total, kept: n, info: `LAS ${vMajor}.${vMinor} point format ${fmt}` };
}

/** Leica PTX (ASCII, one or more scans). Points are transformed by each scan's 4x4 matrix. Source axes Z up. */
export function parsePtx(text: string, maxPoints = MAX_DEFAULT): ParsedCloud {
  const lines = text.split(/\r?\n/);
  const pts: number[] = [];
  const cols: number[] = [];
  let hasColor = false, hasIntensity = false;
  // First pass: count points to pick the decimation step.
  let li = 0, totalAll = 0;
  const scans: Array<{ start: number; count: number; m: number[] }> = [];
  while (li < lines.length) {
    if (!lines[li].trim()) { li++; continue; }
    const c = parseInt(lines[li], 10), r = parseInt(lines[li + 1], 10);
    if (!Number.isFinite(c) || !Number.isFinite(r) || c <= 0 || r <= 0) throw new Error("Not a valid PTX file (bad scan header).");
    const m: number[] = [];
    for (let k = 0; k < 4; k++) { const row = (lines[li + 6 + k] ?? "").trim().split(/\s+/).map(Number); if (row.length < 4 || row.some((v) => !Number.isFinite(v))) throw new Error("Not a valid PTX file (bad transform matrix)."); m.push(...row); }
    const start = li + 10;
    scans.push({ start, count: c * r, m });
    totalAll += c * r;
    li = start + c * r;
  }
  if (!scans.length) throw new Error("The PTX file contains no scans.");
  const step = totalAll > maxPoints ? Math.ceil(totalAll / maxPoints) : 1;
  let seen = 0;
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const raw: number[] = [];
  for (const s of scans) {
    for (let i = 0; i < s.count; i++) {
      seen++;
      if ((seen - 1) % step !== 0) continue;
      const parts = (lines[s.start + i] ?? "").trim().split(/\s+/);
      if (parts.length < 3) continue;
      const x = +parts[0], y = +parts[1], z = +parts[2];
      if (!Number.isFinite(x) || (x === 0 && y === 0 && z === 0)) continue; // PTX marks missing returns as 0 0 0
      const m = s.m; // row-vector convention: p' = p * M
      const X = x * m[0] + y * m[4] + z * m[8] + m[12], Y = x * m[1] + y * m[5] + z * m[9] + m[13], Z = x * m[2] + y * m[6] + z * m[10] + m[14];
      // project axes: east = X, up = Z, north = Y
      raw.push(X, Z, Y);
      if (X < min[0]) min[0] = X; if (Z < min[1]) min[1] = Z; if (Y < min[2]) min[2] = Y;
      if (X > max[0]) max[0] = X; if (Z > max[1]) max[1] = Z; if (Y > max[2]) max[2] = Y;
      if (parts.length >= 7) { hasColor = true; cols.push(+parts[4] / 255, +parts[5] / 255, +parts[6] / 255); }
      else if (parts.length >= 4) { hasIntensity = true; const v = +parts[3]; const g = v > 1.0001 ? v / 255 : v; cols.push(g, g, g); }
      else cols.push(0.6, 0.65, 0.72);
    }
  }
  const kept = raw.length / 3;
  if (kept < 1) throw new Error("The PTX file contains no valid points.");
  const origin = chooseOrigin(min, max);
  const positions = new Float32Array(raw.length);
  for (let i = 0; i < kept; i++) { positions[i * 3] = raw[i * 3] - origin[0]; positions[i * 3 + 1] = raw[i * 3 + 1] - origin[1]; positions[i * 3 + 2] = raw[i * 3 + 2] - origin[2]; }
  return { format: "ptx", positions, colors: new Float32Array(cols), origin, total: totalAll, kept, info: `PTX, ${scans.length} scan(s)${hasColor ? ", RGB" : hasIntensity ? ", intensity" : ""}` };
}
