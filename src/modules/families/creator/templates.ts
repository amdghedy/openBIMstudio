// Free family creator, slice 1: part templates.
//
// A template is plain data: extra parameters plus parts, where every part
// dimension and position is an expression over the family parameters. The
// same expressions drive the engine geometry (build.ts) and the IFC export
// (ifc2x3.ts), so the two cannot drift apart.
//
// Axes follow the engine: X = width, Y = up, Z = depth. The origin is the
// centre of the base. A part's x/y/z is its CENTRE.

import type { FamilyCategory } from "../types";

export interface TemplateParam {
  name: string;
  label: string;
  /** Default in metres. Ignored when `formula` is set. */
  default: number;
  min?: number;
  max?: number;
  /** Engine formula, starting with "=". Makes the parameter derived. */
  formula?: string;
  /** A whole number (a count), not a length. Changing it rebuilds the parts. */
  integer?: boolean;
}

export interface TemplatePart {
  id: string;
  name: string;
  shape: "box" | "cylinder";
  // box: w (X), d (Z), h (Y). cylinder: r, h (axis Y).
  w?: string; d?: string; h?: string; r?: string;
  x: string; y: string; z: string;
  /**
   * Make one copy per unit of the named integer parameter. In the expressions,
   * the token K stands for the copy number 1..count. Id and name get the number.
   */
  repeat?: { count: string };
}

export interface PartTemplate {
  id: "box" | "cabinet" | "table" | "shelf";
  label: string;
  category: FamilyCategory;
  ifcEntity: "IfcBuildingElementProxy" | "IfcFurnishingElement";
  params: TemplateParam[];
  parts: TemplatePart[];
}

export const BOX_TEMPLATE: PartTemplate = {
  id: "box",
  label: "Single box",
  category: "generic",
  ifcEntity: "IfcBuildingElementProxy",
  params: [],
  parts: [
    { id: "body", name: "Body", shape: "box", w: "Width", d: "Depth", h: "Height", x: "0", y: "Height / 2", z: "0" },
  ],
};

// A cabinet or display case: plinth, body, front door panel and a handle.
// Every part stays inside the overall Width x Depth x Height box.
export const CABINET_TEMPLATE: PartTemplate = {
  id: "cabinet",
  label: "Cabinet with door",
  category: "equipment",
  ifcEntity: "IfcFurnishingElement",
  params: [
    { name: "PlinthHeight", label: "Plinth height", default: 0.1, min: 0.0, max: 0.5 },
    { name: "DoorThickness", label: "Door thickness", default: 0.03, min: 0.005, max: 0.15 },
    { name: "HandleRadius", label: "Handle radius", default: 0.012, min: 0.003, max: 0.05 },
    { name: "BodyHeight", label: "Body height", default: 0, formula: "= Height - PlinthHeight" },
    { name: "HandleLength", label: "Handle length", default: 0, formula: "= BodyHeight * 0.4" },
  ],
  parts: [
    { id: "plinth", name: "Plinth", shape: "box", w: "Width", d: "Depth", h: "PlinthHeight", x: "0", y: "PlinthHeight / 2", z: "0" },
    { id: "body", name: "Body", shape: "box", w: "Width", d: "Depth - DoorThickness", h: "BodyHeight",
      x: "0", y: "PlinthHeight + BodyHeight / 2", z: "0 - DoorThickness / 2" },
    { id: "door", name: "Door", shape: "box", w: "Width", d: "DoorThickness", h: "BodyHeight",
      x: "0", y: "PlinthHeight + BodyHeight / 2", z: "Depth / 2 - DoorThickness / 2" },
    { id: "handle", name: "Handle", shape: "cylinder", r: "HandleRadius", h: "HandleLength",
      x: "Width / 2 - 0.05", y: "PlinthHeight + BodyHeight / 2", z: "Depth / 2 - HandleRadius" },
  ],
};

// A table, desk or counter: top slab and four square legs inset at the corners.
export const TABLE_TEMPLATE: PartTemplate = {
  id: "table",
  label: "Table with four legs",
  category: "generic",
  ifcEntity: "IfcFurnishingElement",
  params: [
    { name: "TopThickness", label: "Top thickness", default: 0.03, min: 0.01, max: 0.15 },
    { name: "LegSize", label: "Leg size", default: 0.05, min: 0.02, max: 0.2 },
    { name: "LegHeight", label: "Leg height", default: 0, formula: "= Height - TopThickness" },
  ],
  parts: [
    { id: "top", name: "Top", shape: "box", w: "Width", d: "Depth", h: "TopThickness", x: "0", y: "Height - TopThickness / 2", z: "0" },
    { id: "leg-fl", name: "Leg front left", shape: "box", w: "LegSize", d: "LegSize", h: "LegHeight", x: "0 - Width / 2 + LegSize / 2", y: "LegHeight / 2", z: "Depth / 2 - LegSize / 2" },
    { id: "leg-fr", name: "Leg front right", shape: "box", w: "LegSize", d: "LegSize", h: "LegHeight", x: "Width / 2 - LegSize / 2", y: "LegHeight / 2", z: "Depth / 2 - LegSize / 2" },
    { id: "leg-bl", name: "Leg back left", shape: "box", w: "LegSize", d: "LegSize", h: "LegHeight", x: "0 - Width / 2 + LegSize / 2", y: "LegHeight / 2", z: "0 - Depth / 2 + LegSize / 2" },
    { id: "leg-br", name: "Leg back right", shape: "box", w: "LegSize", d: "LegSize", h: "LegHeight", x: "Width / 2 - LegSize / 2", y: "LegHeight / 2", z: "0 - Depth / 2 + LegSize / 2" },
  ],
};

