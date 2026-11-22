/**
 * Native BLOCK / INSERT resolution.
 *
 * `DxfDocument.blocks` holds each definition once; an INSERT entity only names it. This module turns a
 * reference into drawable geometry on demand (nested references included) with hard limits, so malformed
 * or hostile files (cycles, runaway nesting, huge MINSERT arrays) cannot hang or exhaust the editor.
 * The same `blocks` table is what the XREF milestone will extend (an xref is a block whose body comes
 * from another file), so there is deliberately no second reference database.
 */
import type { DxfAttrib, DxfBlockDef, DxfDocument, DxfEntity, DxfInsert, DxfPoint } from "./dxf-types";
import { transformEntity, type InsertXform } from "./dxf-geometry";

export type BlockTable = Record<string, DxfBlockDef>;

/** Maximum nesting of block references (matches the reader's historical expansion depth). */
export const MAX_BLOCK_DEPTH = 8;
/** Maximum primitive entities one resolve call may produce. */
export const MAX_RESOLVED_ENTITIES = 250_000;
/** MINSERT arrays are clamped per axis. */
export const MAX_ARRAY_AXIS = 500;

export interface ResolveReport {
  /** Names that could not be resolved: missing blocks, cycles, depth or budget hits. */
  problems: Array<{ block: string; reason: "missing" | "cycle" | "depth" | "budget" }>;
  truncated: boolean;
}

export function findBlock(blocks: BlockTable | undefined, name: string): DxfBlockDef | undefined {
  if (!blocks) return undefined;
  if (Object.prototype.hasOwnProperty.call(blocks, name)) return blocks[name];
  const up = name.toUpperCase();
  for (const k of Object.keys(blocks)) if (k.toUpperCase() === up) return blocks[k];
  return undefined;
}

function xformOf(ins: DxfInsert, blk: DxfBlockDef, col: number, row: number): InsertXform {
  const a = ((ins.rotation ?? 0) * Math.PI) / 180;
  const ox = col * (ins.columnSpacing ?? 0), oy = row * (ins.rowSpacing ?? 0);
  return {
    sx: ins.scale?.x ?? 1, sy: ins.scale?.y ?? 1, sz: ins.scale?.z ?? 1, rot: ins.rotation ?? 0, base: blk.base,
    ins: {
      x: ins.position.x + ox * Math.cos(a) - oy * Math.sin(a),
      y: ins.position.y + ox * Math.sin(a) + oy * Math.cos(a),
      z: ins.position.z ?? 0,
    },
  };
}

function attribToText(a: DxfAttrib, host: DxfInsert): DxfEntity {
  return { type: "TEXT", layer: a.layer ?? host.layer, position: a.position, height: a.height, value: a.value, rotation: a.rotation } as DxfEntity;
}

/**
 * Resolves one reference to primitive entities in the host's coordinate space. Layer "0" inside the block
 * takes the reference's layer (AutoCAD rule); `invisible` propagates. Nested INSERTs are resolved
 * recursively. The result is a fresh array of fresh objects: callers may keep or mutate it.
 */
export function resolveInsert(blocks: BlockTable | undefined, ins: DxfInsert, report?: ResolveReport): DxfEntity[] {
  const out: DxfEntity[] = [];
  const budget = { left: MAX_RESOLVED_ENTITIES };
  const rep = report ?? { problems: [], truncated: false };
  walk(blocks, ins, [], out, budget, rep);
  return out;
}

