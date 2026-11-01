/** Smart wall detection from CAD line work (pure, no DOM).
 *
 *  CAD plans draw a wall as TWO parallel face lines. This module
 *   1. merges collinear / overlapping segments into long lines,
 *   2. pairs parallel lines that are a plausible wall thickness apart and overlap along their length,
 *   3. emits ONE centre-line wall per pair (thickness = the distance between the faces),
 *   4. optionally turns unpaired lines into single-line walls with a default thickness,
 *   5. bridges collinear walls across door/window openings.
 *  Coordinates are plan metres [x, z]. */
export interface Seg { x1: number; z1: number; x2: number; z2: number }
export interface DetectedWall { x1: number; z1: number; x2: number; z2: number; thickness: number; source: "pair" | "single" }
export interface DetectOptions {
  /** Thinnest / thickest wall (m) that two parallel lines may form. */
  minThickness: number; maxThickness: number;
  /** Smallest wall length (m) to keep. */
  minLength: number;
  /** Angle tolerance (degrees) for parallel / collinear tests. */
  angleTolDeg: number;
  /** Offset tolerance (m) for collinear lines. */
  offsetTol: number;
  /** Largest gap (m) in a line that is still the same wall (door / window openings). 0 = no bridging. */
  bridgeGap: number;
  /** Turn lines that have no partner into walls of `defaultThickness`. */
  includeSingleLines: boolean;
  defaultThickness: number;
}
export const DEFAULT_DETECT: DetectOptions = {
  minThickness: 0.05, maxThickness: 0.6, minLength: 0.3, angleTolDeg: 1, offsetTol: 0.02,
  bridgeGap: 1.2, includeSingleLines: false, defaultThickness: 0.2,
};
export interface DetectResult {
  walls: DetectedWall[];
  stats: { inputSegments: number; mergedLines: number; pairedWalls: number; singleLineWalls: number; thicknesses: Record<string, number> };
}

interface Line { ux: number; uz: number; nx: number; nz: number; c: number; t1: number; t2: number; consumed: Array<[number, number]> }

const canon = (dx: number, dz: number): [number, number] => {
  const l = Math.hypot(dx, dz); let ux = dx / l, uz = dz / l;
  if (ux < -1e-9 || (Math.abs(ux) <= 1e-9 && uz < 0)) { ux = -ux; uz = -uz; }
  return [ux, uz];
};

/** Group segments by direction and offset, merge overlaps (gap <= `gap`). */
function mergeCollinear(segs: Seg[], angleTol: number, offTol: number, gap: number): Line[] {
  const sinTol = Math.sin(angleTol);
  const clusters: Array<{ ux: number; uz: number; nx: number; nz: number; c: number; iv: Array<[number, number]> }> = [];
  for (const s of segs) {
    const len = Math.hypot(s.x2 - s.x1, s.z2 - s.z1);
    if (len < 1e-6) continue;
    const [ux, uz] = canon(s.x2 - s.x1, s.z2 - s.z1);
    let cl: (typeof clusters)[number] | undefined;
    for (const k of clusters) {
      if (Math.abs(ux * k.uz - uz * k.ux) > sinTol || ux * k.ux + uz * k.uz < 0) continue;
      const c = s.x1 * k.nx + s.z1 * k.nz;
      if (Math.abs(c - k.c) <= offTol) { cl = k; break; }
    }
    if (!cl) { cl = { ux, uz, nx: -uz, nz: ux, c: s.x1 * -uz + s.z1 * ux, iv: [] }; clusters.push(cl); }
    const a = s.x1 * cl.ux + s.z1 * cl.uz, b = s.x2 * cl.ux + s.z2 * cl.uz;
    cl.iv.push([Math.min(a, b), Math.max(a, b)]);
  }
  const lines: Line[] = [];
  for (const k of clusters) {
    k.iv.sort((p, q) => p[0] - q[0]);
    let cur = k.iv[0];
    for (let i = 1; i <= k.iv.length; i++) {
      const nx = k.iv[i];
      if (nx && nx[0] <= cur[1] + gap) cur = [cur[0], Math.max(cur[1], nx[1])];
      else { lines.push({ ux: k.ux, uz: k.uz, nx: k.nx, nz: k.nz, c: k.c, t1: cur[0], t2: cur[1], consumed: [] }); if (nx) cur = nx; }
    }
  }
  return lines;
}

const pt = (l: Line, t: number): [number, number] => [l.ux * t + l.nx * l.c, l.uz * t + l.nz * l.c];
const tOf = (l: Line, p: [number, number]) => p[0] * l.ux + p[1] * l.uz;

