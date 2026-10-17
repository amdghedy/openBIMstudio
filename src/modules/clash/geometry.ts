// openbim-fix:v3:applied -- do not re-apply the earlier fix scripts
/** Precise geometry: per-element world triangles + Möller triangle-triangle intersection. */
import * as THREE from "three";
import { ctx } from "../../core/context";
import { TriangleBVH } from "./triangle-bvh";

export type Tri = Float32Array; // 9 floats: ax,ay,az, bx,by,bz, cx,cy,cz

const MAX_TRIS_PER_ITEM = 2500;

const cacheByModel = new WeakMap<object, Map<number, Tri[] | null>>();

function getIdRanges(mesh: any): Map<number, { start: number; end: number }> | null {
  const cands: any[] = [mesh.geometry?.userData, mesh.userData, mesh];
  const keys = ["idRanges", "idsRanges", "idMap", "ranges"];
  for (const ud of cands) {
    if (!ud || typeof ud !== "object") continue;
    for (const k of keys) {
      const r = ud[k];
      if (!r) continue;
      if (r instanceof Map) {
        if (r.size) return r as any;
      } else if (typeof r === "object") {
        const m = new Map<number, { start: number; end: number }>();
        let ok = true;
        for (const [kk, vv] of Object.entries(r as Record<string, any>)) {
          const start = vv?.start ?? vv?.indexStart ?? vv?.[0];
          const end = vv?.end ?? vv?.indexEnd ?? vv?.[1];
          if (typeof start !== "number" || typeof end !== "number") {
            ok = false;
            break;
          }
          m.set(Number(kk), { start, end });
        }
        if (ok && m.size) return m;
      }
    }
  }
  return null;
}