function walk(blocks: BlockTable | undefined, ins: DxfInsert, stack: string[], out: DxfEntity[], budget: { left: number }, rep: ResolveReport): void {
  const blk = findBlock(blocks, ins.name);
  if (!blk) { rep.problems.push({ block: ins.name, reason: "missing" }); return; }
  const key = blk.name.toUpperCase();
  if (stack.includes(key)) { rep.problems.push({ block: ins.name, reason: "cycle" }); return; }
  if (stack.length >= MAX_BLOCK_DEPTH) { rep.problems.push({ block: ins.name, reason: "depth" }); return; }
  const cols = Math.max(1, Math.min(MAX_ARRAY_AXIS, Math.floor(ins.columns ?? 1) || 1));
  const rows = Math.max(1, Math.min(MAX_ARRAY_AXIS, Math.floor(ins.rows ?? 1) || 1));
  stack.push(key);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (budget.left <= 0) { rep.truncated = true; rep.problems.push({ block: ins.name, reason: "budget" }); stack.pop(); return; }
      const xf = xformOf(ins, blk, c, r);
      for (const child of blk.entities) {
        if (budget.left <= 0) { rep.truncated = true; break; }
        const base: DxfEntity = child.layer === "0" ? ({ ...child, layer: ins.layer } as DxfEntity) : child;
        if (base.type === "INSERT") {
          // Compose: the nested reference is itself placed by this reference's transform.
          const placed = transformInsert(base, xf);
          walk(blocks, placed, stack, out, budget, rep);
          continue;
        }
        for (const t of transformEntity(base, xf)) {
          if (budget.left <= 0) { rep.truncated = true; break; }
          out.push(ins.invisible ? ({ ...t, invisible: true } as DxfEntity) : t);
          budget.left--;
        }
      }
      for (const a of ins.attributes ?? []) {
        if (a.invisible || !a.value) continue;
        if (budget.left <= 0) { rep.truncated = true; break; }
        // Attribute positions are stored in the host space; do not transform them again.
        if (c === 0 && r === 0) { out.push(attribToText(a, ins)); budget.left--; }
      }
      // Constant attribute definitions are part of the block body and render at their definition point.
      {
        for (const d of blk.attdefs) {
          if (!d.constant || d.invisible || !d.defaultValue) continue;
          const t: DxfEntity = { type: "TEXT", layer: d.layer ?? "0", position: d.position, height: d.height, value: d.defaultValue, rotation: d.rotation } as DxfEntity;
          for (const x of transformEntity(t.layer === "0" ? ({ ...t, layer: ins.layer } as DxfEntity) : t, xf)) { out.push(x); budget.left--; }
        }
      }
    }
  }
  stack.pop();
}

/** Applies a placement transform to a nested INSERT (similarity transforms: scale, rotation, mirror, translation). */
function transformInsert(n: DxfInsert, xf: InsertXform): DxfInsert {
  const a = (xf.rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const px = (n.position.x - xf.base.x) * xf.sx, py = (n.position.y - xf.base.y) * xf.sy;
  const pos: DxfPoint = { x: xf.ins.x + px * c - py * s, y: xf.ins.y + px * s + py * c, z: (n.position.z ?? 0) * xf.sz + (xf.ins.z ?? 0) };
  const flip = xf.sx * xf.sy < 0;
  return {
    ...n,
    position: pos,
    // Mirroring (negative scale on one axis) reverses the sense of rotation of the child.
    rotation: (flip ? -(n.rotation ?? 0) : (n.rotation ?? 0)) + xf.rot,
    scale: { x: (n.scale?.x ?? 1) * xf.sx, y: (n.scale?.y ?? 1) * xf.sy, z: (n.scale?.z ?? 1) * xf.sz },
    attributes: n.attributes?.map((a) => ({ ...a })),
  };
}

/** EXPLODE one level: the references' direct children (nested INSERTs stay INSERTs, each placed in host space). */
export function explodeInsert(blocks: BlockTable | undefined, ins: DxfInsert): DxfEntity[] {
  const blk = findBlock(blocks, ins.name);
  if (!blk) return [];
  const cols = Math.max(1, Math.min(MAX_ARRAY_AXIS, Math.floor(ins.columns ?? 1) || 1));
  const rows = Math.max(1, Math.min(MAX_ARRAY_AXIS, Math.floor(ins.rows ?? 1) || 1));
  const out: DxfEntity[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const xf = xformOf(ins, blk, c, r);
      for (const child of blk.entities) {
        if (out.length >= MAX_RESOLVED_ENTITIES) return out;
        const base: DxfEntity = child.layer === "0" ? ({ ...child, layer: ins.layer } as DxfEntity) : child;
        if (base.type === "INSERT") out.push(transformInsert(base, xf));
        else for (const t of transformEntity(base, xf)) out.push(t);
      }
      if (c === 0 && r === 0) for (const a of ins.attributes ?? []) if (!a.invisible && a.value) out.push(attribToText(a, ins));
    }
  }
  return out;
}

/**
 * A copy of the document in which every reference is replaced by its resolved primitives and `blocks` is
 * dropped. For consumers that only understand primitive geometry (exports, queries, IFC, PDF). The input is
 * not modified.
 */
