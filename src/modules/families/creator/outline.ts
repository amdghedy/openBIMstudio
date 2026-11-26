/**
 * Prototype: a picture of a flat shape (a silhouette or an outline drawing on a plain
 * background) becomes a real polygon with holes, scaled by one stated dimension.
 *
 * What it reads: the pixels. What it does not read: hidden geometry, depth, curves as
 * curves (they become short straight segments within a stated tolerance), or anything
 * the picture does not show. Depth is a number the user supplies.
 */

export interface RGBA { data: ArrayLike<number>; width: number; height: number }
export type Pt = [number, number];

export interface OutlineOptions {
  /** 0-255 luminance distance from the background that counts as the object. Default 40. */
  threshold?: number;
  /** Simplification tolerance in pixels. Default 1.5. */
  tolerancePx?: number;
  /** Loops smaller than this share of the largest loop's area are dropped and reported. Default 0.0005. */
  minAreaShare?: number;
}

export interface Loop { points: Pt[]; areaPx: number }
export interface OutlineResult {
  outer: Pt[]; holes: Pt[][];
  /** Pixel size of the picture and of the traced shape. */
  widthPx: number; heightPx: number; shapeWidthPx: number; shapeHeightPx: number;
  dropped: number; background: number; maskShare: number;
}

const lum = (d: ArrayLike<number>, i: number) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

/** Binary mask: object pixels differ from the border background. Transparent pixels count as background. */
export function maskFromImage(img: RGBA, threshold = 40): { mask: Uint8Array; background: number } {
  const { data, width: w, height: h } = img;
  const border: number[] = [];
  for (let x = 0; x < w; x++) { border.push(lum(data, 4 * x), lum(data, 4 * ((h - 1) * w + x))); }
  for (let y = 0; y < h; y++) { border.push(lum(data, 4 * y * w), lum(data, 4 * (y * w + w - 1))); }
  border.sort((a, b) => a - b);
  const background = border[border.length >> 1];
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = data[4 * i + 3];
    mask[i] = a > 127 && Math.abs(lum(data, 4 * i) - background) > threshold ? 1 : 0;
  }
  return { mask, background };
}

/** Boundary loops of a binary mask on the pixel-corner grid. Outer loops are counter-clockwise (image y down: positive area), holes the opposite. */
export function traceLoops(mask: Uint8Array, w: number, h: number): Loop[] {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
  const W = w + 1;
  const key = (x: number, y: number) => y * W + x;
  // Directed edges with the filled cell on the right-hand side (image y down).
  const next = new Map<number, number[]>();
  const push = (x0: number, y0: number, x1: number, y1: number) => {
    const k = key(x0, y0);
    const v = key(x1, y1);
    const l = next.get(k); if (l) l.push(v); else next.set(k, [v]);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!at(x, y)) continue;
    if (!at(x, y - 1)) push(x, y, x + 1, y);          // top edge, going right
    if (!at(x + 1, y)) push(x + 1, y, x + 1, y + 1);  // right edge, going down
    if (!at(x, y + 1)) push(x + 1, y + 1, x, y + 1);  // bottom edge, going left
    if (!at(x - 1, y)) push(x, y + 1, x, y);          // left edge, going up
  }
  const loops: Loop[] = [];
  const dirOf = (a: number, b: number): Pt => [Math.sign((b % W) - (a % W)), Math.sign(Math.floor(b / W) - Math.floor(a / W))];
  while (next.size) {
    const start = next.keys().next().value as number;
    const pts: Pt[] = [];
    let cur = start, prev = -1;
    for (let guard = 0; guard < 4 * w * h + 8; guard++) {
      pts.push([cur % W, Math.floor(cur / W)]);
      const outs = next.get(cur);
      if (!outs || !outs.length) break;
      let pick = 0;
      if (outs.length > 1 && prev >= 0) {
        // Two outgoing edges (cells touching at a corner): turn right so loops stay separate.
        const din = dirOf(prev, cur);
        let best = -Infinity;
        outs.forEach((o, i) => { const d = dirOf(cur, o); const cross = din[0] * d[1] - din[1] * d[0]; if (cross > best) { best = cross; pick = i; } });
      }
      const to = outs.splice(pick, 1)[0];
      if (!outs.length) next.delete(cur);
      prev = cur; cur = to;
      if (cur === start) break;
    }
    let a = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; }
    if (pts.length >= 3) loops.push({ points: pts, areaPx: a / 2 });
  }
  return loops;
}