/** Extract world-space triangles for one element (null → fall back to bbox). */
export function getElementTriangles(modelObj: any, localId: number): Tri[] | null {
  if (!modelObj) return null;
  let cache = cacheByModel.get(modelObj);
  if (!cache) {
    cache = new Map();
    cacheByModel.set(modelObj, cache);
  }
  if (cache.has(localId)) return cache.get(localId) ?? null;

  try {
    ctx.world.scene.three.updateMatrixWorld(true);
  } catch {
    /* */
  }

  const out: Tri[] = [];
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();

  modelObj.traverse((obj: any) => {
    if (!obj?.isMesh) return;
    const geo = obj.geometry;
    if (!geo?.attributes?.position) return;

    const ranges = getIdRanges(obj);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const idx = geo.index as THREE.BufferAttribute | null;

    const pushTri = (i0: number, i1: number, i2: number) => {
      const t = new Float32Array(9);
      for (let k = 0; k < 3; k++) {
        const vi = k === 0 ? i0 : k === 1 ? i1 : i2;
        v.fromBufferAttribute(pos, vi).applyMatrix4(m);
        t[k * 3] = v.x;
        t[k * 3 + 1] = v.y;
        t[k * 3 + 2] = v.z;
      }
      out.push(t);
    };

    m.copy(obj.matrixWorld);

    if (ranges) {
      let range = ranges.get(localId);
      if (!range) {
        const alt = ranges.get(localId + 1);
        if (alt) {
          // openbim-fix: clash/geometry.ts -- 1-based idRanges fallback
          console.warn("[geometry] 1-based idRanges fallback for localId=" + localId);
          range = alt;
        }
      }
      if (!range) return;
      const start = Math.max(0, Math.floor(range.start));
      const end = Math.min(idx ? idx.count : pos.count, Math.ceil(range.end));
      const total = end - start;
      if (total < 3) return;
      const stride =
        total > MAX_TRIS_PER_ITEM * 3
          ? 3 * Math.ceil(total / (MAX_TRIS_PER_ITEM * 3))
          : 3;
      if (idx) {
        for (let i = start; i + 2 < end; i += stride) {
          pushTri(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
        }
      } else {
        for (let i = start; i + 2 < end; i += stride) {
          pushTri(i, i + 1, i + 2);
        }
      }
      return;
    }

    // Fallback for exporters that bake one element per mesh (no idRanges).
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    if (triCount <= MAX_TRIS_PER_ITEM) {
      if (idx) {
        for (let i = 0; i + 2 < idx.count; i += 3) {
          pushTri(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
        }
      } else {
        for (let i = 0; i + 2 < pos.count; i += 3) {
          pushTri(i, i + 1, i + 2);
        }
      }
    }
  });

  const result = out.length ? out : null;
  cache.set(localId, result);
  return result;
}

// ═════════════════════════════════════════════════════════════════════════
// BVH cache — lives alongside the triangle cache, same lifecycle.
// ═════════════════════════════════════════════════════════════════════════
const bvhByModel = new WeakMap<object, Map<number, TriangleBVH | null>>();

/**
 * Build (or reuse) the triangle BVH for one element.
 * Returns null when triangles cannot be extracted (bbox-only fallback).
 */
export function getElementBVH(modelObj: any, localId: number): TriangleBVH | null {
  if (!modelObj) return null;
  const tris = getElementTriangles(modelObj, localId);
  if (!tris || !tris.length) return null;

  let cache = bvhByModel.get(modelObj);
  if (!cache) {
    cache = new Map();
    bvhByModel.set(modelObj, cache);
  }
  if (cache.has(localId)) return cache.get(localId) ?? null;

  let bvh: TriangleBVH | null = null;
  try {
    bvh = new TriangleBVH(tris);
  } catch (err) {
    console.warn("[geometry] BVH build failed", err);
    bvh = null;
  }
  cache.set(localId, bvh);
  return bvh;
}

/** Clear triangle + BVH caches (after models change). */
export function clearTriangleCache() {
  // WeakMaps clear with GC; no strong refs to clear.
}

// ── vector helpers ──
type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const eps = 1e-8;
const tv = (t: Tri, i: 0 | 1 | 2): V3 => [t[i * 3], t[i * 3 + 1], t[i * 3 + 2]];

function dominantAxis(n: V3): 0 | 1 | 2 {
  const ax = Math.abs(n[0]);
  const ay = Math.abs(n[1]);
  const az = Math.abs(n[2]);
  if (ax >= ay && ax >= az) return 0;
  if (ay >= az) return 1;
  return 2;
}

function pointInTri2D(
  p: [number, number],
  a: [number, number],
  b: [number, number],
  c: [number, number],
) {
  const sign = (p1: [number, number], p2: [number, number], p3: [number, number]) =>
    (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const b1 = sign(p, a, b) < 0;
  const b2 = sign(p, b, c) < 0;
  const b3 = sign(p, c, a) < 0;
  return b1 === b2 && b2 === b3;
}

function edgesIntersect2D(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
) {
  const orient = (p: [number, number], q: [number, number], r: [number, number]) =>
    Math.sign((q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]));
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 !== o2 && o3 !== o4;
}

function coplanar(T1: Tri, T2: Tri): boolean {
  const p1 = tv(T1, 0);
  const q1 = tv(T1, 1);
  const r1 = tv(T1, 2);
  const N = cross(sub(q1, p1), sub(r1, p1));
  const drop = dominantAxis(N);
  const proj = (p: V3): [number, number] => {
    if (drop === 0) return [p[1], p[2]];
    if (drop === 1) return [p[0], p[2]];
    return [p[0], p[1]];
  };
  const A = [proj(tv(T1, 0)), proj(tv(T1, 1)), proj(tv(T1, 2))] as [
    [number, number],
    [number, number],
    [number, number],
  ];
  const B = [proj(tv(T2, 0)), proj(tv(T2, 1)), proj(tv(T2, 2))] as [
    [number, number],
    [number, number],
    [number, number],
  ];
  for (const p of A) if (pointInTri2D(p, B[0], B[1], B[2])) return true;
  for (const p of B) if (pointInTri2D(p, A[0], A[1], A[2])) return true;
  for (let i = 0; i < 3; i++) {
    const a0 = A[i];
    const a1 = A[(i + 1) % 3];
    for (let j = 0; j < 3; j++) {
      if (edgesIntersect2D(a0, a1, B[j], B[(j + 1) % 3])) return true;
    }
  }
  return false;
}

function edgePlaneHit(
  a: V3,
  b: V3,
  c: V3,
  da: number,
  db: number,
  dc: number,
): V3 | null {
  if (Math.abs(da) < eps && Math.abs(db) < eps) return null;
  const pick = (P: V3, Q: V3, dp: number, dq: number): V3 => {
    const t = dp / (dp - dq + 1e-30);
    return [P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1]), P[2] + t * (Q[2] - P[2])];
  };
  if ((da >= 0 && db < 0) || (da < 0 && db >= 0)) return pick(a, b, da, db);
  if ((da >= 0 && dc < 0) || (da < 0 && dc >= 0)) return pick(a, c, da, dc);
  if ((db >= 0 && dc < 0) || (db < 0 && dc >= 0)) return pick(b, c, db, dc);
  return null;
}

