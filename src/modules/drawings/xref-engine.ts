/**
 * XREF engine (Phase 2): external drawing references kept SEPARATE from the host drawing database.
 * The host document never receives the reference's entities; `composeXrefs` derives a read-only, transformed
 * entity list for display/plot. Pure (no DOM, no I/O): files are fetched through a caller-supplied loader.
 */
import type { DxfDocument, DxfEntity, DxfPoint, DxfUnits } from "./dxf-types";
import { entityBBox } from "../cad-viewer/viewer-math";
import { rotateEnt, scaleEnt, translateEnt } from "../cad-viewer/modify-math";
import { flattenInserts } from "./block-refs";

export type XrefKind = "attach" | "overlay";
export type XrefStatus = "loaded" | "unloaded" | "missing" | "cycle" | "error";
export type PathMode = "absolute" | "relative" | "none";

export interface XrefRef {
  id: string;
  name: string;
  kind: XrefKind;
  /** Path as stored in the host (what a save/reload uses). */
  path: string;
  status: XrefStatus;
  message?: string;
  insertion: DxfPoint;
  /** Uniform user scale on top of the unit conversion. */
  scale: number;
  rotation: number;
  /** Entity-level clip polygon in host coordinates (entities whose box misses it are hidden). */
  clip?: DxfPoint[];
  hiddenLayers: string[];
  /** Nested references this reference itself attaches (not overlays), by id of this store. */
  nested: string[];
  parent?: string;
  attachedAt: number;
}

export type XrefLoader = (resolvedPath: string) => Promise<DxfDocument | null> | DxfDocument | null;

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

/** Multiplier from the reference's units to the host's units; 1 when either is unknown/unitless. */
export function unitConversion(from: DxfUnits | undefined, to: DxfUnits | undefined): number {
  const a = from ? UNIT_MM[from] : undefined, b = to ? UNIT_MM[to] : undefined;
  return a && b ? a / b : 1;
}

/* ── paths ── */
const norm = (p: string): string => {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") { if (parts.length && parts[parts.length - 1] !== "..") parts.pop(); else parts.push(".."); } else parts.push(seg);
  }
  return parts.join("/");
};
const isAbs = (p: string): boolean => /^([a-zA-Z]:)?[\\/]/.test(p);
const driveOf = (p: string): string => (/^[a-zA-Z]:/.test(p) ? p.slice(0, 2).toLowerCase() : "");
const dirOf = (p: string): string => { const n = p.replace(/\\/g, "/"); const i = n.lastIndexOf("/"); return i < 0 ? "" : n.slice(0, i); };

export function pathMode(p: string): PathMode { return !p ? "none" : isAbs(p) ? "absolute" : "relative"; }

/** Resolve a stored path against the directory of the host drawing. */
export function resolvePath(stored: string, hostPath: string): string {
  if (isAbs(stored)) return (driveOf(stored) ? driveOf(stored) : "") + "/" + norm(stored.replace(/^[a-zA-Z]:/, ""));
  const base = hostPath.replace(/\\/g, "/");
  const drive = driveOf(base);
  const d = dirOf(base.replace(/^[a-zA-Z]:/, ""));
  return drive + "/" + norm(`${d}/${stored}`);
}

/** Express an absolute path relative to the host directory ("../refs/a.dxf"); keeps it absolute across drives. */
export function toRelativePath(absPath: string, hostPath: string): string {
  const a = absPath.replace(/\\/g, "/"), h = hostPath.replace(/\\/g, "/");
  if (driveOf(a) !== driveOf(h)) return absPath;
  const A = norm(a.replace(/^[a-zA-Z]:/, "")).split("/"), H = norm(dirOf(h.replace(/^[a-zA-Z]:/, ""))).split("/").filter(Boolean);
  let i = 0;
  while (i < H.length && i < A.length - 1 && A[i] === H[i]) i++;
  return [...H.slice(i).map(() => ".."), ...A.slice(i)].join("/");
}

/* ── store ── */
export class XrefStore {
  readonly refs = new Map<string, XrefRef>();
  /** Loaded reference drawings. Never merged into the host document. */
  private readonly docs = new Map<string, DxfDocument>();
  private seq = 0;
  constructor(public hostPath: string, private readonly load: XrefLoader, private readonly clock: () => number = () => Date.now()) {}

  /** Forget every reference (a different drawing was opened). */
  clear(): void { this.refs.clear(); this.docs.clear(); }
  docOf(id: string): DxfDocument | undefined { return this.docs.get(id); }
  list(): XrefRef[] { return [...this.refs.values()]; }
  byName(name: string): XrefRef | undefined { return this.list().find((r) => r.name.toLowerCase() === name.toLowerCase()); }

  private uniqueName(want: string): string {
    let n = want, k = 1;
    while (this.byName(n)) n = `${want}$${k++}`;
    return n;
  }

  /** ATTACH / OVERLAY. Nested attachments of the reference are attached too; overlays inside it are not. */
  async attach(path: string, opt: { kind?: XrefKind; name?: string; insertion?: DxfPoint; scale?: number; rotation?: number; hostUnits?: DxfUnits } = {}): Promise<XrefRef> {
    return this.attachInner(path, opt, undefined, [resolvePath(path, this.hostPath).toLowerCase()]);
  }

