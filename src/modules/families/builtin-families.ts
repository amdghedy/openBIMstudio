// openbim-step1:family-foundation
// Built-in families mirroring the current hardcoded element types in
// authoring.ts. When authoring is later refactored to consult this
// registry, the behaviour must stay identical for these ten families.

import type { FamilyDefinition } from "./types";

const REF = (name: string) => ({ ref: name });
const CONST = (n: number) => ({ const: n });

export function createBuiltInFamilies(): FamilyDefinition[] {
  const families: FamilyDefinition[] = [];
  let seq = 0;
  const id = (name: string) => "builtin-" + name + "-" + (++seq);

  // ---- wall ---------------------------------------------------------------
  families.push({
    id: id("wall"),
    name: "Basic Wall",
    category: "wall",
    ifcEntity: "IfcWall",
    schemaVersion: 1,
    sourceElementType: "wall",
    builtIn: true,
    parameters: [
      { name: "height",    type: "length", scope: "instance", default: 3.0, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "thickness", type: "length", scope: "instance", default: 0.2, editable: true, step: 0.01, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
      // openbim-families:formula-editor
      { name: "areaPerMeter", type: "area",   scope: "instance", default: 0, editable: false, unit: "m2", group: "Computed", formula: "= thickness * height" },
      { name: "slenderness",  type: "number", scope: "instance", default: 0, editable: false, group: "Computed", formula: "= height / thickness" },
    ],
    geometry: {
      kind: "box",
      w: CONST(1),
      d: REF("thickness"),
      h: REF("height"),
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("wall-100"), name: "Generic 100 mm", values: { thickness: 0.1 } },
      { id: id("wall-200"), name: "Generic 200 mm", values: { thickness: 0.2 } },
      { id: id("wall-300"), name: "Generic 300 mm", values: { thickness: 0.3 } },
    ],
  });

  // ---- slab ---------------------------------------------------------------
  families.push({
    id: id("slab"),
    name: "Basic Floor",
    category: "slab",
    ifcEntity: "IfcSlab",
    schemaVersion: 1,
    sourceElementType: "slab",
    builtIn: true,
    parameters: [
      { name: "height", label: "Thickness", type: "length", scope: "instance", default: 0.2, editable: true, step: 0.01, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "box",
      w: CONST(1),
      d: CONST(1),
      h: REF("height"),
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("slab-150"), name: "Concrete 150 mm", values: { thickness: 0.15 } },
      { id: id("slab-200"), name: "Concrete 200 mm", values: { thickness: 0.2 } },
      { id: id("slab-250"), name: "Concrete 250 mm", values: { thickness: 0.25 } },
    ],
  });

  // ---- column -------------------------------------------------------------
  families.push({
    id: id("column"),
    name: "Basic Column",
    category: "column",
    ifcEntity: "IfcColumn",
    schemaVersion: 1,
    sourceElementType: "column",
    builtIn: true,
    parameters: [
      { name: "height",    type: "length", scope: "instance", default: 3.0, editable: true, step: 0.1, unit: "m", group: "Dimensions" },
      { name: "thickness", type: "length", scope: "instance", default: 0.3, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "depth",     type: "length", scope: "instance", default: 0.3, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
      // openbim-families:formula-editor
      { name: "concreteVolume", type: "volume", scope: "instance", default: 0, editable: false, unit: "m3", group: "Computed", formula: "= thickness * depth * height" },
      { name: "slenderness",    type: "number", scope: "instance", default: 0, editable: false, group: "Computed", formula: "= height / min(thickness, depth)" },
    ],
    geometry: {
      kind: "box",
      w: REF("thickness"),
      d: REF("depth"),
      h: REF("height"),
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("col-300"), name: "300 x 300", values: { thickness: 0.3, depth: 0.3 } },
      { id: id("col-400"), name: "400 x 400", values: { thickness: 0.4, depth: 0.4 } },
    ],
  });

  // ---- beam ---------------------------------------------------------------
  families.push({
    id: id("beam"),
    name: "Basic Beam",
    category: "beam",
    ifcEntity: "IfcBeam",
    schemaVersion: 1,
    sourceElementType: "beam",
    builtIn: true,
    parameters: [
      { name: "height",    type: "length", scope: "instance", default: 0.5, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "thickness", type: "length", scope: "instance", default: 0.25, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
      // openbim-families:formula-editor
      { name: "sectionArea",    type: "area",   scope: "instance", default: 0, editable: false, unit: "m2", group: "Computed", formula: "= thickness * height" },
      { name: "sectionInertia", type: "number", scope: "instance", default: 0, editable: false, group: "Computed", formula: "= (thickness * height * height * height) / 12" },
    ],
    geometry: {
      kind: "box",
      w: CONST(1),
      d: REF("thickness"),
      h: REF("height"),
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("beam-300x500"), name: "300 x 500", values: { thickness: 0.3, height: 0.5 } },
      { id: id("beam-250x500"), name: "250 x 500", values: { thickness: 0.25, height: 0.5 } },
    ],
  });

  // ---- door ---------------------------------------------------------------
  families.push({
    id: id("door"),
    name: "Basic Door",
    category: "door",
    ifcEntity: "IfcDoor",
    schemaVersion: 1,
    sourceElementType: "door",
    builtIn: true,
    parameters: [
      { name: "width",           type: "length",  scope: "type",     default: 0.9,  editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "height",          type: "length",  scope: "type",     default: 2.1,  editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "frameThickness",  type: "length",  scope: "type",     default: 0.06, editable: true, step: 0.005, unit: "m", group: "Construction" },
      { name: "sillHeight",      type: "length",  scope: "instance", default: 0.0,  editable: true, step: 0.05, unit: "m", group: "Constraints" },
      { name: "offsetAlongHost", type: "length",  scope: "instance", default: 0.0,  editable: true, step: 0.05, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "box",
      w: REF("width"),
      d: CONST(0.04),
      h: REF("height"),
      transform: {
        translate: [CONST(0), { ref: "sillHeight" }, CONST(0)],
      },
    },
    types: [
      { id: id("door-900"), name: "Single 900 x 2100", values: { width: 0.9, height: 2.1 } },
      { id: id("door-1000"), name: "Single 1000 x 2100", values: { width: 1.0, height: 2.1 } },
      { id: id("door-double"), name: "Double 1800 x 2100", values: { width: 1.8, height: 2.1 } },
    ],
  });

  // ---- window -------------------------------------------------------------
  families.push({
    id: id("window"),
    name: "Basic Window",
    category: "window",
    ifcEntity: "IfcWindow",
    schemaVersion: 1,
    sourceElementType: "window",
    builtIn: true,
    parameters: [
      { name: "width",           type: "length", scope: "type",     default: 1.2,  editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "height",          type: "length", scope: "type",     default: 1.4,  editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "frameThickness",  type: "length", scope: "type",     default: 0.05, editable: true, step: 0.005, unit: "m", group: "Construction" },
      { name: "sillHeight",      type: "length", scope: "instance", default: 0.9,  editable: true, step: 0.05, unit: "m", group: "Constraints" },
      { name: "offsetAlongHost", type: "length", scope: "instance", default: 0.0,  editable: true, step: 0.05, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "box",
      w: REF("width"),
      d: CONST(0.03),
      h: REF("height"),
      transform: { translate: [CONST(0), { ref: "sillHeight" }, CONST(0)] },
    },
    types: [
      { id: id("win-1200x1400"), name: "1200 x 1400", values: { width: 1.2, height: 1.4 } },
      { id: id("win-1500x1500"), name: "1500 x 1500", values: { width: 1.5, height: 1.5 } },
    ],
  });

  // ---- duct ---------------------------------------------------------------
  families.push({
    id: id("duct"),
    name: "Rectangular Duct",
    category: "duct",
    ifcEntity: "IfcDuctSegment",
    schemaVersion: 1,
    sourceElementType: "duct",
    builtIn: true,
    parameters: [
      { name: "thickness", label: "Width",     type: "length", scope: "type",     default: 0.6, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "height",    type: "length", scope: "type",     default: 0.4, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "box",
      w: CONST(1),
      d: REF("thickness"),
      h: REF("height"),
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("duct-600x400"), name: "600 x 400", values: { thickness: 0.6, height: 0.4 } },
      { id: id("duct-400x300"), name: "400 x 300", values: { thickness: 0.4, height: 0.3 } },
    ],
  });

  // ---- pipe ---------------------------------------------------------------
  families.push({
    id: id("pipe"),
    name: "Round Pipe",
    category: "pipe",
    ifcEntity: "IfcPipeSegment",
    schemaVersion: 1,
    sourceElementType: "pipe",
    builtIn: true,
    parameters: [
      { name: "thickness", label: "Diameter",  type: "length", scope: "type",     default: 0.1, editable: true, step: 0.005, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
      // openbim-families:formula-editor
      { name: "circumference",    type: "length", scope: "instance", default: 0, editable: false, unit: "m",  group: "Computed", formula: "= pi() * diameter" },
      { name: "crossSectionArea", type: "area",   scope: "instance", default: 0, editable: false, unit: "m2", group: "Computed", formula: "= pi() * (diameter / 2) * (diameter / 2)" },
    ],
    geometry: {
      kind: "cylinder",
      r: { expr: "thickness / 2" },
      h: CONST(1),
      segments: 16,
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("pipe-dn50"),  name: "DN 50",  values: { thickness: 0.05 } },
      { id: id("pipe-dn100"), name: "DN 100", values: { thickness: 0.1 } },
      { id: id("pipe-dn150"), name: "DN 150", values: { thickness: 0.15 } },
    ],
  });

  // ---- cable tray ---------------------------------------------------------
  families.push({
    id: id("cable-tray"),
    name: "Cable Tray",
    category: "cable-tray",
    ifcEntity: "IfcCableCarrierSegment",
    schemaVersion: 1,
    sourceElementType: "cable-tray",
    builtIn: true,
    parameters: [
      { name: "thickness", label: "Width",     type: "length", scope: "type",     default: 0.3, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "height", label: "Depth",     type: "length", scope: "type",     default: 0.1, editable: true, step: 0.01, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "box",
      w: CONST(1),
      d: REF("thickness"),
      h: REF("height"),
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("tray-300"), name: "300 mm", values: { thickness: 0.3, height: 0.1 } },
      { id: id("tray-450"), name: "450 mm", values: { thickness: 0.45, height: 0.1 } },
    ],
  });

  // ---- conduit ------------------------------------------------------------
  families.push({
    id: id("conduit"),
    name: "Conduit",
    category: "conduit",
    ifcEntity: "IfcCableCarrierSegment",
    schemaVersion: 1,
    sourceElementType: "conduit",
    builtIn: true,
    parameters: [
      { name: "thickness", label: "Diameter",  type: "length", scope: "type",     default: 0.025, editable: true, step: 0.005, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "cylinder",
      r: { expr: "thickness / 2" },
      h: CONST(1),
      segments: 12,
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("conduit-20"), name: "20 mm", values: { thickness: 0.02 } },
      { id: id("conduit-25"), name: "25 mm", values: { thickness: 0.025 } },
    ],
  });

  // ---- equipment (generic placeholder family) ----------------------------
  families.push({
    id: id("equipment"),
    name: "Generic Equipment",
    category: "equipment",
    ifcEntity: "IfcBuildingElementProxy",
    schemaVersion: 1,
    sourceElementType: "equipment",
    builtIn: true,
    parameters: [
      { name: "thickness", label: "Width",     type: "length", scope: "type",     default: 0.8, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "depth",     type: "length", scope: "type",     default: 0.8, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "height",    type: "length", scope: "type",     default: 1.2, editable: true, step: 0.05, unit: "m", group: "Dimensions" },
      { name: "elevation", type: "length", scope: "instance", default: 0.0, editable: true, step: 0.1, unit: "m", group: "Constraints" },
    ],
    geometry: {
      kind: "box",
      w: REF("thickness"),
      d: REF("depth"),
      h: REF("height"),
      transform: { translate: [CONST(0), { ref: "elevation" }, CONST(0)] },
    },
    types: [
      { id: id("equip-generic"), name: "Generic 800 x 800 x 1200", values: { thickness: 0.8, depth: 0.8, height: 1.2 } },
    ],
  });

  return families;
}