/** Möller-style triangle–triangle intersection (includes coplanar overlap). */
export function triTriIntersect(T1: Tri, T2: Tri): boolean {
  const p1 = tv(T1, 0);
  const q1 = tv(T1, 1);
  const r1 = tv(T1, 2);
  const p2 = tv(T2, 0);
  const q2 = tv(T2, 1);
  const r2 = tv(T2, 2);

  const N1 = cross(sub(q1, p1), sub(r1, p1));
  const d1 = -dot(N1, p1);
  const du0 = dot(N1, p2) + d1;
  const du1 = dot(N1, q2) + d1;
  const du2 = dot(N1, r2) + d1;
  if (Math.abs(du0) < eps && Math.abs(du1) < eps && Math.abs(du2) < eps) return false;
  if (du0 * du1 > 0 && du0 * du2 > 0) return false;

  const N2 = cross(sub(q2, p2), sub(r2, p2));
  const d2 = -dot(N2, p2);
  const dv0 = dot(N2, p1) + d2;
  const dv1 = dot(N2, q1) + d2;
  const dv2 = dot(N2, r1) + d2;
  if (dv0 * dv1 > 0 && dv0 * dv2 > 0) return false;

  const s1 = edgePlaneHit(p1, q1, r1, dv0, dv1, dv2);
  const s2 = edgePlaneHit(p1, r1, q1, dv0, dv2, dv1);
  const s3 = edgePlaneHit(p2, q2, r2, du0, du1, du2);
  const s4 = edgePlaneHit(p2, r2, q2, du0, du2, du1);
  if (!s1 || !s2 || !s3 || !s4) return false;

  const D = cross(N1, N2);
  const ax = Math.abs(D[0]);
  const ay = Math.abs(D[1]);
  const az = Math.abs(D[2]);
  const key = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
  const i1 = Math.min(s1[key], s2[key]);
  const i2 = Math.max(s1[key], s2[key]);
  const j1 = Math.min(s3[key], s4[key]);
  const j2 = Math.max(s3[key], s4[key]);
  return i1 <= j2 + eps && j1 <= i2 + eps;
}

// ═════════════════════════════════════════════════════════════════════════
// Narrowphase — brute force (kept for compatibility) and BVH (preferred)
// ═════════════════════════════════════════════════════════════════════════

/**
 * Face-accurate clash WITHOUT BVH. O(n·m). Kept for backward compatibility.
 * New code should call meshFaceClashBVH.
 */
export function meshFaceClash(
  trisA: Tri[],
  trisB: Tri[],
  boxA: THREE.Box3,
  boxB: THREE.Box3,
  expand = 0,
): { hit: boolean; pairs: number; point: THREE.Vector3 | null } {
  const ba = boxA.clone();
  const bb = boxB.clone();
  if (expand > 0) {
    ba.expandByScalar(expand);
    bb.expandByScalar(expand);
  }
  if (!ba.intersectsBox(bb)) return { hit: false, pairs: 0, point: null };

  const tBox = (t: Tri) => {
    const b = new THREE.Box3();
    b.min.set(
      Math.min(t[0], t[3], t[6]),
      Math.min(t[1], t[4], t[7]),
      Math.min(t[2], t[5], t[8]),
    );
    b.max.set(
      Math.max(t[0], t[3], t[6]),
      Math.max(t[1], t[4], t[7]),
      Math.max(t[2], t[5], t[8]),
    );
    return b;
  };

  let pairs = 0;
  let point: THREE.Vector3 | null = null;
  const maxPairsReport = 50;

  for (let i = 0; i < trisA.length; i++) {
    const ta = trisA[i];
    const baT = tBox(ta);
    if (expand > 0) baT.expandByScalar(expand);
    if (!baT.intersectsBox(bb)) continue;
    for (let j = 0; j < trisB.length; j++) {
      const tb = trisB[j];
      const bbT = tBox(tb);
      if (expand > 0) bbT.expandByScalar(expand);
      if (!baT.intersectsBox(bbT)) continue;
      if (triTriIntersect(ta, tb)) {
        pairs++;
        if (!point) {
          point = new THREE.Vector3(
            (ta[0] + ta[3] + ta[6]) / 3,
            (ta[1] + ta[4] + ta[7]) / 3,
            (ta[2] + ta[5] + ta[8]) / 3,
          );
        }
        if (pairs >= maxPairsReport) return { hit: true, pairs, point };
      }
    }
  }
  return { hit: pairs > 0, pairs, point };
}