function freeParts(a: number, b: number, used: Array<[number, number]>): Array<[number, number]> {
  let parts: Array<[number, number]> = [[a, b]];
  for (const [u1, u2] of used) {
    const next: Array<[number, number]> = [];
    for (const [p1, p2] of parts) {
      if (u2 <= p1 || u1 >= p2) { next.push([p1, p2]); continue; }
      if (u1 > p1) next.push([p1, u1]);
      if (u2 < p2) next.push([u2, p2]);
    }
    parts = next;
  }
  return parts;
}

export function detectWalls(segs: Seg[], opts: Partial<DetectOptions> = {}): DetectResult {
  const o = { ...DEFAULT_DETECT, ...opts };
  const angleTol = (o.angleTolDeg * Math.PI) / 180;
  const sinTol = Math.sin(angleTol);
  // lines are merged across tiny gaps only (real openings are bridged later, on the finished walls)
  const lines = mergeCollinear(segs, angleTol, o.offsetTol, 0.05);

  // bucket by angle so pairing is not O(n²) on big drawings
  const bucketOf = (l: Line) => ((Math.round((Math.atan2(l.uz, l.ux) * 180) / Math.PI) % 180) + 180) % 180;
  const buckets = new Map<number, number[]>();
  lines.forEach((l, i) => { const k = bucketOf(l); (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i); });

  interface Cand { i: number; j: number; d: number; o1: number; o2: number }
  const cands: Cand[] = [];
  for (let i = 0; i < lines.length; i++) {
    const a = lines[i]; const kb = bucketOf(a);
    for (const k of [kb - 1, kb, kb + 1].map((x) => (x + 180) % 180)) {
      for (const j of buckets.get(k) ?? []) {
        if (j <= i) continue;
        const b = lines[j];
        if (Math.abs(a.ux * b.uz - a.uz * b.ux) > sinTol) continue;
        const pa = pt(a, a.t1), pb = pt(b, b.t1);
        const d = (pb[0] - pa[0]) * a.nx + (pb[1] - pa[1]) * a.nz;
        if (Math.abs(d) < o.minThickness || Math.abs(d) > o.maxThickness) continue;
        const bt1 = tOf(a, pt(b, b.t1)), bt2 = tOf(a, pt(b, b.t2));
        const o1 = Math.max(a.t1, Math.min(bt1, bt2)), o2 = Math.min(a.t2, Math.max(bt1, bt2));
        if (o2 - o1 < Math.max(o.minLength, 0.05)) continue;
        cands.push({ i, j, d, o1, o2 });
      }
    }
  }
  cands.sort((p, q) => (q.o2 - q.o1) - (p.o2 - p.o1));

  const walls: DetectedWall[] = [];
  let paired = 0;
  for (const cd of cands) {
    const a = lines[cd.i], b = lines[cd.j];
    const bUsedInA = b.consumed.map(([x, y]) => { const p = tOf(a, pt(b, x)), q = tOf(a, pt(b, y)); return [Math.min(p, q), Math.max(p, q)] as [number, number]; });
    for (const [f1, f2] of freeParts(cd.o1, cd.o2, [...a.consumed, ...bUsedInA])) {
      if (f2 - f1 < o.minLength) continue;
      const half = cd.d / 2;
      const p1: [number, number] = [a.ux * f1 + a.nx * (a.c + half), a.uz * f1 + a.nz * (a.c + half)];
      const p2: [number, number] = [a.ux * f2 + a.nx * (a.c + half), a.uz * f2 + a.nz * (a.c + half)];
      walls.push({ x1: p1[0], z1: p1[1], x2: p2[0], z2: p2[1], thickness: Math.round(Math.abs(cd.d) * 200) / 200, source: "pair" });
      paired++;
      a.consumed.push([f1, f2]);
      const q1 = tOf(b, [a.ux * f1 + a.nx * a.c, a.uz * f1 + a.nz * a.c]), q2 = tOf(b, [a.ux * f2 + a.nx * a.c, a.uz * f2 + a.nz * a.c]);
      b.consumed.push([Math.min(q1, q2), Math.max(q1, q2)]);
    }
  }

  let singles = 0;
  if (o.includeSingleLines) {
    for (const l of lines) {
      for (const [f1, f2] of freeParts(l.t1, l.t2, l.consumed)) {
        if (f2 - f1 < o.minLength) continue;
        const p1 = pt(l, f1), p2 = pt(l, f2);
        walls.push({ x1: p1[0], z1: p1[1], x2: p2[0], z2: p2[1], thickness: o.defaultThickness, source: "single" });
        singles++;
      }
    }
  }

  // bridge openings: collinear walls with the same thickness and a small gap become one wall
  let merged = walls;
  if (o.bridgeGap > 0 && walls.length > 1) {
    const out: DetectedWall[] = [];
    const groups: Array<{ ux: number; uz: number; nx: number; nz: number; c: number; th: number; src: DetectedWall["source"]; iv: Array<[number, number]> }> = [];
    for (const w of walls) {
      const [ux, uz] = canon(w.x2 - w.x1, w.z2 - w.z1);
      const nx = -uz, nz = ux, c = w.x1 * nx + w.z1 * nz;
      let g = groups.find((k) => Math.abs(ux * k.uz - uz * k.ux) <= sinTol && ux * k.ux + uz * k.uz > 0 && Math.abs(c - k.c) <= o.offsetTol * 2 && Math.abs(w.thickness - k.th) < 0.011 && w.source === k.src);
      if (!g) { g = { ux, uz, nx, nz, c, th: w.thickness, src: w.source, iv: [] }; groups.push(g); }
      const a = w.x1 * g.ux + w.z1 * g.uz, b = w.x2 * g.ux + w.z2 * g.uz;
      g.iv.push([Math.min(a, b), Math.max(a, b)]);
    }
    for (const g of groups) {
      g.iv.sort((p, q) => p[0] - q[0]);
      let cur = g.iv[0];
      const flush = () => out.push({
        x1: g.ux * cur[0] + g.nx * g.c, z1: g.uz * cur[0] + g.nz * g.c,
        x2: g.ux * cur[1] + g.nx * g.c, z2: g.uz * cur[1] + g.nz * g.c, thickness: g.th, source: g.src,
      });
      for (let i = 1; i < g.iv.length; i++) {
        if (g.iv[i][0] <= cur[1] + o.bridgeGap) cur = [cur[0], Math.max(cur[1], g.iv[i][1])];
        else { flush(); cur = g.iv[i]; }
      }
      flush();
    }
    merged = out;
  }
  merged = merged.filter((w) => Math.hypot(w.x2 - w.x1, w.z2 - w.z1) >= o.minLength);
  merged = joinCorners(merged);

  const th: Record<string, number> = {};
  for (const w of merged) { const k = w.thickness.toFixed(3); th[k] = (th[k] ?? 0) + 1; }
  return { walls: merged, stats: { inputSegments: segs.length, mergedLines: lines.length, pairedWalls: paired, singleLineWalls: singles, thicknesses: th } };
}

