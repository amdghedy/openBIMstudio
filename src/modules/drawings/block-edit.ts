/**
 * Editor-native block operations on the canonical DxfDocument: BLOCK, INSERT/MINSERT, EXPLODE, ATTEDIT, WBLOCK,
 * block redefinition and PURGE. Pure functions (no DOM); each returns a result describing the change so the
 * editor can wrap it in one undo step. Definitions live once in `doc.blocks`; references only name them.
 */
import type { DxfAttDef, DxfAttrib, DxfBlockDef, DxfDocument, DxfEntity, DxfInsert, DxfPoint } from "./dxf-types";
import { bindDocumentBlocks, bindInsert, blocksOf, explodeInsert, findBlock, touchBlocks, unusedBlocks } from "./block-refs";
import { translateEnt } from "../cad-viewer/modify-math";

const BAD_NAME = /[<>/\\":;?*|,=`]/;

export function validateBlockName(name: string): string | null {
  const n = name.trim();
  if (!n) return "Block name is empty.";
  if (n.length > 255) return "Block name is longer than 255 characters.";
  if (BAD_NAME.test(n)) return 'Block name contains one of < > / \\ " : ; ? * | , = `';
  if (n.startsWith("*")) return "Names starting with * are reserved for anonymous blocks.";
  return null;
}

function ensureBlocks(doc: DxfDocument): Record<string, DxfBlockDef> {
  if (!doc.blocks) doc.blocks = {};
  return doc.blocks;
}

/** Names of every block that `name` references (directly or through nested blocks), including `name` itself. */
export function blockClosure(blocks: Record<string, DxfBlockDef> | undefined, name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (n: string) => {
    const def = findBlock(blocks, n);
    if (!def || seen.has(def.name)) return;
    seen.add(def.name);
    out.push(def.name);
    for (const e of def.entities) if (e.type === "INSERT") walk(e.name);
  };
  walk(name);
  return out;
}

/** True when placing `child` inside `host` would make a block contain itself. */
export function wouldCycle(blocks: Record<string, DxfBlockDef> | undefined, host: string, child: string): boolean {
  const h = findBlock(blocks, host)?.name ?? host;
  return blockClosure(blocks, child).some((n) => n.toLowerCase() === h.toLowerCase());
}

export interface CreateBlockOptions {
  base: DxfPoint;
  attdefs?: DxfAttDef[];
  description?: string;
  /** Replace an existing definition of the same name (BLOCK "redefine"). */
  overwrite?: boolean;
}

/**
 * BLOCK: store `entities` (already removed from the drawing by the caller) as a definition with the base point
 * moved to the origin of block space. Returns the definition. Throws on invalid / duplicate names or cycles.
 */
export function createBlock(doc: DxfDocument, name: string, entities: DxfEntity[], opt: CreateBlockOptions): DxfBlockDef {
  const bad = validateBlockName(name);
  if (bad) throw new Error(bad);
  const blocks = ensureBlocks(doc);
  const existing = findBlock(blocks, name);
  if (existing && !opt.overwrite) throw new Error(`Block "${existing.name}" already exists.`);
  for (const e of entities) {
    if (e.type === "INSERT" && wouldCycle(blocks, name, e.name)) throw new Error(`Block "${name}" cannot contain a reference to itself ("${e.name}").`);
  }
  const key = existing ? existing.name : name.trim();
  const def: DxfBlockDef = {
    name: key,
    base: { x: 0, y: 0 },
    entities: entities.map((e) => translateEnt(e, -opt.base.x, -opt.base.y)),
    attdefs: (opt.attdefs ?? []).map((a) => ({ ...a, position: { x: a.position.x - opt.base.x, y: a.position.y - opt.base.y } })),
    description: opt.description,
  };
  blocks[key] = def;
  bindDocumentBlocks(doc);
  touchBlocks(blocks);
  return def;
}

export interface InsertOptions {
  scale?: number | { x: number; y: number };
  rotation?: number;
  layer?: string;
  columns?: number;
  rows?: number;
  columnSpacing?: number;
  rowSpacing?: number;
  /** Attribute values by tag (defaults come from the ATTDEFs). */
  values?: Record<string, string>;
}

/** Attribute instances for a new reference: ATTDEF defaults overridden by `values`, placed through the transform. */
function attribsFor(def: DxfBlockDef, pos: DxfPoint, sx: number, sy: number, rotDeg: number, values?: Record<string, string>): DxfAttrib[] {
  const r = (rotDeg * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r);
  const out: DxfAttrib[] = [];
  for (const a of def.attdefs) {
    if (a.constant) continue;
    const lx = (a.position.x - def.base.x) * sx, ly = (a.position.y - def.base.y) * sy;
    const val = values && Object.prototype.hasOwnProperty.call(values, a.tag) ? values[a.tag]! : a.defaultValue;
    out.push({
      tag: a.tag,
      value: val,
      position: { x: pos.x + lx * cs - ly * sn, y: pos.y + lx * sn + ly * cs },
      height: a.height * Math.abs(sy),
      rotation: (a.rotation ?? 0) + rotDeg,
      layer: a.layer,
      invisible: a.invisible,
    });
  }
  return out;
}

/** INSERT / MINSERT: a native reference to an existing definition. The reference is appended by the caller. */
export function makeInsert(doc: DxfDocument, name: string, at: DxfPoint, opt: InsertOptions = {}, host?: string): DxfInsert {
  const def = findBlock(doc.blocks, name);
  if (!def) throw new Error(`Block "${name}" is not defined.`);
  if (host && wouldCycle(doc.blocks, host, def.name)) throw new Error(`Inserting "${def.name}" into "${host}" would create a cycle.`);
  const sc = typeof opt.scale === "number" ? { x: opt.scale, y: opt.scale } : opt.scale ?? { x: 1, y: 1 };
  if (!sc.x || !sc.y || !Number.isFinite(sc.x) || !Number.isFinite(sc.y)) throw new Error("Scale must be non-zero.");
  const rot = opt.rotation ?? 0;
  const ins: DxfInsert = { type: "INSERT", layer: opt.layer ?? "0", name: def.name, position: { ...at } };
  if (sc.x !== 1 || sc.y !== 1) ins.scale = { x: sc.x, y: sc.y };
  if (rot) ins.rotation = rot;
  const cols = Math.max(1, Math.floor(opt.columns ?? 1)), rows = Math.max(1, Math.floor(opt.rows ?? 1));
  if (cols > 1 || rows > 1) {
    ins.columns = cols; ins.rows = rows;
    ins.columnSpacing = opt.columnSpacing ?? 0; ins.rowSpacing = opt.rowSpacing ?? 0;
  }
  const at2 = attribsFor(def, at, sc.x, sc.y, rot, opt.values);
  if (at2.length) ins.attributes = at2;
  if (doc.blocks) bindInsert(ins, doc.blocks);
  return ins;
}

/** EXPLODE selected references in place: each INSERT becomes its one-level children. Returns the new list. */
export function explodeInDoc(doc: DxfDocument, indices: Iterable<number>): { entities: DxfEntity[]; created: number; exploded: number } {
  const pick = new Set(indices);
  const out: DxfEntity[] = [];
  let created = 0, exploded = 0;
  doc.entities.forEach((e, i) => {
    if (pick.has(i) && e.type === "INSERT") {
      const kids = explodeInsert(doc.blocks, e);
      for (const k of kids) if (k.type === "INSERT") bindInsert(k, doc.blocks);
      out.push(...kids);
      created += kids.length; exploded++;
    } else out.push(e);
  });
  return { entities: out, created, exploded };
}

/** ATTEDIT: new reference with the given attribute values (unknown tags are reported, not invented). */
export function atteditInsert(ins: DxfInsert, values: Record<string, string>): { insert: DxfInsert; changed: string[]; unknown: string[] } {
  const attrs = (ins.attributes ?? []).map((a) => ({ ...a }));
  const changed: string[] = [], unknown: string[] = [];
  for (const [tag, value] of Object.entries(values)) {
    const a = attrs.find((x) => x.tag.toLowerCase() === tag.toLowerCase());
    if (!a) { unknown.push(tag); continue; }
    if (a.value !== value) { a.value = value; changed.push(a.tag); }
  }
  const out: DxfInsert = { ...ins, attributes: attrs };
  const t = blocksOf(ins);
  if (t) bindInsert(out, t);
  return { insert: out, changed, unknown };
}

/**
 * WBLOCK: a standalone document containing the given entities (or one block definition) plus every nested
 * block definition they need and the layers they use. The source document is not modified.
 */
export function wblockDocument(doc: DxfDocument, source: { entities: DxfEntity[]; base: DxfPoint } | { block: string }): DxfDocument {
  let ents: DxfEntity[];
  let base: DxfPoint;
  if ("block" in source) {
    const def = findBlock(doc.blocks, source.block);
    if (!def) throw new Error(`Block "${source.block}" is not defined.`);
    ents = def.entities.slice();
    base = def.base;
  } else { ents = source.entities; base = source.base; }
  const needed = new Set<string>();
  for (const e of ents) if (e.type === "INSERT") for (const n of blockClosure(doc.blocks, e.name)) needed.add(n);
  const blocks: Record<string, DxfBlockDef> = {};
  for (const n of needed) { const d = findBlock(doc.blocks, n); if (d) blocks[d.name] = d; }
  const layerNames = new Set<string>();
  const note = (l: DxfEntity[]) => { for (const e of l) layerNames.add(e.layer); };
  note(ents);
  for (const d of Object.values(blocks)) note(d.entities);
  const out: DxfDocument = {
    layers: doc.layers.filter((l) => layerNames.has(l.name) || l.name === "0").map((l) => ({ ...l })),
    entities: ents.map((e) => translateEnt(e, -base.x, -base.y)),
    units: doc.units,
    sourceFormat: "unknown",
    linetypes: doc.linetypes,
    ltscale: doc.ltscale,
    textStyles: doc.textStyles,
  };
  if (Object.keys(blocks).length) out.blocks = blocks;
  bindDocumentBlocks(out);
  return out;
}

/** PURGE unused definitions; returns the removed names. */
export function purgeBlocks(doc: DxfDocument): string[] {
  if (!doc.blocks) return [];
  const names = unusedBlocks(doc);
  for (const n of names) delete doc.blocks[n];
  if (names.length) touchBlocks(doc.blocks);
  return names;
}

/** Re-point existing references after a definition was edited (cache invalidation). */
export function redefineTouched(doc: DxfDocument): void {
  if (doc.blocks) touchBlocks(doc.blocks);
}
