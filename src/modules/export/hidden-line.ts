/**
 * Hidden-line projection: the current 3D view as 2D lines.
 *
 * Triangles are rasterised into a depth buffer; feature edges (boundary, crease > creaseDeg, silhouette) are sampled
 * along their projection and split into visible and hidden runs. Pure logic, no DOM or three.js.
 *
 * Limits (reported by the caller): triangles/edges with an end behind the near plane are dropped rather than clipped;
 * visibility is decided per pixel sample, so lines are accurate to about one pixel of the chosen resolution; curved
 * surfaces show only their silhouette and creases, not tessellation edges below creaseDeg.
 */
import type { MeshInput } from "./model-to-dxf3d";

export interface HlrCamera {
  /** Column-major world→camera matrix (three.js matrixWorldInverse.elements). */
  view: ArrayLike<number>;
  /** Column-major projection matrix (three.js projectionMatrix.elements). */
  proj: ArrayLike<number>;
  /** Perspective cameras: distance from the eye to the model, in metres, to size the drawing. Ignored for orthographic. */
  distance?: number;
}
export interface HlrOptions { width?: number; creaseDeg?: number; includeHidden?: boolean; unitsScale?: number }
export interface HlrSegment { x1: number; y1: number; x2: number; y2: number; layer: string }
export interface HlrResult { visible: HlrSegment[]; hidden: HlrSegment[]; stats: { triangles: number; edges: number; droppedNearPlane: number; width: number; height: number; perspective: boolean } }

const mul = (m: ArrayLike<number>, x: number, y: number, z: number) => [
  m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14], m[3] * x + m[7] * y + m[11] * z + m[15],
];