// Open shelving: two sides, a back, bottom and top panels and one middle shelf.
export const SHELF_TEMPLATE: PartTemplate = {
  id: "shelf",
  label: "Open shelving",
  category: "generic",
  ifcEntity: "IfcFurnishingElement",
  params: [
    { name: "PanelThickness", label: "Panel thickness", default: 0.02, min: 0.005, max: 0.08 },
    { name: "MidShelves", label: "Middle shelves", default: 1, min: 0, max: 12, integer: true },
    { name: "InnerWidth", label: "Inner width", default: 0, formula: "= Width - 2 * PanelThickness" },
    { name: "InnerHeight", label: "Inner height", default: 0, formula: "= Height - 2 * PanelThickness" },
  ],
  parts: [
    { id: "side-l", name: "Left side", shape: "box", w: "PanelThickness", d: "Depth", h: "Height", x: "0 - Width / 2 + PanelThickness / 2", y: "Height / 2", z: "0" },
    { id: "side-r", name: "Right side", shape: "box", w: "PanelThickness", d: "Depth", h: "Height", x: "Width / 2 - PanelThickness / 2", y: "Height / 2", z: "0" },
    { id: "bottom", name: "Bottom panel", shape: "box", w: "InnerWidth", d: "Depth", h: "PanelThickness", x: "0", y: "PanelThickness / 2", z: "0" },
    { id: "top", name: "Top panel", shape: "box", w: "InnerWidth", d: "Depth", h: "PanelThickness", x: "0", y: "Height - PanelThickness / 2", z: "0" },
    { id: "mid", name: "Middle shelf", shape: "box", w: "InnerWidth", d: "Depth", h: "PanelThickness", x: "0",
      y: "PanelThickness / 2 + K * (Height - PanelThickness) / (MidShelves + 1)", z: "0", repeat: { count: "MidShelves" } },
    { id: "back", name: "Back panel", shape: "box", w: "InnerWidth", d: "PanelThickness", h: "InnerHeight", x: "0", y: "Height / 2", z: "0 - Depth / 2 + PanelThickness / 2" },
  ],
};

export const TEMPLATES: Record<string, PartTemplate> = {
  box: BOX_TEMPLATE,
  cabinet: CABINET_TEMPLATE,
  table: TABLE_TEMPLATE,
  shelf: SHELF_TEMPLATE,
};

const SHELF_WORDS = /\b(shelf|shelves|shelving|bookcase|bookshelf|rack|racking)\b/i;
const TABLE_WORDS = /\b(table|desk|counter|bench|workbench)\b/i;

const CABINET_WORDS = /\b(cabinet|case|fridge|refrigerator|freezer|display|merchandiser|cooler|chiller|locker|cupboard|wardrobe)\b/i;

/** Pick a template from the product text. Falls back to a plain box. */
export function chooseTemplate(text: string): PartTemplate {
  if (SHELF_WORDS.test(text)) return SHELF_TEMPLATE;
  if (TABLE_WORDS.test(text)) return TABLE_TEMPLATE;
  return CABINET_WORDS.test(text) ? CABINET_TEMPLATE : BOX_TEMPLATE;
}

/**
 * Write out repeated parts for the given counts (name -> whole number).
 * Counts not given use the template default. Copies are spread by the
 * template's own formulas, so the geometry stays driven by parameters.
 */
export function expandTemplate(tpl: PartTemplate, counts: Record<string, number> = {}): PartTemplate {
  if (!tpl.parts.some((p) => p.repeat)) return tpl;
  const parts: TemplatePart[] = [];
  for (const p of tpl.parts) {
    if (!p.repeat) { parts.push(p); continue; }
    const def = tpl.params.find((x) => x.name === p.repeat!.count);
    const n = Math.max(0, Math.round(counts[p.repeat.count] ?? def?.default ?? 0));
    for (let k = 1; k <= n; k++) {
      const sub = (e: string | undefined) => (e === undefined ? e : e.replace(/\bK\b/g, String(k)));
      parts.push({ ...p, id: `${p.id}-${k}`, name: n > 1 ? `${p.name} ${k}` : p.name, w: sub(p.w), d: sub(p.d), h: sub(p.h), r: sub(p.r), x: sub(p.x) as string, y: sub(p.y) as string, z: sub(p.z) as string, repeat: undefined });
    }
  }
  return { ...tpl, parts };
}