export function flattenInserts(doc: DxfDocument): DxfDocument {
  if (!doc.blocks) return doc;
  const blocks = doc.blocks;
  const flat = (list: DxfEntity[]): DxfEntity[] => {
    const out: DxfEntity[] = [];
    for (const e of list) {
      if (e.type === "INSERT") out.push(...resolveInsert(blocks, e)); else out.push(e);
    }
    return out;
  };
  const { blocks: _drop, ...rest } = doc;
  return {
    ...rest,
    entities: flat(doc.entities),
    layouts: doc.layouts?.map((l) => ({ ...l, entities: flat(l.entities) })),
  };
}

/** Names of blocks that no INSERT (directly or through another block) references: candidates for PURGE. */
export function unusedBlocks(doc: DxfDocument): string[] {
  const blocks = doc.blocks ?? {};
  const used = new Set<string>();
  const stack: DxfEntity[] = [...doc.entities, ...(doc.layouts ?? []).flatMap((l) => l.entities)];
  while (stack.length) {
    const e = stack.pop()!;
    if (e.type !== "INSERT") continue;
    const b = findBlock(blocks, e.name);
    if (!b || used.has(b.name)) continue;
    used.add(b.name);
    for (const c of b.entities) stack.push(c);
  }
  return Object.keys(blocks).filter((n) => !used.has(n) && !n.startsWith("*"));
}

/* ── Binding + cache: lets bbox / pick / snap code (which only receives an entity) resolve a reference ── */

const boundTable = new WeakMap<object, BlockTable>();
const revisions = new WeakMap<object, number>();
const resolveCache = new WeakMap<DxfInsert, { sig: string; rev: number; ents: DxfEntity[] }>();

/** Associates a reference with the block table it resolves against. */
export function bindInsert(ins: DxfInsert, blocks: BlockTable | undefined): void {
  if (blocks) boundTable.set(ins, blocks);
}

/** Binds every reference in the document (model space, layouts and block bodies) to `doc.blocks`. */
export function bindDocumentBlocks(doc: DxfDocument): void {
  const blocks = doc.blocks;
  if (!blocks) return;
  const bind = (list: DxfEntity[]) => { for (const e of list) if (e.type === "INSERT") bindInsert(e, blocks); };
  bind(doc.entities);
  for (const l of doc.layouts ?? []) bind(l.entities);
  for (const b of Object.values(blocks)) bind(b.entities);
}

/** Call after a block definition changed: every cached resolution of this table becomes stale. */
export function touchBlocks(blocks: BlockTable): void {
  revisions.set(blocks, (revisions.get(blocks) ?? 0) + 1);
}

const insertSig = (i: DxfInsert): string =>
  `${i.name}|${i.position.x},${i.position.y},${i.position.z ?? 0}|${i.scale?.x ?? 1},${i.scale?.y ?? 1},${i.scale?.z ?? 1}|${i.rotation ?? 0}|${i.columns ?? 1},${i.rows ?? 1},${i.columnSpacing ?? 0},${i.rowSpacing ?? 0}|${i.layer}|${i.invisible ? 1 : 0}|${(i.attributes ?? []).map((a) => `${a.tag}=${a.value}@${a.position.x},${a.position.y}`).join(";")}`;

/**
 * Resolved geometry of a bound reference, cached until the reference or its block table changes.
 * An unbound reference resolves to nothing (callers fall back to the insertion point).
 */
export function resolvedOf(ins: DxfInsert): DxfEntity[] {
  const table = blocksOf(ins);
  if (!table) return [];
  const rev = revisions.get(table) ?? 0;
  const sig = insertSig(ins);
  const hit = resolveCache.get(ins);
  if (hit && hit.sig === sig && hit.rev === rev) return hit.ents;
  const ents = resolveInsert(table, ins);
  resolveCache.set(ins, { sig, rev, ents });
  return ents;
}

let activeTable: BlockTable | undefined;
/**
 * The block table of the drawing currently shown. A reference that was copied, moved or pasted is a new object
 * that was never bound, so it falls back to this table instead of silently resolving to nothing.
 */
export function setActiveBlocks(blocks: BlockTable | undefined): void {
  activeTable = blocks;
}

export function blocksOf(ins: DxfInsert): BlockTable | undefined {
  return boundTable.get(ins) ?? activeTable;
}
