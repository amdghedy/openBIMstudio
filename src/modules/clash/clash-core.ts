/**
 * Pure clash math — geometry only, no I/O, no DOM, no Fragments.
 *
 * Imported by both the main-thread engine and the Web Worker.
 * Must not reference `ctx`, `window`, `document`, or Fragments runtime types.
 */
import * as THREE from "three";
import { PointCloudConvex, gjk } from "./gjk";
import { meshFaceClash, meshFaceClashBVH, type Tri } from "./geometry";
import { TriangleBVH } from "./triangle-bvh";
import { meshInsideMesh, triTriDistance } from "./mesh-queries";
import { SpatialHash } from "../../core/spatial-hash";

/* ── Public types (serializable) ─────────────────────────────────────── */
export type ClashKind = "intersect" | "touching" | "clearance" | "duplicate";

export type ClashPrecision =
  | "triangles" | "bbox" | "hull" | "sphere" | "center" | "duplicate" | "depth";

export type ClashMethod =
  | "hard-triangle" | "hard-conservative" | "convex-gjk" | "sphere"
  | "center-in-volume" | "clearance" | "duplicates" | "penetration-depth";

export interface ClashRules {
  tolerance: number;
  clearance: number;
  lowerBound: number;
  minVolume: number;
  ignoreIdentical: boolean;
  ignoreSameCategory: boolean;
}

export const DEFAULT_CLASH_RULES: ClashRules = {
  tolerance: 0.005,
  clearance: 0,
  lowerBound: 0,
  minVolume: 1e-6,
  ignoreIdentical: false,
  ignoreSameCategory: false,
};

export interface ClashItemRef {
  modelId: string;
  localId: number;
  name: string;
  cat: string;
}

export interface ElementClash {
  a: ClashItemRef;
  b: ClashItemRef;
  kind: ClashKind;
  method: ClashMethod;
  precision: ClashPrecision;
  depthVol: number;
  triPairs: number;
  minGap: number;
  boxA: THREE.Box3;
  boxB: THREE.Box3;
  point: THREE.Vector3 | null;
  /** True when one element lies entirely inside the other (surfaces never cross). */
  contained?: boolean;
}

export interface ClashCoreItem {
  modelId: string;
  localId: number;
  name: string;
  category: string;
  box: THREE.Box3;
  /** Optional pre-extracted triangles (world space, 9 floats per tri). */
  tris?: Tri[] | null;
}

export interface ClashProgress {
  phase: "broadphase" | "narrowphase" | "done";
  current: number;
  total: number;
  found: number;
}

export interface ClashCoreOptions {
  rules: ClashRules;
  method: ClashMethod;
  /** Pre-partitioned groups of item indices to test. */
  groups: number[][];
  /** When true, also test every item against the other items in its own group. */
  selfPairs: boolean;
  /**
   * Optional per-item side flags (1 = selection A, 2 = selection B, 3 = both), same length as the items.
   * When given, ONLY A-vs-B pairs are tested (works inside one model, across models and for linked
   * models alike) and `groups` / `selfPairs` are ignored.
   */
  sides?: number[];
  onProgress?: (p: ClashProgress) => void;
  shouldCancel?: () => boolean;
  yieldEvery?: number;
  yield?: () => Promise<void>;
}

export interface ClashMethodInfo {
  id: ClashMethod;
  label: string;
  description: string;
  usesTolerance: boolean;
  usesClearance: boolean;
}

