/**
 * Category mapping for Visibility/Graphics.
 *
 * The VG dialog and view templates key overrides by Revit-style category
 * ids ("Walls", "Ducts", "StructuralFraming", … — see STANDARD_CATEGORIES
 * in ./types), but the model stores authored elements by singular type
 * ("wall", "duct", "beam", …). Until this module existed, the template
 * store synced "Walls" into the visibility filter while every render-time
 * check asked about "wall", so a template could never hide anything.
 *
 * `toVgCategory` is the single canonical mapping: every caller that turns
 * an element (or a raw category string) into a VG key goes through it, so
 * "wall", "Walls" and "WALLS" all resolve to "Walls". Unknown keys pass
 * through unchanged, so custom / IFC categories keep working as keys —
 * they simply match no template row unless the template uses the same key.
 *
 * Pure and dependency-free so node tests can compile it standalone.
 */

import { STANDARD_CATEGORIES } from "./types";

/** Authored element type → VG category id. */
export const ELEMENT_TYPE_TO_VG_CATEGORY: Record<string, string> = {
  wall: "Walls",
  slab: "Floors",
  column: "Columns",
  beam: "StructuralFraming",
  brace: "StructuralFraming",
  truss: "StructuralFraming",
  footing: "Foundations",
  strip: "Foundations",
  duct: "Ducts",
  pipe: "Pipes",
  "cable-tray": "CableTrays",
  conduit: "Conduits",
  equipment: "MechanicalEquipment",
  door: "Doors",
  window: "Windows",
  roof: "Roofs",
  stairs: "Stairs",
  railing: "Railings",
  room: "Rooms",
  area: "Areas",
  ceiling: "Ceilings",
  terrain: "Site",
  "curtain-wall": "CurtainWalls",
  grid: "Grids",
  level: "Levels",
  // No dedicated VG category exists for these; GenericModels is the honest
  // bucket (they are still individually addressable by their raw type key).
  mline: "GenericModels",
  fitting: "GenericModels",
  "vertical-opening": "GenericModels",
  ramp: "GenericModels",
  "adaptive-component": "GenericModels",
  generic: "GenericModels",
};

/**
 * Canonical VG category id for an element type, a VG category id, or any
 * other category string. Case-insensitive; surrounding whitespace ignored.
 */
export function toVgCategory(input: string | null | undefined): string {
  if (input == null) return "";
  const raw = String(input).trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (ELEMENT_TYPE_TO_VG_CATEGORY[lower]) return ELEMENT_TYPE_TO_VG_CATEGORY[lower];
  // Already-canonical ids ("Walls") and plurals ("walls") resolve here.
  for (const c of STANDARD_CATEGORIES) {
    if (c.id.toLowerCase() === lower) return c.id;
  }
  return raw;
}

/** All canonical VG category ids, in dialog order. */
export function listVgCategories(): string[] {
  return STANDARD_CATEGORIES.map((c) => c.id);
}
