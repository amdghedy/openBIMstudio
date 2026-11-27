/**
 * Family Gallery — pure helpers for the new.family-parity Gallery
 * (Phase 1, Item 1).
 *
 * No runtime imports (type-only), so the node suite can exercise this
 * logic without pulling in the family store, the project system, or
 * three.js.
 *
 * What this mirrors from new.family, and what it deliberately does not:
 * - Gallery cards from the REAL family store (seed catalog + built-ins
 *   + user families), with search, group/category/hosting filters, sort
 *   and Show-more pagination — all computed from fields that actually
 *   exist on FamilyDefinition.
 * - Hosting is DERIVED, not stored: seed JSONs carry no hosting field.
 *   Doors and windows host on walls (their openings are cut by
 *   `src/modules/hosting/index.ts`; see `modules/families/family-hosting.ts`:
 *   "Doors and windows already host on walls"), everything else is
 *   unhosted. No Face / Ceiling / Floor hosting is claimed, because no
 *   family in the store carries that data.
 * - Status is DERIVED: "Ready" means the family has a geometry recipe
 *   and at least one type, so it can be placed in openBIMstudio. It is
 *   NOT a Revit-ready claim — no family here is a .rfa, and the UI
 *   must say so (see the Ready badge tooltip in family-gallery.ts).
 * - Sort is limited to fields that exist: name, group, type count,
 *   parameter count. new.family sorts by Featured / Top / New / Most
 *   downloaded — none of those can be computed honestly here (no
 *   download counts, no creation dates, no curation order in the
 *   store), so they are not offered and no fake counts are invented.
 * - Upvotes are LOCAL ONLY: a toggle per family id persisted in
 *   browser localStorage under GALLERY_UPVOTES_KEY. There is no server
 *   and no shared count — a family shows 1 when this browser upvoted
 *   it, 0 otherwise. Never present that as a community total.
 */

import type { FamilyDefinition } from "./types";

/** Hosting as the Gallery shows it. */
export type GalleryHosting = "Wall" | "Unhosted";

/**
 * Derive hosting from the family category. Doors and windows host on
 * walls; every other family in the store is unhosted (level-based).
 */
export function deriveHosting(fam: FamilyDefinition): GalleryHosting {
  return fam.category === "door" || fam.category === "window" ? "Wall" : "Unhosted";
}

/** Gallery status as the Gallery shows it. */
export type GalleryStatus = "Ready" | "Draft";

/**
 * "Ready" = placeable in openBIMstudio: a geometry recipe and at
 * least one type. Anything else (e.g. a user family sketched without
 * types yet) is a Draft. This says nothing about Revit / .rfa.
 */
export function galleryStatus(fam: FamilyDefinition): GalleryStatus {
  const hasGeometry =
    !!fam.geometry &&
    typeof (fam.geometry as { kind?: unknown }).kind === "string" &&
    ((fam.geometry as { kind: string }).kind.length > 0);
  const hasTypes = Array.isArray(fam.types) && fam.types.length > 0;
  return hasGeometry && hasTypes ? "Ready" : "Draft";
}

export interface GalleryFilters {
  /** Free text, matched against name / group / category / IFC / types. */
  query: string;
  /** Family `group` (e.g. "Doors"), or "all". */
  group: string;
  /** Family `category`, or "all". */
  category: string;
  /** "all" | "Wall" | "Unhosted". */
  hosting: string;
  /** When true, only Ready families pass. */
  readyOnly: boolean;
}

export const EMPTY_GALLERY_FILTERS: GalleryFilters = {
  query: "",
  group: "all",
  category: "all",
  hosting: "all",
  readyOnly: false,
};

/** Case-insensitive substring match across the searchable family fields. */
export function galleryMatchesQuery(fam: FamilyDefinition, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystacks = [
    fam.name,
    fam.group ?? "",
    fam.category,
    fam.ifcEntity,
    ...(fam.types ?? []).map((t) => t.name),
  ];
  return haystacks.some((h) => h.toLowerCase().includes(q));
}