export function hiddenLineProject(meshes: MeshInput[], cam: HlrCamera, opts: HlrOptions = {}): HlrResult {
  const W = Math.max(200, Math.min(3000, Math.floor(opts.width ?? 1400)));
  const aspect = cam.proj[5] / cam.proj[0];
  const H = Math.max(1, Math.round(W / aspect));
  const persp = Math.abs(cam.proj[11]) > 0.5; // three: perspective has proj[11] = -1
  const unitsPerNdcY = (persp ? (cam.distance ?? 10) : 1) / cam.proj[5] * (opts.unitsScale ?? 1);
  const crease = Math.cos(((opts.creaseDeg ?? 30) * Math.PI) / 180);

  interface Tri { a: number; b: number; c: number; nx: number; ny: number; nz: number; layer: string }
  const V: number[] = []; // world xyz
  const tris: Tri[] = [];
  const keyToV = new Map<string, number>();
  const vertex = (x: number, y: number, z: number) => {
    const k = Math.round(x * 1e4) + "," + Math.round(y * 1e4) + "," + Math.round(z * 1e4);
    let i = keyToV.get(k);
    if (i === undefined) { i = V.length / 3; V.push(x, y, z); keyToV.set(k, i); }
    return i;
  };
  for (const m of meshes) {
    const P = m.positions, I = m.index, mat = m.matrix && m.matrix.length >= 16 ? m.matrix : null;
    const nV = Math.floor(P.length / 3), nT = I ? Math.floor(I.length / 3) : Math.floor(nV / 3);
    const loc: number[] = new Array(nV);
    for (let i = 0; i < nV; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      const w = mat ? [mat[0] * x + mat[4] * y + mat[8] * z + mat[12], mat[1] * x + mat[5] * y + mat[9] * z + mat[13], mat[2] * x + mat[6] * y + mat[10] * z + mat[14]] : [x, y, z];
      loc[i] = vertex(w[0], w[1], w[2]);
    }
    for (let t = 0; t < nT; t++) {
      const a = I ? I[t * 3] : t * 3, b = I ? I[t * 3 + 1] : t * 3 + 1, c = I ? I[t * 3 + 2] : t * 3 + 2;
      if (!(a >= 0 && b >= 0 && c >= 0 && a < nV && b < nV && c < nV)) continue;
      const ia = loc[a], ib = loc[b], ic = loc[c];
      if (ia === ib || ib === ic || ia === ic) continue;
      const ux = V[ib * 3] - V[ia * 3], uy = V[ib * 3 + 1] - V[ia * 3 + 1], uz = V[ib * 3 + 2] - V[ia * 3 + 2];
      const vx = V[ic * 3] - V[ia * 3], vy = V[ic * 3 + 1] - V[ia * 3 + 1], vz = V[ic * 3 + 2] - V[ia * 3 + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-12) continue;
      tris.push({ a: ia, b: ib, c: ic, nx: nx / len, ny: ny / len, nz: nz / len, layer: m.layer });
    }
  }

  // Project every vertex: screen x,y in pixels, depth = view distance, valid = in front of the near plane.
  const nVert = V.length / 3;
  const SX = new Float64Array(nVert), SY = new Float64Array(nVert), SD = new Float64Array(nVert), SW = new Float64Array(nVert), OK = new Uint8Array(nVert);
  const NDX = new Float64Array(nVert), NDY = new Float64Array(nVert);
  for (let i = 0; i < nVert; i++) {
    const v = mul(cam.view, V[i * 3], V[i * 3 + 1], V[i * 3 + 2]);
    const c = mul(cam.proj, v[0], v[1], v[2]);
    const w = c[3];
    const depth = -v[2];
    if (depth <= 1e-4 || !(Math.abs(w) > 1e-9)) continue;
    const nx = c[0] / w, ny = c[1] / w;
    NDX[i] = nx; NDY[i] = ny;
    SX[i] = (nx * 0.5 + 0.5) * W; SY[i] = (1 - (ny * 0.5 + 0.5)) * H; SD[i] = depth; SW[i] = w; OK[i] = 1;
  }

  // Depth buffer (nearest view distance), perspective-correct via 1/depth interpolation.
  const buf = new Float32Array(W * H).fill(Infinity);
  let dropped = 0, drawn = 0;
  for (const t of tris) {
    if (!OK[t.a] || !OK[t.b] || !OK[t.c]) { dropped++; continue; }
    drawn++;
    const x0 = SX[t.a], y0 = SY[t.a], x1 = SX[t.b], y1 = SY[t.b], x2 = SX[t.c], y2 = SY[t.c];
    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2))), maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2))), maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
    const den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2);
    if (Math.abs(den) < 1e-9) continue;
    const i0 = 1 / SD[t.a], i1 = 1 / SD[t.b], i2 = 1 / SD[t.c];
    for (let py = minY; py <= maxY; py++) for (let px = minX; px <= maxX; px++) {
      const sx = px + 0.5, sy = py + 0.5;
      const l0 = ((y1 - y2) * (sx - x2) + (x2 - x1) * (sy - y2)) / den;
      const l1 = ((y2 - y0) * (sx - x2) + (x0 - x2) * (sy - y2)) / den;
      const l2 = 1 - l0 - l1;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      const d = 1 / (l0 * i0 + l1 * i1 + l2 * i2);
      const k = py * W + px;
      if (d < buf[k]) buf[k] = d;
    }
  }

  // Feature edges.
  interface EdgeInfo { a: number; b: number; t0: number; t1: number; layer: string; n: number }
  const edges = new Map<string, EdgeInfo>();
  const camPos = (() => { // world-space eye from the view matrix (inverse of rigid transform)
    const m = cam.view; return [-(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]), -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]), -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14])];
  })();
  const viewDir = [-cam.view[2], -cam.view[6], -cam.view[10]]; // world direction the camera looks along
  const frontFacing = (t: Tri): boolean => {
    if (persp) { const cx = (V[t.a * 3] + V[t.b * 3] + V[t.c * 3]) / 3, cy = (V[t.a * 3 + 1] + V[t.b * 3 + 1] + V[t.c * 3 + 1]) / 3, cz = (V[t.a * 3 + 2] + V[t.b * 3 + 2] + V[t.c * 3 + 2]) / 3; return t.nx * (camPos[0] - cx) + t.ny * (camPos[1] - cy) + t.nz * (camPos[2] - cz) > 0; }
    return t.nx * viewDir[0] + t.ny * viewDir[1] + t.nz * viewDir[2] < 0;
  };
  tris.forEach((t, ti) => {
    const pairs: Array<[number, number]> = [[t.a, t.b], [t.b, t.c], [t.c, t.a]];
    for (const [p, q] of pairs) {
      const key = p < q ? p + ":" + q : q + ":" + p;
      const e = edges.get(key);
      if (!e) edges.set(key, { a: p, b: q, t0: ti, t1: -1, layer: t.layer, n: 1 });
      else { e.t1 = ti; e.n++; }
    }
  });
  const visible: HlrSegment[] = [], hidden: HlrSegment[] = [];
  const toDraw = (nx: number, ny: number) => [nx * unitsPerNdcY * aspect, ny * unitsPerNdcY];
  let edgeCount = 0;
  const bufAt = (px: number, py: number) => {
    let m = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = px + dx, y = py + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const v = buf[y * W + x]; if (v < m) m = v;
    }
    return m;
  };
  for (const e of edges.values()) {
    const t0 = tris[e.t0];
    let feature = false;
    if (e.n !== 2) feature = true;
    else {
      const t1 = tris[e.t1];
      const dot = t0.nx * t1.nx + t0.ny * t1.ny + t0.nz * t1.nz;
      feature = dot < crease || frontFacing(t0) !== frontFacing(t1);
    }
    if (!feature) continue;
    if (!OK[e.a] || !OK[e.b]) continue;
    edgeCount++;
    const ax = SX[e.a], ay = SY[e.a], bx = SX[e.b], by = SY[e.b];
    const px = bx - ax, py = by - ay, plen = Math.hypot(px, py);
    const steps = Math.max(1, Math.ceil(plen / 1.5));
    const ia = 1 / SD[e.a], ib = 1 / SD[e.b];
    let runStart = 0, runVis = true;
    const emit = (s0: number, s1: number, vis: boolean) => {
      if (s1 <= s0) return;
      const n0x = NDX[e.a] + (NDX[e.b] - NDX[e.a]) * s0, n0y = NDY[e.a] + (NDY[e.b] - NDY[e.a]) * s0;
      const n1x = NDX[e.a] + (NDX[e.b] - NDX[e.a]) * s1, n1y = NDY[e.a] + (NDY[e.b] - NDY[e.a]) * s1;
      // NDC is affine in screen space, so s is the same parameter for both.
      const [x1, y1] = toDraw(n0x, n0y), [x2, y2] = toDraw(n1x, n1y);
      (vis ? visible : hidden).push({ x1, y1, x2, y2, layer: e.layer });
    };
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const sx = ax + px * u, sy = ay + py * u;
      const d = 1 / (ia + (ib - ia) * u);
      const b = bufAt(Math.floor(sx), Math.floor(sy));
      const vis = d <= b * 1.004 + 0.002;
      if (s === 0) { runVis = vis; runStart = 0; continue; }
      if (vis !== runVis) { emit(runStart / steps, (s - 0.5) / steps, runVis); runStart = (s - 0.5) / steps; runVis = vis; }
    }
    emit(runStart, 1, runVis);
  }
  const keepHidden = opts.includeHidden ? hidden : [];
  return { visible, hidden: keepHidden, stats: { triangles: drawn, edges: edgeCount, droppedNearPlane: dropped, width: W, height: H, perspective: persp } };
}