export const CLASH_METHODS: ClashMethodInfo[] = [
  { id: "hard-triangle",     label: "Hard · Triangle (most accurate)", description: "True triangle-triangle intersection with BVH acceleration.", usesTolerance: true,  usesClearance: false },
  { id: "hard-conservative", label: "Hard · Conservative (bbox)",       description: "Bounding-box intersection. Fast, over-reports.",              usesTolerance: true,  usesClearance: false },
  { id: "convex-gjk",        label: "Convex Hull (GJK)",                description: "Convex hull tested with GJK distance.",                       usesTolerance: true,  usesClearance: false },
  { id: "sphere",            label: "Bounding Sphere (fastest)",        description: "Sphere-vs-sphere. Instantaneous, heavily over-reports.",      usesTolerance: true,  usesClearance: false },
  { id: "center-in-volume",  label: "Center in Volume",                 description: "One AABB centre inside the other AABB.",                      usesTolerance: false, usesClearance: false },
  { id: "clearance",         label: "Clearance Band",                   description: "Close but not intersecting, within the clearance band.",      usesTolerance: false, usesClearance: true  },
  { id: "duplicates",        label: "Duplicates",                       description: "Identical bounding boxes within tolerance.",                  usesTolerance: true,  usesClearance: false },
  { id: "penetration-depth", label: "Penetration Depth",                description: "Overlap whose thinnest axis exceeds tolerance.",              usesTolerance: true,  usesClearance: false },
];

/* ── Scratch ─────────────────────────────────────────────────────────── */
const _inter = new THREE.Box3();
const _isize = new THREE.Vector3();
const _expanded = new THREE.Box3();
const _centerA = new THREE.Vector3();
const _centerB = new THREE.Vector3();

interface RuntimeItem extends ClashCoreItem {
  tris: Tri[] | null;
  bvh: TriangleBVH | null;
  hull: PointCloudConvex | null;
}