const dist = (p: Pt, a: Pt, b: Pt) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  if (!L) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dx * (a[1] - p[1]) - (a[0] - p[0]) * dy) / L;
};
function dp(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts;
  let m = 0, at = -1;
  for (let i = 1; i < pts.length - 1; i++) { const d = dist(pts[i], pts[0], pts[pts.length - 1]); if (d > m) { m = d; at = i; } }
  if (m <= tol) return [pts[0], pts[pts.length - 1]];
  return [...dp(pts.slice(0, at + 1), tol).slice(0, -1), ...dp(pts.slice(at), tol)];
}
/** Douglas-Peucker on a closed loop, split at the two points farthest apart. */
export function simplifyLoop(pts: Pt[], tol: number): Pt[] {
  if (pts.length <= 4) return pts;
  let i0 = 0, i1 = 0, best = -1;
  const step = Math.max(1, Math.floor(pts.length / 200));
  for (let i = 0; i < pts.length; i += step) for (let j = i + 1; j < pts.length; j += step) {
    const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1]); if (d > best) { best = d; i0 = i; i1 = j; }
  }
  const a = pts.slice(i0, i1 + 1), b = [...pts.slice(i1), ...pts.slice(0, i0 + 1)];
  const out = [...dp(a, tol).slice(0, -1), ...dp(b, tol).slice(0, -1)];
  return out.length >= 3 ? out : pts;
}

const inside = (p: Pt, poly: Pt[]) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if ((poly[i][1] > p[1]) !== (poly[j][1] > p[1]) && p[0] < ((poly[j][0] - poly[i][0]) * (p[1] - poly[i][1])) / (poly[j][1] - poly[i][1]) + poly[i][0]) c = !c;
  }
  return c;
};

export function extractOutline(img: RGBA, opts: OutlineOptions = {}): OutlineResult {
  const { mask, background } = maskFromImage(img, opts.threshold ?? 40);
  const loops = traceLoops(mask, img.width, img.height);
  const outers = loops.filter((l) => l.areaPx > 0).sort((a, b) => b.areaPx - a.areaPx);
  if (!outers.length) throw new Error("No shape found: the picture matches its own background everywhere.");
  const main = outers[0];
  const min = Math.abs(main.areaPx) * (opts.minAreaShare ?? 0.0005);
  const tol = opts.tolerancePx ?? 1.5;
  const outer = simplifyLoop(main.points, tol);
  const holes: Pt[][] = [];
  let dropped = outers.length - 1;
  for (const l of loops) {
    if (l.areaPx >= 0) continue;
    if (Math.abs(l.areaPx) < min) { dropped++; continue; }
    if (!inside(l.points[0], main.points)) { dropped++; continue; }
    holes.push(simplifyLoop(l.points, tol));
  }
  const xs = outer.map((p) => p[0]), ys = outer.map((p) => p[1]);
  let on = 0; for (let i = 0; i < mask.length; i++) on += mask[i];
  return {
    outer, holes, widthPx: img.width, heightPx: img.height,
    shapeWidthPx: Math.max(...xs) - Math.min(...xs), shapeHeightPx: Math.max(...ys) - Math.min(...ys),
    dropped, background, maskShare: on / mask.length,
  };
}

export interface ScaledOutline {
  /** Metres, origin at the shape's bottom-left, y up. Outer is counter-clockwise, holes clockwise. */
  outer: Pt[]; holes: Pt[][]; widthM: number; heightM: number; scaleMPerPx: number; warnings: string[];
}

/**
 * Scale by what the user states. One dimension fixes the scale. A second one is a check, never a second scale:
 * if it disagrees with the picture's aspect ratio by more than `tolerance`, say so instead of stretching.
 */
export function scaleOutline(o: OutlineResult, known: { widthM?: number; heightM?: number }, tolerance = 0.03): ScaledOutline {
  const warnings: string[] = [];
  let s: number;
  if (known.widthM && known.widthM > 0) s = known.widthM / o.shapeWidthPx;
  else if (known.heightM && known.heightM > 0) s = known.heightM / o.shapeHeightPx;
  else throw new Error("Give at least one real dimension (width or height) so the picture can be scaled.");
  if (known.widthM && known.heightM) {
    const implied = o.shapeHeightPx * s;
    if (Math.abs(implied - known.heightM) / known.heightM > tolerance) {
      warnings.push(`The picture's proportions give a height of ${Math.round(implied * 1000)} mm for the stated width, not ${Math.round(known.heightM * 1000)} mm. The width was used. Check the dimensions or the picture.`);
    }
  }
  const minX = Math.min(...o.outer.map((p) => p[0])), maxY = Math.max(...o.outer.map((p) => p[1]));
  const conv = (l: Pt[]): Pt[] => l.map((p) => [(p[0] - minX) * s, (maxY - p[1]) * s] as Pt);
  const area = (l: Pt[]) => l.reduce((a, p, i) => { const q = l[(i + 1) % l.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2;
  let outer = conv(o.outer); if (area(outer) < 0) outer = outer.reverse();
  const holes = o.holes.map((h) => { const c = conv(h); return area(c) > 0 ? c.reverse() : c; });
  return { outer, holes, widthM: o.shapeWidthPx * s, heightM: o.shapeHeightPx * s, scaleMPerPx: s, warnings };
}