  private async attachInner(path: string, opt: { kind?: XrefKind; name?: string; insertion?: DxfPoint; scale?: number; rotation?: number }, parent: XrefRef | undefined, chain: string[]): Promise<XrefRef> {
    const kind = opt.kind ?? "attach";
    const base = (opt.name ?? path.replace(/\\/g, "/").split("/").pop()!.replace(/\.(dwg|dxf)$/i, "")) || "xref";
    const ref: XrefRef = {
      id: `x${++this.seq}`, name: this.uniqueName(base), kind, path, status: "unloaded",
      insertion: opt.insertion ?? { x: 0, y: 0 }, scale: opt.scale ?? 1, rotation: opt.rotation ?? 0,
      hiddenLayers: [], nested: [], parent: parent?.id, attachedAt: this.clock(),
    };
    this.refs.set(ref.id, ref);
    parent?.nested.push(ref.id);
    await this.fill(ref, chain);
    return ref;
  }

  private async fill(ref: XrefRef, chain: string[]): Promise<void> {
    const resolved = resolvePath(ref.path, this.hostPath);
    let doc: DxfDocument | null = null;
    try { doc = await this.load(resolved); } catch (e) { ref.status = "error"; ref.message = (e as Error).message; return; }
    if (!doc) { ref.status = "missing"; ref.message = `File not found: ${resolved}`; return; }
    this.docs.set(ref.id, doc);
    ref.status = "loaded"; ref.message = undefined;
    // Nested ATTACH references declared by the reference drawing.
    for (const decl of doc.xrefs ?? []) {
      if (decl.kind === "overlay") continue; // overlays are not propagated through attachments
      const childResolved = resolvePath(decl.path, resolved).toLowerCase();
      if (chain.includes(childResolved)) {
        const c = await this.attachInner(decl.path, { name: decl.name }, ref, chain);
        this.docs.delete(c.id); c.status = "cycle"; c.message = `Circular reference: ${[...chain, childResolved].join(" → ")}`;
        continue;
      }
      // Nested paths resolve against the directory of the referencing drawing.
      const child = await this.attachInner(toRelativePath(resolvePath(decl.path, resolved), this.hostPath), { name: decl.name }, ref, [...chain, childResolved]);
      void child;
    }
  }

  /** DETACH: remove the reference and everything it brought in. Returns the removed ids. */
  detach(id: string): string[] {
    const r = this.refs.get(id);
    if (!r) return [];
    const removed: string[] = [];
    for (const c of [...r.nested]) removed.push(...this.detach(c));
    this.refs.delete(id); this.docs.delete(id); removed.push(id);
    const p = r.parent ? this.refs.get(r.parent) : undefined;
    if (p) p.nested = p.nested.filter((x) => x !== id);
    return removed;
  }

  /** UNLOAD: keep the definition (path, placement) but drop the geometry from memory. */
  unload(id: string): void {
    const r = this.refs.get(id);
    if (!r) return;
    for (const c of r.nested) this.unload(c);
    this.docs.delete(id); r.status = "unloaded";
  }

  /** RELOAD: read the file again (also resolves a previously missing reference). */
  async reload(id: string): Promise<XrefRef | undefined> {
    const r = this.refs.get(id);
    if (!r) return undefined;
    for (const c of [...r.nested]) this.detach(c);
    r.nested = [];
    this.docs.delete(id);
    await this.fill(r, [resolvePath(r.path, this.hostPath).toLowerCase()]);
    return r;
  }

  /** Repoint a missing/moved reference (FIND/repath), optionally storing it relative to the host. */
  async repath(id: string, newPath: string, mode: PathMode = "none"): Promise<XrefRef | undefined> {
    const r = this.refs.get(id);
    if (!r) return undefined;
    const abs = resolvePath(newPath, this.hostPath);
    r.path = mode === "relative" ? toRelativePath(abs, this.hostPath) : mode === "absolute" ? abs : newPath;
    return this.reload(id);
  }

  /** Switch how a stored path is saved without changing what it points to. */
  convertPath(id: string, mode: Exclude<PathMode, "none">): void {
    const r = this.refs.get(id);
    if (!r) return;
    const abs = resolvePath(r.path, this.hostPath);
    r.path = mode === "relative" ? toRelativePath(abs, this.hostPath) : abs;
  }

  /** Status report (what XREF > Manager would show). */
  report(): { name: string; kind: XrefKind; status: XrefStatus; path: string; resolved: string; entities: number; nestedLevel: number; message?: string }[] {
    const level = (r: XrefRef): number => (r.parent && this.refs.get(r.parent) ? 1 + level(this.refs.get(r.parent)!) : 0);
    return this.list().map((r) => ({
      name: r.name, kind: r.kind, status: r.status, path: r.path, resolved: resolvePath(r.path, this.hostPath),
      entities: this.docs.get(r.id)?.entities.length ?? 0, nestedLevel: level(r), ...(r.message ? { message: r.message } : {}),
    }));
  }
}