export function boxDistance(a: THREE.Box3, b: THREE.Box3): number {
  if (a.intersectsBox(b)) return 0;
  const dx = Math.max(0, Math.max(a.min.x - b.max.x, b.min.x - a.max.x));
  const dy = Math.max(0, Math.max(a.min.y - b.max.y, b.min.y - a.max.y));
  const dz = Math.max(0, Math.max(a.min.z - b.max.z, b.min.z - a.max.z));
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function overlapVolume(a: THREE.Box3, b: THREE.Box3): number {
  if (!a.intersectsBox(b)) return 0;
  _inter.copy(a).intersect(b);
  if (_inter.isEmpty()) return 0;
  _inter.getSize(_isize);
  return Math.max(0, _isize.x * _isize.y * _isize.z);
}

function ensureBVH(it: RuntimeItem): void {
  if (it.bvh !== null) return;
  if (!it.tris || !it.tris.length) return;
  try { it.bvh = new TriangleBVH(it.tris); }
  catch { it.bvh = null; }
}

function ensureHull(it: RuntimeItem): void {
  if (it.hull !== null) return;
  if (!it.tris || !it.tris.length) return;
  try { it.hull = PointCloudConvex.fromTriangles(it.tris); }
  catch { it.hull = null; }
}

interface DetectionResult {
  kind: ClashKind | null;
  precision: ClashPrecision;
  triPairs: number;
  minGap: number;
  depthVol: number;
  point: THREE.Vector3 | null;
  contained?: boolean;
}

function boxInside(inner: THREE.Box3, outer: THREE.Box3, eps: number): boolean {
  return inner.min.x >= outer.min.x - eps && inner.min.y >= outer.min.y - eps && inner.min.z >= outer.min.z - eps &&
    inner.max.x <= outer.max.x + eps && inner.max.y <= outer.max.y + eps && inner.max.z <= outer.max.z + eps;
}

/** True when any triangle of A is within `tol` of any triangle of B (exact distance, not box distance). */
function meshesWithin(ea: RuntimeItem, eb: RuntimeItem, tol: number): boolean {
  if (!ea.bvh || !eb.bvh) return false;
  let hit = false;
  const A = ea.bvh.tris, B = eb.bvh.tris;
  ea.bvh.visitCandidatePairs(eb.bvh, tol, (i, j) => {
    if (triTriDistance(A[i], B[j]) <= tol) { hit = true; return false; }
    return true;
  });
  return hit;
}

function detectPair(
  ea: RuntimeItem,
  eb: RuntimeItem,
  method: ClashMethod,
  rules: ClashRules,
): DetectionResult {
  const tol = Math.max(0, rules.tolerance);
  const clearance = Math.max(0, rules.clearance);
  const minVol = Math.max(0, rules.minVolume);

  const boxGap = boxDistance(ea.box, eb.box);
  const depthVol = overlapVolume(ea.box, eb.box);

  const out: DetectionResult = {
    kind: null, precision: "bbox", triPairs: 0, minGap: boxGap, depthVol, point: null,
  };

  switch (method) {
    case "hard-triangle": {
      if (!ea.tris?.length || !eb.tris?.length) {
        out.precision = "bbox";
        if (depthVol > minVol) out.kind = "intersect";
        else if (boxGap <= tol) out.kind = "touching";
        return out;
      }
      out.precision = "triangles";
      ensureBVH(ea); ensureBVH(eb);
      let usedBVH = false;
      if (ea.bvh && eb.bvh) {
        try {
          const t = meshFaceClashBVH(ea.bvh, eb.bvh, tol);
          out.triPairs = t.pairs; out.point = t.point; usedBVH = true;
        } catch { /* fall through */ }
      }
      if (!usedBVH) {
        try {
          const t = meshFaceClash(ea.tris, eb.tris, ea.box, eb.box, tol);
          out.triPairs = t.pairs; out.point = t.point;
        } catch { /* */ }
      }
      if (out.triPairs > 0) {
        out.minGap = 0;
        // Contact is not a clash: if the boxes overlap by no more than the tolerance along their
        // thinnest axis, neither element can penetrate the other by more than the tolerance.
        let thin = Infinity;
        if (tol > 0 && depthVol >= 0 && ea.box.intersectsBox(eb.box)) {
          _inter.copy(ea.box).intersect(eb.box);
          _inter.getSize(_isize);
          thin = Math.min(_isize.x, _isize.y, _isize.z);
        }
        out.kind = thin <= tol ? "touching" : "intersect";
        return out;
      }
      // Surfaces never cross: either one element is entirely inside the other, or they are apart.
      if (boxGap === 0) {
        const eps = Math.max(tol, 1e-6);
        const aIn = boxInside(ea.box, eb.box, eps) ? meshInsideMesh(ea.tris, eb.tris) : null;
        const bIn = !aIn?.inside && boxInside(eb.box, ea.box, eps) ? meshInsideMesh(eb.tris, ea.tris) : null;
        const hit = aIn?.inside ? aIn : bIn?.inside ? bIn : null;
        if (hit) {
          out.kind = "intersect"; out.minGap = 0; out.contained = true; out.triPairs = 0;
          if (hit.point) out.point = new THREE.Vector3(hit.point[0], hit.point[1], hit.point[2]);
          return out;
        }
      }
      // "Touching" means the real surfaces are within tolerance, not that the boxes overlap.
      if (tol > 0 && boxGap <= tol && meshesWithin(ea, eb, tol)) out.kind = "touching";
      return out;
    }

    case "hard-conservative":
      out.precision = "bbox";
      if (depthVol > minVol) { out.kind = "intersect"; out.triPairs = 1; out.minGap = 0; }
      else if (boxGap <= tol) out.kind = "touching";
      return out;

    case "convex-gjk": {
      ensureHull(ea); ensureHull(eb);
      out.precision = "hull";
      if (ea.hull && eb.hull) {
        try {
          const g = gjk(ea.hull, eb.hull);
          out.minGap = g.intersect ? 0 : g.distance;
          if (g.intersect) { out.kind = "intersect"; out.triPairs = 1; }
          else if (g.distance <= tol) out.kind = "touching";
          return out;
        } catch { /* */ }
      }
      out.precision = "bbox";
      if (depthVol > minVol) { out.kind = "intersect"; out.triPairs = 1; }
      else if (boxGap <= tol) out.kind = "touching";
      return out;
    }

    case "sphere": {
      out.precision = "sphere";
      ea.box.getCenter(_centerA);
      eb.box.getCenter(_centerB);
      const sa = new THREE.Vector3(); ea.box.getSize(sa);
      const sb = new THREE.Vector3(); eb.box.getSize(sb);
      const rA = sa.length() * 0.5;
      const rB = sb.length() * 0.5;
      const centerDist = _centerA.distanceTo(_centerB);
      const sphereGap = centerDist - (rA + rB);
      out.minGap = Math.max(0, sphereGap);
      if (sphereGap <= 0) { out.kind = "intersect"; out.triPairs = 1; }
      else if (sphereGap <= tol) out.kind = "touching";
      return out;
    }

    case "center-in-volume": {
      out.precision = "center";
      ea.box.getCenter(_centerA);
      eb.box.getCenter(_centerB);
      const aInB = eb.box.containsPoint(_centerA);
      const bInA = ea.box.containsPoint(_centerB);
      if (aInB || bInA) {
        out.kind = "intersect"; out.triPairs = 1; out.minGap = 0;
        out.point = (aInB ? _centerA : _centerB).clone();
      }
      return out;
    }

    case "clearance": {
      if (clearance <= 0 && tol <= 0) return out;
      ensureHull(ea); ensureHull(eb);
      let gap = boxGap;
      out.precision = "bbox";
      if (ea.hull && eb.hull) {
        try {
          const g = gjk(ea.hull, eb.hull);
          out.precision = "hull";
          if (g.intersect) {
            out.kind = "intersect"; out.triPairs = 1; out.minGap = 0;
            return out;
          }
          gap = g.distance;
        } catch { /* */ }
      }
      out.minGap = gap;
      if (gap <= tol) out.kind = "touching";
      else if (gap <= clearance) out.kind = "clearance";
      return out;
    }

    case "duplicates": {
      out.precision = "duplicate";
      ea.box.getCenter(_centerA);
      eb.box.getCenter(_centerB);
      const sizeA = new THREE.Vector3(); ea.box.getSize(sizeA);
      const sizeB = new THREE.Vector3(); eb.box.getSize(sizeB);
      const centerDist = _centerA.distanceTo(_centerB);
      const sizeDiff =
        Math.abs(sizeA.x - sizeB.x) +
        Math.abs(sizeA.y - sizeB.y) +
        Math.abs(sizeA.z - sizeB.z);
      const matchTol = Math.max(tol, 0.001);
      if (centerDist <= matchTol && sizeDiff <= matchTol * 3) {
        out.kind = "duplicate"; out.triPairs = 1; out.minGap = 0;
        out.point = _centerA.clone().add(_centerB).multiplyScalar(0.5);
      }
      return out;
    }

    case "penetration-depth": {
      out.precision = "depth";
      if (depthVol <= 0) return out;
      _inter.copy(ea.box).intersect(eb.box);
      _inter.getSize(_isize);
      const depth = Math.min(_isize.x, _isize.y, _isize.z);
      out.triPairs = 1; out.minGap = 0;
      if (depth >= tol) out.kind = "intersect";
      else if (depth > 0) out.kind = "touching";
      return out;
    }
  }
  return out;
}

/* ── Broadphase + narrowphase loop ──────────────────────────────────── */
export async function runClashCore(
  rawItems: ClashCoreItem[],
  opts: ClashCoreOptions,
): Promise<ElementClash[]> {
  const results: ElementClash[] = [];
  const rules = opts.rules;
  const method = opts.method;
  const onProg = opts.onProgress ?? (() => {});
  const shouldCancel = opts.shouldCancel ?? (() => false);
  const yieldEvery = opts.yieldEvery ?? 512;
  const yieldFn = opts.yield ?? (() => Promise.resolve());

  const items: RuntimeItem[] = rawItems.map((it) => ({
    ...it,
    tris: it.tris ?? null,
    bvh: null,
    hull: null,
  }));

  const reach = Math.max(
    Math.max(0, rules.tolerance),
    Math.max(0, rules.clearance),
    method === "sphere" ? 1e9 : 0,
  );

  const cellSize = SpatialHash.suggestCellSize(items.map((it) => it.box));
  const hash = new SpatialHash(cellSize);
  for (const it of items) hash.insert(it.box);

  const groupOf = new Map<number, number>();
  opts.groups.forEach((g, gi) => {
    for (const idx of g) groupOf.set(idx, gi);
  });

  let tested = 0;
  let found = 0;
  const candidates = new Set<number>();
  const seen = new Set<string>();

  let totalEstimate = 0;
  for (const _idx of groupOf.keys()) totalEstimate++;
  onProg({ phase: "broadphase", current: 0, total: totalEstimate, found: 0 });

  const maxItemIdx = items.length;

  for (let ai = 0; ai < maxItemIdx; ai++) {
    if (shouldCancel()) return results;
    const ea = items[ai];
    if (!ea) continue;

    const groupA = opts.sides ? 0 : groupOf.get(ai);
    if (groupA === undefined) continue;

    const maxA = Math.max(
      ea.box.max.x - ea.box.min.x,
      ea.box.max.y - ea.box.min.y,
      ea.box.max.z - ea.box.min.z,
    );
    if (rules.lowerBound > 0 && maxA < rules.lowerBound) continue;

    _expanded.copy(ea.box).expandByScalar(reach);
    hash.query(_expanded, candidates, ai);

    for (const bi of candidates) {
      if (bi <= ai) continue;
      const eb = items[bi];
      if (!eb) continue;

      const groupB = opts.sides ? 0 : groupOf.get(bi);
      if (groupB === undefined) continue;

      if (opts.sides) {
        const fa = opts.sides[ai] ?? 0, fb = opts.sides[bi] ?? 0;
        if (!(((fa & 1) && (fb & 2)) || ((fa & 2) && (fb & 1)))) continue;
      } else {
        const sameGroup = groupA === groupB;
        if (sameGroup && !opts.selfPairs) continue;
      }

      const key = `${ai}:${bi}`;
      if (seen.has(key)) continue;
      seen.add(key);

      tested++;

      if ((tested & (yieldEvery - 1)) === 0) {
        onProg({
          phase: "broadphase",
          current: tested,
          total: Math.min(Math.max(totalEstimate, tested), tested * 2),
          found,
        });
        await yieldFn();
        if (shouldCancel()) return results;
      }

      const maxB = Math.max(
        eb.box.max.x - eb.box.min.x,
        eb.box.max.y - eb.box.min.y,
        eb.box.max.z - eb.box.min.z,
      );
      if (rules.lowerBound > 0 && maxB < rules.lowerBound) continue;

      if (method !== "sphere" && method !== "duplicates") {
        _expanded.copy(ea.box).expandByScalar(reach);
        if (!_expanded.intersectsBox(eb.box)) continue;
      }

      if (rules.ignoreIdentical && ea.name && ea.name === eb.name) continue;
      if (
        rules.ignoreSameCategory &&
        ea.category === eb.category &&
        ea.category !== "Unknown"
      ) continue;

      const d = detectPair(ea, eb, method, rules);
      if (!d.kind) continue;

      found++;
      results.push({
        a: { modelId: ea.modelId, localId: ea.localId, name: ea.name, cat: ea.category },
        b: { modelId: eb.modelId, localId: eb.localId, name: eb.name, cat: eb.category },
        kind: d.kind,
        method,
        precision: d.precision,
        depthVol: d.depthVol,
        triPairs: d.triPairs,
        minGap: d.minGap,
        boxA: ea.box.clone(),
        boxB: eb.box.clone(),
        point: d.point,
        ...(d.contained ? { contained: true } : {}),
      });
    }
  }

  onProg({
    phase: "done",
    current: tested,
    total: tested,
    found: results.length,
  });
  return results;
}
