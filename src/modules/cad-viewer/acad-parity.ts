/**
 * AutoCAD-parity helpers for the 2D engine: groups, STATUS/TIME, OPTIONS,
 * SPELL, XREF attach, LAYOUT create — pure data + small UI helpers.
 */
import type { DxfDocument, DxfEntity, DxfLayer } from "../drawings/dxf-types";

export interface CadGroup {
  name: string;
  /** Entity object references (in-memory). */
  members: Set<DxfEntity>;
}

export interface XrefRecord {
  name: string;
  fileName: string;
  layerPrefix: string;
  entityCount: number;
  attachedAt: number;
}

export interface DrawingClock {
  openedAt: number;
  createdAt: number;
  editedAt: number;
  revision: number;
}

export function createClock(): DrawingClock {
  const now = Date.now();
  return { openedAt: now, createdAt: now, editedAt: now, revision: 1 };
}

export function touchClock(c: DrawingClock): void {
  c.editedAt = Date.now();
  c.revision += 1;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

export function statusReport(
  doc: DxfDocument | null,
  ents: DxfEntity[],
  extra?: { name?: string; hidden?: number; groups?: number; xrefs?: number },
): string {
  if (!doc) return "No drawing loaded.";
  const byType = new Map<string, number>();
  for (const e of ents) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  const types = [...byType.entries()].sort((a, b) => b[1] - a[1]);
  const lines = [
    `Drawing: ${extra?.name ?? "(unnamed)"}`,
    `Units: ${doc.units ?? "mm"}`,
    `Model entities: ${ents.length}`,
    `Layers: ${doc.layers.length}`,
    `Layouts: ${doc.layouts?.length ?? 0}`,
    `Hidden layers: ${extra?.hidden ?? 0}`,
    `Groups: ${extra?.groups ?? 0}`,
    `Xrefs: ${extra?.xrefs ?? 0}`,
    "",
    "By type:",
    ...types.slice(0, 20).map(([t, n]) => `  ${t}: ${n}`),
  ];
  return lines.join("\n");
}

export function timeReport(clock: DrawingClock, name: string): string {
  const now = Date.now();
  return [
    `Drawing: ${name}`,
    `Created (session): ${new Date(clock.createdAt).toLocaleString()}`,
    `Opened: ${new Date(clock.openedAt).toLocaleString()}`,
    `Last edit: ${new Date(clock.editedAt).toLocaleString()}`,
    `Revision (session): ${clock.revision}`,
    `Elapsed this session: ${formatDuration(now - clock.openedAt)}`,
  ].join("\n");
}

/** Minimal English word list for SPELL — common CAD annotation words pass; unknowns flagged. */
const COMMON = new Set(
  `the a an and or of to in on at for with from by is are was were be been being
  mm cm m m2 m3 deg degree degrees north south east west door window wall floor
  ceiling room plan section elevation detail schedule note revision sheet drawing
  project architect engineer scale date client title checked drawn approved
  concrete steel timber glass aluminum aluminium brick plaster paint finish
  length width height depth radius diameter area volume quantity type mark
  level ground floor first second third roof basement parking lobby corridor
  `.split(/\s+/).filter(Boolean),
);

export function spellCheckTexts(ents: DxfEntity[]): Array<{ text: string; word: string; entity: DxfEntity }> {
  const out: Array<{ text: string; word: string; entity: DxfEntity }> = [];
  for (const e of ents) {
    if (e.type !== "TEXT") continue;
    const raw = String((e as any).value ?? "");
    const words = raw.match(/[A-Za-z]{3,}/g) ?? [];
    for (const w of words) {
      if (!COMMON.has(w.toLowerCase()) && w === w.toLowerCase()) {
        // flag lowercase unknowns only (avoid codes like A101)
        out.push({ text: raw, word: w, entity: e });
      }
    }
  }
  return out.slice(0, 100);
}

export function ensureGroup(
  groups: Map<string, CadGroup>,
  name: string,
  members: DxfEntity[],
): CadGroup {
  const key = name.trim() || `G${groups.size + 1}`;
  let g = groups.get(key);
  if (!g) {
    g = { name: key, members: new Set() };
    groups.set(key, g);
  }
  for (const e of members) g.members.add(e);
  return g;
}

export function ungroup(
  groups: Map<string, CadGroup>,
  name?: string,
  members?: DxfEntity[],
): number {
  if (name) {
    const g = groups.get(name);
    if (!g) return 0;
    groups.delete(name);
    return g.members.size;
  }
  if (members?.length) {
    let n = 0;
    for (const g of groups.values()) {
      for (const e of members) {
        if (g.members.delete(e)) n++;
      }
    }
    // drop empty groups
    for (const [k, g] of [...groups.entries()]) {
      if (!g.members.size) groups.delete(k);
    }
    return n;
  }
  return 0;
}

export function selectGroupMembers(groups: Map<string, CadGroup>, name: string): DxfEntity[] {
  const g = groups.get(name);
  return g ? [...g.members] : [];
}

/** Create a new paper layout shell. */
export function addLayout(doc: DxfDocument, name?: string): string {
  if (!doc.layouts) doc.layouts = [];
  let n = name?.trim() || `Layout${doc.layouts.length + 1}`;
  const taken = new Set(doc.layouts.map((l) => l.name.toLowerCase()));
  if (taken.has(n.toLowerCase())) {
    let i = 2;
    while (taken.has(`${n}_${i}`.toLowerCase())) i++;
    n = `${n}_${i}`;
  }
  doc.layouts.push({ name: n, entities: [], viewports: [] });
  return n;
}

export function prefixXrefLayers(
  layers: DxfLayer[],
  entities: DxfEntity[],
  xrefName: string,
): { layers: DxfLayer[]; entities: DxfEntity[] } {
  const prefix = `XREF_${xrefName}|`;
  const layerMap = new Map<string, string>();
  const newLayers: DxfLayer[] = layers.map((l) => {
    const nn = prefix + l.name;
    layerMap.set(l.name, nn);
    return { ...l, name: nn };
  });
  const newEnts = entities.map((e) => ({
    ...e,
    layer: layerMap.get(e.layer) ?? prefix + e.layer,
  }));
  return { layers: newLayers, entities: newEnts };
}

/** Build a double-line (MLINE) as two parallel LINE entities + optional center. */
export function mlinePair(
  a: { x: number; y: number },
  b: { x: number; y: number },
  width: number,
  layer: string,
  props?: Partial<DxfEntity>,
): DxfEntity[] {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);
  const base = { layer, ...(props as object) };
  return [
    { type: "LINE", ...base, start: { x: a.x + nx, y: a.y + ny }, end: { x: b.x + nx, y: b.y + ny } } as DxfEntity,
    { type: "LINE", ...base, start: { x: a.x - nx, y: a.y - ny }, end: { x: b.x - nx, y: b.y - ny } } as DxfEntity,
  ];
}