/* ── composition (read-only view) ── */
const inPoly = (p: DxfPoint, poly: DxfPoint[]): boolean => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
};
const boxHitsPoly = (b: { minX: number; minY: number; maxX: number; maxY: number }, poly: DxfPoint[]): boolean => {
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  if (b.maxX < Math.min(...xs) || b.minX > Math.max(...xs) || b.maxY < Math.min(...ys) || b.minY > Math.max(...ys)) return false;
  const corners = [{ x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.maxX, y: b.maxY }, { x: b.minX, y: b.maxY }];
  if (corners.some((c) => inPoly(c, poly))) return true;
  if (poly.some((p) => p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY)) return true;
  // Box edges crossing polygon edges (box spans the polygon without containing a vertex).
  const cross = (a: DxfPoint, b2: DxfPoint, c: DxfPoint, d: DxfPoint): boolean => {
    const o = (p: DxfPoint, q: DxfPoint, r: DxfPoint): number => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    return o(a, b2, c) * o(a, b2, d) < 0 && o(c, d, a) * o(c, d, b2) < 0;
  };
  for (let i = 0; i < 4; i++) for (let j = 0; j < poly.length; j++) if (cross(corners[i]!, corners[(i + 1) % 4]!, poly[j]!, poly[(j + 1) % poly.length]!)) return true;
  return false;
};

export interface ComposedXref { ref: XrefRef; entities: DxfEntity[]; hidden: number; clipped: number }

/**
 * Derive the display geometry of every loaded reference: unit conversion, user scale, rotation, insertion,
 * layer visibility and clip. Layer names carry the reference prefix (`name|layer`). The host document and the
 * reference documents are not modified.
 */
export function composeXrefs(store: XrefStore, host: Pick<DxfDocument, "units">): ComposedXref[] {
  const out: ComposedXref[] = [];
  const place = (ref: XrefRef, parentXf: ((e: DxfEntity) => DxfEntity) | null): void => {
    const doc = store.docOf(ref.id);
    if (!doc) return;
    const k = unitConversion(doc.units, host.units) * ref.scale;
    const own = (e: DxfEntity): DxfEntity => {
      let r = k !== 1 ? scaleEnt(e, 0, 0, k) : e;
      if (ref.rotation) r = rotateEnt(r, 0, 0, ref.rotation);
      return translateEnt(r, ref.insertion.x, ref.insertion.y);
    };
    const xf = parentXf ? (e: DxfEntity) => parentXf(own(e)) : own;
    const flat = flattenInserts(doc).entities;
    const hiddenSet = new Set(ref.hiddenLayers.map((l) => l.toLowerCase()));
    const ents: DxfEntity[] = [];
    let hidden = 0, clipped = 0;
    for (const e of flat) {
      if (hiddenSet.has(e.layer.toLowerCase())) { hidden++; continue; }
      const t = xf(e);
      if (ref.clip && ref.clip.length >= 3 && !boxHitsPoly(entityBBox(t), ref.clip)) { clipped++; continue; }
      ents.push({ ...t, layer: `${ref.name}|${e.layer}` });
    }
    out.push({ ref, entities: ents, hidden, clipped });
    for (const c of ref.nested) { const cr = store.refs.get(c); if (cr) place(cr, xf); }
  };
  for (const r of store.list()) if (!r.parent) place(r, null);
  return out;
}

/* ── comparison ── */
export interface XrefDiff {
  layersAdded: string[]; layersRemoved: string[];
  countsBefore: Record<string, number>; countsAfter: Record<string, number>;
  added: number; removed: number; unchanged: number;
}
const sig = (e: DxfEntity): string => JSON.stringify(e, (_k, v) => (typeof v === "number" ? Math.round(v * 1e6) / 1e6 : v));
const counts = (l: DxfEntity[]): Record<string, number> => { const o: Record<string, number> = {}; for (const e of l) o[e.type] = (o[e.type] ?? 0) + 1; return o; };

/** Compare two versions of a reference drawing (e.g. before/after RELOAD): geometry-level, not just counts. */
export function compareXref(before: DxfDocument, after: DxfDocument): XrefDiff {
  const a = flattenInserts(before).entities, b = flattenInserts(after).entities;
  const bag = new Map<string, number>();
  for (const e of a) bag.set(sig(e), (bag.get(sig(e)) ?? 0) + 1);
  let unchanged = 0, added = 0;
  for (const e of b) {
    const s = sig(e), n = bag.get(s) ?? 0;
    if (n > 0) { bag.set(s, n - 1); unchanged++; } else added++;
  }
  let removed = 0; for (const n of bag.values()) removed += n;
  const la = new Set(before.layers.map((l) => l.name)), lb = new Set(after.layers.map((l) => l.name));
  return {
    layersAdded: [...lb].filter((l) => !la.has(l)), layersRemoved: [...la].filter((l) => !lb.has(l)),
    countsBefore: counts(a), countsAfter: counts(b), added, removed, unchanged,
  };
}
