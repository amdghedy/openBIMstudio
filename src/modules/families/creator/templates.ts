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
}

export interface TemplatePart {
  id: string;
  name: string;
  shape: "box" | "cylinder";
  // box: w (X), d (Z), h (Y). cylinder: r, h (axis Y).
  w?: string; d?: string; h?: string; r?: string;
  x: string; y: string; z: string;
}

export interface PartTemplate {
  id: "box" | "cabinet";
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

export const TEMPLATES: Record<string, PartTemplate> = {
  box: BOX_TEMPLATE,
  cabinet: CABINET_TEMPLATE,
};

const CABINET_WORDS = /\b(cabinet|case|fridge|refrigerator|freezer|display|merchandiser|cooler|chiller|locker|cupboard|wardrobe)\b/i;

/** Pick a template from the product text. Falls back to a plain box. */
export function chooseTemplate(text: string): PartTemplate {
  return CABINET_WORDS.test(text) ? CABINET_TEMPLATE : BOX_TEMPLATE;
}
