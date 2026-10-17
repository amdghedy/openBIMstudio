/**
 * Clash grouping via union-find.
 *
 * Two clashes belong to the same group when they share an element
 * (Navisworks-style grouping).
 */
import type { ElementClash, ClashItemRef } from "./clash-core";

class DisjointSet {
  private parent: number[];
  private rank: number[];

  constructor(size: number) {
    this.parent = new Array(size);
    this.rank = new Array(size).fill(0);
    for (let i = 0; i < size; i++) this.parent[i] = i;
  }

  find(x: number): number {
    let root = x;
    while (this.parent[root] !== root) root = this.parent[root];
    let cur = x;
    while (this.parent[cur] !== cur) {
      const next = this.parent[cur];
      this.parent[cur] = root;
      cur = next;
    }
    return root;
  }

  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    if (this.rank[ra] < this.rank[rb]) this.parent[ra] = rb;
    else if (this.rank[ra] > this.rank[rb]) this.parent[rb] = ra;
    else { this.parent[rb] = ra; this.rank[ra]++; }
  }
}

export interface ClashGroup {
  id: string;
  head: ClashItemRef;
  members: ElementClash[];
  kinds: { intersect: number; touching: number; clearance: number; duplicate: number };
  metric: { totalOverlap_m3: number; minGap_m: number };
  worstPrecision: string;
  methods: string[];
}

function elementKey(ref: ClashItemRef): string {
  return `${ref.modelId}::${ref.localId}`;
}

export function groupClashes(
  clashes: readonly ElementClash[],
  opts: { preferLargerHead?: boolean } = {},
): ClashGroup[] {
  const n = clashes.length;
  if (n === 0) return [];

  const ds = new DisjointSet(n);
  const firstSeen = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const c = clashes[i];
    for (const ref of [c.a, c.b]) {
      const k = elementKey(ref);
      const prev = firstSeen.get(k);
      if (prev === undefined) firstSeen.set(k, i);
      else ds.union(prev, i);
    }
  }

  const buckets = new Map<number, ElementClash[]>();
  for (let i = 0; i < n; i++) {
    const root = ds.find(i);
    const arr = buckets.get(root);
    if (arr) arr.push(clashes[i]);
    else buckets.set(root, [clashes[i]]);
  }

  const groups: ClashGroup[] = [];
  for (const members of buckets.values()) {
    groups.push(buildGroup(members, opts));
  }

  groups.sort((a, b) => {
    if (a.kinds.intersect !== b.kinds.intersect) return b.kinds.intersect - a.kinds.intersect;
    if (a.kinds.touching !== b.kinds.touching) return b.kinds.touching - a.kinds.touching;
    return b.metric.totalOverlap_m3 - a.metric.totalOverlap_m3;
  });

  return groups;
}

function buildGroup(
  members: ElementClash[],
  opts: { preferLargerHead?: boolean },
): ClashGroup {
  const counts = new Map<string, { ref: ClashItemRef; count: number }>();
  for (const c of members) {
    for (const ref of [c.a, c.b]) {
      const k = elementKey(ref);
      const e = counts.get(k);
      if (e) e.count++;
      else counts.set(k, { ref, count: 1 });
    }
  }

  let headRef: ClashItemRef | null = null;
  if (opts.preferLargerHead) {
    let bestVol = -Infinity;
    for (const [k, { ref }] of counts) {
      const member = members.find((c) => elementKey(c.a) === k || elementKey(c.b) === k);
      if (!member) continue;
      const box = elementKey(member.a) === k ? member.boxA : member.boxB;
      const size = { x: 0, y: 0, z: 0 };
      try {
        const s = box.getSize({ x: 0, y: 0, z: 0 } as any);
        size.x = s.x; size.y = s.y; size.z = s.z;
      } catch {
        size.x = box.max.x - box.min.x;
        size.y = box.max.y - box.min.y;
        size.z = box.max.z - box.min.z;
      }
      const vol = size.x * size.y * size.z;
      if (vol > bestVol) { bestVol = vol; headRef = ref; }
    }
  } else {
    let best = -1;
    for (const [, { ref, count }] of counts) {
      if (count > best) { best = count; headRef = ref; }
    }
  }
  if (!headRef) headRef = members[0].a;

  const kinds = { intersect: 0, touching: 0, clearance: 0, duplicate: 0 };
  let totalOverlap = 0;
  let minGap = Infinity;
  const methods = new Set<string>();
  const precisionRank: Record<string, number> = {
    triangles: 5, hull: 4, sphere: 3, bbox: 2, depth: 2, center: 1, duplicate: 1,
  };
  let worstPrecision = "bbox";
  let worstRank = -1;

  for (const c of members) {
    kinds[c.kind]++;
    totalOverlap += c.depthVol;
    if (c.kind !== "intersect" && Number.isFinite(c.minGap)) {
      if (c.minGap < minGap) minGap = c.minGap;
    }
    methods.add(c.method);
    const r = precisionRank[c.precision] ?? 0;
    if (r > worstRank) { worstRank = r; worstPrecision = c.precision; }
  }
  if (!Number.isFinite(minGap)) minGap = 0;

  members.sort((a, b) => {
    const order: Record<string, number> = { intersect: 0, touching: 1, clearance: 2, duplicate: 3 };
    const d = (order[a.kind] ?? 9) - (order[b.kind] ?? 9);
    if (d !== 0) return d;
    if (a.kind === "intersect") return b.depthVol - a.depthVol;
    return a.minGap - b.minGap;
  });

  return {
    id: `grp-${elementKey(headRef).replace(/[^a-z0-9]+/gi, "-")}`,
    head: headRef,
    members,
    kinds,
    metric: { totalOverlap_m3: totalOverlap, minGap_m: minGap },
    worstPrecision,
    methods: [...methods],
  };
}

export function flattenGroups(groups: readonly ClashGroup[]): ElementClash[] {
  const out: ElementClash[] = [];
  for (const g of groups) for (const c of g.members) out.push(c);
  return out;
}

export function summarizeGroups(groups: readonly ClashGroup[]): {
  groupCount: number;
  clashCount: number;
  intersectCount: number;
  touchingCount: number;
  clearanceCount: number;
  duplicateCount: number;
  largestGroup: { id: string; size: number } | null;
} {
  let clashCount = 0;
  let intersect = 0, touching = 0, clearance = 0, duplicate = 0;
  let largest: { id: string; size: number } | null = null;
  for (const g of groups) {
    clashCount += g.members.length;
    intersect += g.kinds.intersect;
    touching += g.kinds.touching;
    clearance += g.kinds.clearance;
    duplicate += g.kinds.duplicate;
    if (!largest || g.members.length > largest.size) {
      largest = { id: g.id, size: g.members.length };
    }
  }
  return {
    groupCount: groups.length,
    clashCount,
    intersectCount: intersect,
    touchingCount: touching,
    clearanceCount: clearance,
    duplicateCount: duplicate,
    largestGroup: largest,
  };
}