/** DXF R12 with LINE entities: visible edges on `<layer>`, hidden edges on `<layer>-HIDDEN` (dashed, grey). X/Y are the view plane; units mm or m. */
export function hlrToDxf(res: HlrResult): { dxf: string; lines: number; layers: string[] } {
  const out: string[] = [];
  const w = (c: number, v: string | number) => out.push(String(c), String(v));
  const fmt = (v: number) => (Math.abs(v) < 1e-9 ? "0" : String(Math.round(v * 1e4) / 1e4));
  const used = new Set<string>();
  const ents: string[] = [];
  const add = (s: HlrSegment, name: string) => {
    if (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) < 1e-6) return;
    used.add(name);
    ents.push(["0", "LINE", "8", name, "10", fmt(s.x1), "20", fmt(s.y1), "30", "0", "11", fmt(s.x2), "21", fmt(s.y2), "31", "0"].join("\n"));
  };
  for (const s of res.visible) add(s, s.layer);
  for (const s of res.hidden) add(s, s.layer + "-HIDDEN");
  w(0, "SECTION"); w(2, "HEADER"); w(9, "$ACADVER"); w(1, "AC1009"); w(0, "ENDSEC");
  w(0, "SECTION"); w(2, "TABLES");
  w(0, "TABLE"); w(2, "LTYPE"); w(70, 2);
  w(0, "LTYPE"); w(2, "CONTINUOUS"); w(70, 0); w(3, "Solid line"); w(72, 65); w(73, 0); w(40, 0);
  w(0, "LTYPE"); w(2, "DASHED"); w(70, 0); w(3, "Dashed"); w(72, 65); w(73, 2); w(40, 0.75); w(49, 0.5); w(49, -0.25);
  w(0, "ENDTAB");
  const layers = Array.from(used).sort();
  w(0, "TABLE"); w(2, "LAYER"); w(70, layers.length + 1);
  const row = (name: string, color: number, lt: string) => { w(0, "LAYER"); w(2, name); w(70, 0); w(62, color); w(6, lt); };
  row("0", 7, "CONTINUOUS");
  for (const l of layers) row(l, l.endsWith("-HIDDEN") ? 8 : 7, l.endsWith("-HIDDEN") ? "DASHED" : "CONTINUOUS");
  w(0, "ENDTAB"); w(0, "ENDSEC");
  w(0, "SECTION"); w(2, "ENTITIES");
  return { dxf: out.join("\n") + "\n" + (ents.length ? ents.join("\n") + "\n" : "") + "0\nENDSEC\n0\nEOF\n", lines: ents.length, layers };
}
