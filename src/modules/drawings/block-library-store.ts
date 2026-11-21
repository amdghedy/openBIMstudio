/**
 * Block-library persistence (hardening plan item 19, cad-viewer leg 2).
 *
 * Extracted verbatim — same storage key, same load/save semantics — from
 * `src/features/cad-viewer.ts`, which used to own the shared library inline:
 * a module-level `BlockLibrary` loaded once from `localStorage` under
 * `"obs.cad.blocks"`, plus a `persistBlockLib()` that wrote it back and
 * returned false when the browser refused (quota / private mode).
 *
 * Nothing about the stored bytes changed: `saveBlockLibrary` writes exactly
 * `JSON.stringify(lib.toJSON())` under exactly the same key, so a library
 * saved by the old inline code loads identically here, and vice versa.
 * Loading stays fail-soft by design — corrupt JSON, hostile records, or
 * unavailable storage all yield an empty library, never a throw — because
 * the library is a convenience cache, not project data (see
 * `BlockLibrary.fromJSON`, which skips bad records instead of throwing).
 *
 * This module deliberately does NOT register in `core/services.ts`: it is a
 * plain storage helper imported directly, exactly like `cad-blocks.ts`
 * itself. It also imports nothing from `src/features/`, so it cannot
 * reintroduce the import cycle item 18 broke (see `scripts/` cycle check).
 */
import { BlockLibrary } from "./cad-blocks";

/** Storage key for the library shared by every drawing tab. Unchanged since the library was introduced. */
export const BLOCK_LIBRARY_STORAGE_KEY = "obs.cad.blocks";

/**
 * The only storage surface this module needs, so tests can pass a fake and
 * the browser path can pass `localStorage` implicitly. Deliberately narrower
 * than `Storage`: no `length`/`key`/`removeItem`/`clear` — this module never
 * removes or enumerates anything.
 */
export interface BlockLibraryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** `localStorage` when the environment has one, else null (Node, private mode, blocked storage). Never throws. */
export function resolveBlockLibraryStorage(): BlockLibraryStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * Load the shared library from storage. Missing key, corrupt JSON, hostile
 * records, or unavailable storage all yield an empty library — the exact
 * behaviour the old inline IIFE in cad-viewer.ts had.
 */
export function loadBlockLibrary(
  storage: BlockLibraryStorage | null = resolveBlockLibraryStorage(),
): BlockLibrary {
  try {
    const raw = storage?.getItem(BLOCK_LIBRARY_STORAGE_KEY);
    if (raw) return BlockLibrary.fromJSON(JSON.parse(raw)).lib;
  } catch {
    /* storage unavailable or corrupt: start empty */
  }
  return new BlockLibrary();
}

/**
 * Persist a library. Returns false when the browser refused to store
 * (quota, private mode) or when there is no storage at all, so the caller
 * can say so — the exact contract the old `persistBlockLib()` had.
 */
export function saveBlockLibrary(
  lib: BlockLibrary,
  storage: BlockLibraryStorage | null = resolveBlockLibraryStorage(),
): boolean {
  try {
    if (!storage) return false;
    storage.setItem(BLOCK_LIBRARY_STORAGE_KEY, JSON.stringify(lib.toJSON()));
    return true;
  } catch {
    return false;
  }
}

/**
 * The library shared by every drawing tab, loaded once when this module is
 * first imported — same timing as the old module-level IIFE in cad-viewer.ts.
 */
export const blockLib: BlockLibrary = loadBlockLibrary();

/** Persist the shared library. Returns false when the browser refused to store. */
export function persistBlockLib(
  storage: BlockLibraryStorage | null = resolveBlockLibraryStorage(),
): boolean {
  return saveBlockLibrary(blockLib, storage);
}