/** Extend / trim wall ends so centre lines meet at corners and T-junctions (walls form a closed, joined layout). */
export function joinCorners(walls: DetectedWall[]): DetectedWall[] {
  const out = walls.map((w) => ({ ...w }));
  for (let i = 0; i < out.length; i++) {
    const w = out[i];
    for (const end of [0, 1] as const) {
      const px = end ? w.x2 : w.x1, pz = end ? w.z2 : w.z1;
      const wl = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
      const wx = (w.x2 - w.x1) / wl, wz = (w.z2 - w.z1) / wl;
      let best: { x: number; z: number; d: number } | null = null;
      for (let j = 0; j < out.length; j++) {
        if (j === i) continue;
        const v = out[j];
        const vl = Math.hypot(v.x2 - v.x1, v.z2 - v.z1);
        const vx = (v.x2 - v.x1) / vl, vz = (v.z2 - v.z1) / vl;
        const den = wx * vz - wz * vx;
        if (Math.abs(den) < 0.3) continue; // (near-)parallel: no corner
        // intersection of the two infinite centre lines: P = w1 + a*w, a = ((v1-w1) x v) / (w x v)
        const rx = v.x1 - w.x1, rz = v.z1 - w.z1;
        const a = (rx * vz - rz * vx) / den;
        const b = (rx * wz - rz * wx) / den; // distance along v from v1
        const reach = Math.max(w.thickness, v.thickness) * 1.5 + 0.05;
        if (b < -v.thickness / 2 - 0.05 || b > vl + v.thickness / 2 + 0.05) continue;
        const ix = w.x1 + wx * a, iz = w.z1 + wz * a;
        const d = Math.hypot(ix - px, iz - pz);
        if (d > reach) continue;
        // the intersection must be on the outer side of this end (extension) or just inside it (trim)
        if (!best || d < best.d) best = { x: ix, z: iz, d };
      }
      if (best) { if (end) { w.x2 = best.x; w.z2 = best.z; } else { w.x1 = best.x; w.z1 = best.z; } }
    }
  }
  return out.filter((w) => Math.hypot(w.x2 - w.x1, w.z2 - w.z1) > 1e-6);
}
