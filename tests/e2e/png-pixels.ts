/**
 * Minimal PNG decoder for pixel assertions in Playwright specs.
 *
 * Playwright screenshots are non-interlaced 8-bit RGB/RGBA PNGs. This
 * decodes them with node:zlib only (no new dependency) so a spec can count
 * real rendered pixels — e.g. "the tag stroke colour appears N times" —
 * instead of asserting on DOM structure alone.
 */
import zlib from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA, row-major, length width*height*4. */
  data: Buffer;
}

export function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new Error('not a PNG');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} not supported`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`color type ${colorType} not supported`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const recon = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? recon[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      recon[x] = v;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (channels === 4) {
        out[o] = recon[x * 4];
        out[o + 1] = recon[x * 4 + 1];
        out[o + 2] = recon[x * 4 + 2];
        out[o + 3] = recon[x * 4 + 3];
      } else {
        out[o] = recon[x * 3];
        out[o + 1] = recon[x * 3 + 1];
        out[o + 2] = recon[x * 3 + 2];
        out[o + 3] = 255;
      }
    }
    prev = recon;
  }
  return { width, height, data: out };
}

/** Count pixels whose RGB matches the predicate. */
export function countPixels(
  png: DecodedPng,
  pred: (r: number, g: number, b: number) => boolean,
): number {
  let n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (pred(png.data[i], png.data[i + 1], png.data[i + 2])) n++;
  }
  return n;
}

/** Count matching pixels inside a rectangle (x, y, w, h) in PNG pixels. */
export function countPixelsIn(
  png: DecodedPng,
  rect: { x: number; y: number; w: number; h: number },
  pred: (r: number, g: number, b: number) => boolean,
): number {
  let n = 0;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(png.width, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(png.height, Math.ceil(rect.y + rect.h));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * png.width + x) * 4;
      if (pred(png.data[i], png.data[i + 1], png.data[i + 2])) n++;
    }
  }
  return n;
}

/** Predicate: pixel within `tol` per channel of (r, g, b). */
export function colorNear(
  r: number,
  g: number,
  b: number,
  tol = 14,
): (R: number, G: number, B: number) => boolean {
  return (R, G, B) =>
    Math.abs(R - r) <= tol && Math.abs(G - g) <= tol && Math.abs(B - b) <= tol;
}

/** Predicate: near-black pixel (cut wall lines are #111827). */
export function isDark(R: number, G: number, B: number): boolean {
  return R < 70 && G < 70 && B < 70;
}

/** Predicate: greenish pixel — a teal/green hue surviving anti-aliasing.
 *  A tag's text is paper-scaled (3 mm at 1:100 ≈ 8 px at fit zoom), so its
 *  glyphs are fully anti-aliased: no pixel is pure #0f766e. The tag is
 *  instead visible as greenish blends (e.g. (156,200,196)) against the
 *  pale bubble fill / white paper. Counts those blends. */
export function isGreenish(R: number, G: number, B: number): boolean {
  return G > R + 15 && G > B + 5 && G > 70;
}

/** Predicate: reddish pixel — a red hue surviving anti-aliasing.
 *  Revision clouds are drawn as thin red (#ef4444) polylines; at fit zoom
 *  their pixels are anti-aliased blends, not pure red. */
export function isReddish(R: number, G: number, B: number): boolean {
  return R > 150 && R > G + 60 && R > B + 60;
}

/** Predicate: not (near-)white — any drawn content. */
export function isDrawn(R: number, G: number, B: number): boolean {
  return R < 245 || G < 245 || B < 245;
}
