/**
 * BEDIT — the in-place block editor session (AutoCAD 2D parity A9).
 *
 * Unlike REFEDIT (which explodes the definition into the model and rebuilds
 * only the library copy with the base forced to 0,0), BEDIT edits the
 * definition in isolation and redefines the native `doc.blocks` definition
 * with the edited entities and the ORIGINAL base point, so every INSERT
 * reference resolves to the new geometry (resolution is lazy — see
 * block-refs.ts `resolvedOf`, invalidated by `touchBlocks`).
 *
 * Pure: no DOM, no storage. The viewer owns the session swap (it stashes
 * the live entity lists and restores them on close); this module owns the
 * session data itself: opening clones the definition's entities (the live
 * definition is untouched until the session is saved), closing builds the
 * redefined definition from the session's edited entities.
 */
import type { DxfAttDef, DxfBlockDef, DxfEntity, DxfPoint } from "../drawings/dxf-types";
import { validateBlockName } from "../drawings/block-edit";

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export interface BlockEditSession {
  /** Definition name (case-preserved, as stored). */
  name: string;
  /** The definition's original base point — preserved on save, never re-based to 0,0. */
  base: DxfPoint;
  /** Working copy of the definition's entities, in block space. */
  entities: DxfEntity[];
  /** Attribute definitions, carried through unchanged. */
  attdefs: DxfAttDef[];
  description?: string;
}

/** Open a session on a definition: the working copy is a deep clone. */
export function openBlockEditSession(def: DxfBlockDef): BlockEditSession {
  const err = validateBlockName(def.name);
  if (err) throw new Error(err);
  return {
    name: def.name,
    base: { ...def.base },
    entities: clone(def.entities),
    attdefs: clone(def.attdefs ?? []),
    ...(def.description ? { description: def.description } : {}),
  };
}

/**
 * Close a session with its edited entities: the redefined definition.
 * The base point and attribute definitions are the session's originals —
 * the edit only replaces the geometry. Throws when the session holds no
 * entities (a block definition must not be empty).
 */
export function closeBlockEditSession(session: BlockEditSession, entities: DxfEntity[]): DxfBlockDef {
  if (!entities.length) throw new Error(`Block "${session.name}" cannot be saved empty — add at least one object, or discard the session.`);
  return {
    name: session.name,
    base: { ...session.base },
    entities: clone(entities),
    attdefs: clone(session.attdefs),
    ...(session.description ? { description: session.description } : {}),
  };
}

/** How many references to `name` exist in the given entity lists (for the save log). */
export function countBlockInstances(name: string, ...lists: DxfEntity[][]): number {
  const key = name.toLowerCase();
  let n = 0;
  for (const list of lists) for (const e of list) if (e.type === "INSERT" && e.name.toLowerCase() === key) n++;
  return n;
}
