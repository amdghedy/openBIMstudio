/**
 * Block definitions for the CAD editor (BLOCK / INSERT / WBLOCK).
 * Pure: no DOM, no storage. The editor model has no block-reference entity,
 * so inserting a block places ordinary, editable copies (like INSERT followed
 * by EXPLODE in AutoCAD). A library keeps the definitions so a symbol can be
 * placed again and again.
 */
import type { DxfDocument, DxfEntity, DxfLayer, DxfPoint } from "./dxf-types";
import { translateEnt, rotateEnt, scaleEnt } from "../cad-viewer/modify-math";

export interface BlockDef {
  name: string;
  /** Insertion base point in the coordinates the entities were drawn in. */
  base: { x: number; y: number };
  entities: DxfEntity[];
  /** Layer definitions the entities use, so inserting elsewhere keeps colours. */
  layers: DxfLayer[];
  description?: string;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** AutoCAD forbids  < > / \ " : ; ? * | , = `  in names; max 255 chars. Returns an error or null. */
export function validateBlockName(name: string): string | null {
  const n = (name ?? "").trim();
  if (!n) return "Block name cannot be empty.";
  if (n.length > 255) return "Block name is longer than 255 characters.";
  if (/[<>/\\":;?*|,=`]/.test(n)) return 'Block names cannot contain < > / \\ " : ; ? * | , = `';
  if (n.startsWith("*")) return "Names starting with * are reserved for anonymous blocks.";
  return null;
}

export function makeBlock(
  name: string,
  entities: DxfEntity[],
  base: { x: number; y: number },
  allLayers: DxfLayer[] = [],
  description?: string,
): BlockDef {
  const err = validateBlockName(name);
  if (err) throw new Error(err);
  if (!entities.length) throw new Error("Select at least one object to define a block.");
  const used = new Set(entities.map((e) => e.layer));
  return {
    name: name.trim(),
    base: { x: base.x, y: base.y },
    entities: clone(entities),
    layers: clone(allLayers.filter((l) => used.has(l.name))),
    ...(description ? { description } : {}),
  };
}

export interface InsertOptions {
  /** Uniform scale factor (> 0). */
  scale?: number;
  /** Rotation in degrees, counter-clockwise. */
  rotation?: number;
  /** Put every object on this layer instead of its own. */
  layer?: string;
}

/** Copies of the block's objects with the base point at `at`. */
export function instantiateBlock(def: BlockDef, at: DxfPoint, opts: InsertOptions = {}): DxfEntity[] {
  const k = opts.scale ?? 1;
  if (!(k > 0) || !Number.isFinite(k)) throw new Error("Scale must be a positive number.");
  const rot = opts.rotation ?? 0;
  return def.entities.map((src) => {
    let e: DxfEntity = clone(src);
    e = translateEnt(e, -def.base.x, -def.base.y);
    if (k !== 1) e = scaleEnt(e, 0, 0, k);
    if (rot) e = rotateEnt(e, 0, 0, rot);
    e = translateEnt(e, at.x, at.y);
    if (opts.layer) e = { ...e, layer: opts.layer };
    return e;
  });
}

/** WBLOCK: a standalone drawing whose origin is the block's base point. */
export function blockToDocument(def: BlockDef, units: DxfDocument["units"] = "mm"): DxfDocument {
  const layers: DxfLayer[] = def.layers.length ? clone(def.layers) : [{ name: "0", color: 7 }];
  if (!layers.some((l) => l.name === "0")) layers.unshift({ name: "0", color: 7 });
  return {
    units,
    layers,
    entities: def.entities.map((e) => translateEnt(clone(e), -def.base.x, -def.base.y)),
    linetypes: {},
    sourceFormat: "cad-engine",
  } as DxfDocument;
}

/** Bounding size of the block (for listings). Uses points the entity types expose. */
export function blockExtent(def: BlockDef): { w: number; h: number } | null {
  const xs: number[] = [], ys: number[] = [];
  const add = (p?: DxfPoint) => { if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { xs.push(p.x); ys.push(p.y); } };
  for (const e of def.entities) {
    const a = e as any;
    add(a.start); add(a.end); add(a.position);
    if (a.center && a.radius) { xs.push(a.center.x - a.radius, a.center.x + a.radius); ys.push(a.center.y - a.radius, a.center.y + a.radius); }
    else add(a.center);
    for (const p of a.points ?? []) add(p);
  }
  if (!xs.length) return null;
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
}

/** Named collection with JSON persistence helpers (storage itself is the caller's job). */
export class BlockLibrary {
  private defs = new Map<string, BlockDef>();

  names(): string[] { return [...this.defs.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })); }
  get(name: string): BlockDef | undefined { return this.defs.get(this.key(name)); }
  has(name: string): boolean { return this.defs.has(this.key(name)); }
  get size(): number { return this.defs.size; }

  /** Names are case-insensitive like AutoCAD. Throws when the name is taken unless `replace`. */
  add(def: BlockDef, replace = false): void {
    const err = validateBlockName(def.name);
    if (err) throw new Error(err);
    if (this.has(def.name) && !replace) throw new Error(`A block named "${def.name}" already exists.`);
    if (replace) this.defs.delete(this.key(def.name));
    this.defs.set(this.key(def.name), def);
  }
  remove(name: string): boolean { return this.defs.delete(this.key(name)); }
  rename(from: string, to: string): void {
    const d = this.get(from);
    if (!d) throw new Error(`No block named "${from}".`);
    const err = validateBlockName(to);
    if (err) throw new Error(err);
    if (this.key(from) !== this.key(to) && this.has(to)) throw new Error(`A block named "${to}" already exists.`);
    this.defs.delete(this.key(from));
    this.defs.set(this.key(to), { ...d, name: to.trim() });
  }

  toJSON(): BlockDef[] { return [...this.defs.values()]; }
  /** Rebuild from untrusted JSON: bad records are skipped, never thrown. Returns how many were dropped. */
  static fromJSON(raw: unknown): { lib: BlockLibrary; skipped: number } {
    const lib = new BlockLibrary();
    let skipped = 0;
    if (!Array.isArray(raw)) return { lib, skipped: raw == null ? 0 : 1 };
    for (const r of raw as any[]) {
      const ok = r && typeof r.name === "string" && !validateBlockName(r.name) &&
        r.base && Number.isFinite(r.base.x) && Number.isFinite(r.base.y) &&
        Array.isArray(r.entities) && r.entities.length > 0 && Array.isArray(r.layers ?? []);
      if (!ok) { skipped++; continue; }
      lib.defs.set(lib.key(r.name), {
        name: r.name.trim(), base: { x: r.base.x, y: r.base.y },
        entities: r.entities, layers: r.layers ?? [],
        ...(typeof r.description === "string" ? { description: r.description } : {}),
      });
    }
    return { lib, skipped };
  }
  private key(n: string): string { return (n ?? "").trim().toLowerCase(); }
}