/** Find/replace in TEXT entities. Returns number of replacements. */
export function replaceText(
  ents: DxfEntity[],
  find: string,
  replace: string,
  opts?: { all?: boolean; caseSensitive?: boolean },
): { count: number; entities: DxfEntity[] } {
  if (!find) return { count: 0, entities: ents };
  const all = opts?.all !== false;
  const cs = !!opts?.caseSensitive;
  let count = 0;
  const out = ents.map((e) => {
    if (e.type !== "TEXT") return e;
    const v = String((e as any).value ?? "");
    const hay = cs ? v : v.toLowerCase();
    const needle = cs ? find : find.toLowerCase();
    if (!hay.includes(needle)) return e;
    const next = cs
      ? (all ? v.split(find).join(replace) : v.replace(find, replace))
      : v.replace(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), all ? "gi" : "i"), replace);
    if (next === v) return e;
    count++;
    return { ...e, value: next } as DxfEntity;
  });
  return { count, entities: out };
}

/** Closed polyline area via shoelace (for REGION report). */
export function polylineArea(pts: Array<{ x: number; y: number }>): number {
  if (pts.length < 3) return 0;
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) * 0.5;
}

export function isClosedPoly(e: DxfEntity): boolean {
  if (e.type !== "LWPOLYLINE") return false;
  const p = e.points;
  if (!p || p.length < 3) return false;
  if ((e as any).closed) return true;
  const a = p[0], b = p[p.length - 1];
  return Math.hypot(a.x - b.x, a.y - b.y) < 1e-6 * (1 + Math.hypot(a.x, a.y));
}