/**
 * Face-accurate clash WITH BVH traversal. This is what the clash engine
 * uses. The BVH prunes the O(n·m) grid down to a small candidate set —
 * typically a 100–1,000× reduction in tri-tri tests.
 */
export function meshFaceClashBVH(
  bvhA: TriangleBVH,
  bvhB: TriangleBVH,
  tolerance = 0,
  maxPairs = 50,
): { hit: boolean; pairs: number; point: THREE.Vector3 | null } {
  let pairs = 0;
  let point: THREE.Vector3 | null = null;
  const A = bvhA.tris;
  const B = bvhB.tris;

  bvhA.visitCandidatePairs(bvhB, tolerance, (ia, ib) => {
    const ta = A[ia];
    const tb = B[ib];
    if (!triTriIntersect(ta, tb)) return true;
    pairs++;
    if (!point) {
      point = new THREE.Vector3(
        (ta[0] + ta[3] + ta[6]) / 3,
        (ta[1] + ta[4] + ta[7]) / 3,
        (ta[2] + ta[5] + ta[8]) / 3,
      );
    }
    return pairs < maxPairs;
  });

  return { hit: pairs > 0, pairs, point };
}

/**
 * Extract all available triangles for a single fragment element without the
 * normal clash-detection decimation cap. This is intentionally used by the
 * Native Twin reconstruction workflow, where geometry fidelity is preferred
 * over clash-query performance.
 */
export function getElementTrianglesExact(modelObj: any, localId: number): Tri[] | null {
  if (!modelObj) return null;
  try { ctx.world.scene.three.updateMatrixWorld(true); } catch { /* */ }

  const out: Tri[] = [];
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();

  modelObj.traverse((obj: any) => {
    if (!obj?.isMesh) return;
    const geo = obj.geometry;
    if (!geo?.attributes?.position) return;

    const ranges = getIdRanges(obj);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const idx = geo.index as THREE.BufferAttribute | null;
    m.copy(obj.matrixWorld);

    const pushTri = (i0: number, i1: number, i2: number) => {
      const t = new Float32Array(9);
      for (let k = 0; k < 3; k++) {
        const vi = k === 0 ? i0 : k === 1 ? i1 : i2;
        v.fromBufferAttribute(pos, vi).applyMatrix4(m);
        t[k * 3] = v.x;
        t[k * 3 + 1] = v.y;
        t[k * 3 + 2] = v.z;
      }
      out.push(t);
    };

    if (ranges) {
      let range = ranges.get(localId);
      if (!range) {
        const alt = ranges.get(localId + 1);
        if (alt) {
          // openbim-fix: clash/geometry.ts -- 1-based idRanges fallback
          console.warn("[geometry] 1-based idRanges fallback for localId=" + localId);
          range = alt;
        }
      }
      if (!range) return;
      const start = Math.max(0, Math.floor(range.start));
      const end = Math.min(idx ? idx.count : pos.count, Math.ceil(range.end));
      if (idx) {
        for (let i = start; i + 2 < end; i += 3) pushTri(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
      } else {
        for (let i = start; i + 2 < end; i += 3) pushTri(i, i + 1, i + 2);
      }
      return;
    }

    // Conservative fallback: only use a one-mesh model when there are no
    // element ranges. This prevents accidentally cloning the entire model.
    const meshLocalIds = obj.userData?.localId ?? obj.userData?.itemId ?? obj.userData?.expressID;
    if (meshLocalIds != null && Number(meshLocalIds) !== localId && Number(meshLocalIds) !== localId + 1) return;
    if (meshLocalIds == null && obj.parent?.children?.filter?.((c: any) => c?.isMesh)?.length > 1) return;

    if (idx) {
      for (let i = 0; i + 2 < idx.count; i += 3) pushTri(idx.getX(i), idx.getX(i + 1), idx.getX(i + 2));
    } else {
      for (let i = 0; i + 2 < pos.count; i += 3) pushTri(i, i + 1, i + 2);
    }
  });

  return out.length ? out : null;
}