/** Apply all Gallery filters. Returns a new array; the input is untouched. */
export function filterGalleryFamilies(
  list: FamilyDefinition[],
  filters: GalleryFilters,
): FamilyDefinition[] {
  return list.filter((fam) => {
    if (filters.group !== "all" && (fam.group ?? "") !== filters.group) return false;
    if (filters.category !== "all" && fam.category !== filters.category) return false;
    if (filters.hosting !== "all" && deriveHosting(fam) !== filters.hosting) return false;
    if (filters.readyOnly && galleryStatus(fam) !== "Ready") return false;
    return galleryMatchesQuery(fam, filters.query);
  });
}

/**
 * Sorts the Gallery can actually compute. "name" is the default.
 * "types" / "parameters" sort by count, descending, ties broken by name
 * so the order is deterministic.
 */
export type GallerySort = "name" | "group" | "types" | "parameters";

export function sortGalleryFamilies(
  list: FamilyDefinition[],
  sort: GallerySort,
): FamilyDefinition[] {
  const out = [...list];
  const byName = (a: FamilyDefinition, b: FamilyDefinition) => a.name.localeCompare(b.name);
  switch (sort) {
    case "group":
      return out.sort(
        (a, b) => (a.group ?? "").localeCompare(b.group ?? "") || byName(a, b),
      );
    case "types":
      return out.sort((a, b) => b.types.length - a.types.length || byName(a, b));
    case "parameters":
      return out.sort(
        (a, b) => b.parameters.length - a.parameters.length || byName(a, b),
      );
    case "name":
    default:
      return out.sort(byName);
  }
}

/** Cards shown per Gallery page (Show more adds another page). */
export const GALLERY_PAGE_SIZE = 12;

export interface GalleryPage {
  /** The families to render on this page. */
  shown: FamilyDefinition[];
  /** Total families after filtering (before pagination). */
  total: number;
  /** True when more filtered families remain below the fold. */
  hasMore: boolean;
}

/** Slice a filtered + sorted list to the visible page. */
export function paginateGalleryFamilies(
  list: FamilyDefinition[],
  visibleCount: number,
): GalleryPage {
  return {
    shown: list.slice(0, Math.max(0, visibleCount)),
    total: list.length,
    hasMore: list.length > Math.max(0, visibleCount),
  };
}

/** localStorage key for this browser's Gallery upvotes (ids only). */
export const GALLERY_UPVOTES_KEY = "obs.gallery.upvotes.v1";

/** Minimal storage surface, so tests can inject an in-memory stand-in. */
export interface GalleryUpvoteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface GalleryUpvotes {
  /** True when this browser upvoted the family. */
  isUpvoted(id: string): boolean;
  /** Toggle the upvote; returns the new state (true = upvoted). */
  toggle(id: string): boolean;
  /** Local upvote count: 1 when upvoted here, else 0. No server total. */
  count(id: string): number;
  /** All upvoted family ids, in upvote order. */
  list(): string[];
}

/**
 * Local-only upvote store. A corrupt stored value resets to empty
 * rather than breaking the Gallery.
 */
export function createGalleryUpvotes(storage: GalleryUpvoteStorage): GalleryUpvotes {
  const read = (): string[] => {
    try {
      const raw = storage.getItem(GALLERY_UPVOTES_KEY);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  const write = (ids: string[]): void => {
    try {
      storage.setItem(GALLERY_UPVOTES_KEY, JSON.stringify(ids));
    } catch {
      /* storage full / unavailable — the toggle still works this session */
    }
  };
  // Keep the in-memory set as the source of truth within a session so
  // a failed write does not lose the toggle; storage is best-effort.
  let ids: string[] = read();
  return {
    isUpvoted: (id) => ids.includes(id),
    toggle: (id) => {
      const at = ids.indexOf(id);
      if (at >= 0) ids.splice(at, 1);
      else ids.push(id);
      write(ids);
      return at < 0;
    },
    count: (id) => (ids.includes(id) ? 1 : 0),
    list: () => [...ids],
  };
}
