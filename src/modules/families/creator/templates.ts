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
  shape: "box" | "cylinder" | "prism";
  // box: w (X), d (Z), h (Y). cylinder: r, h (axis Y).
  // prism: a closed outline (points, profile units, x right, y up) scaled by r and extruded h along Z.
  points?: Array<[number, number]>;
  w?: string; d?: string; h?: string; r?: string;
  x: string; y: string; z: string;
  /**
   * Make one copy per unit of the named integer parameter. In the expressions,
   * the token K stands for the copy number 1..count. Id and name get the number.
   */
  repeat?: { count: string };
  /** Cylinder axis in engine axes. Default "y" (vertical). Boxes ignore it. */
  axis?: "x" | "y" | "z";
  /** How sure the size or position is: "catalogue" (a sheet or catalogue value), "inferred" (proportion chosen here). */
  basis?: "catalogue" | "inferred";
}

export interface PartTemplate {
  id: "box" | "cabinet" | "table" | "shelf" | "booster";
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

// A cabinet or display case: plinth, body, a row of front doors (each with a
// handle) and a stack of drawer fronts (each with a pull) above the doors.
// Doors share the width equally. Drawers sit at the top, DrawerHeight each.
// Every part stays inside the overall Width x Depth x Height box. The parts
// are simple boxes: no hinges, runners, gaps or internal fittings.
export const CABINET_TEMPLATE: PartTemplate = {
  id: "cabinet",
  label: "Cabinet with doors and drawers",
  category: "equipment",
  ifcEntity: "IfcFurnishingElement",
  params: [
    { name: "PlinthHeight", label: "Plinth height", default: 0.1, min: 0.0, max: 0.5 },
    { name: "DoorThickness", label: "Door thickness", default: 0.03, min: 0.005, max: 0.15 },
    { name: "HandleRadius", label: "Handle radius", default: 0.012, min: 0.003, max: 0.05 },
    { name: "Doors", label: "Doors", default: 1, min: 0, max: 6, integer: true },
    { name: "Drawers", label: "Drawers", default: 0, min: 0, max: 8, integer: true },
    { name: "DrawerHeight", label: "Drawer front height", default: 0.18, min: 0.08, max: 0.4 },
    { name: "BodyHeight", label: "Body height", default: 0, formula: "= Height - PlinthHeight" },
    { name: "DoorZone", label: "Door zone height", default: 0, formula: "= BodyHeight - Drawers * DrawerHeight" },
    { name: "HandleLength", label: "Handle length", default: 0, formula: "= DoorZone * 0.4" },
  ],
  parts: [
    { id: "plinth", name: "Plinth", shape: "box", w: "Width", d: "Depth", h: "PlinthHeight", x: "0", y: "PlinthHeight / 2", z: "0" },
    { id: "body", name: "Body", shape: "box", w: "Width", d: "Depth - DoorThickness", h: "BodyHeight",
      x: "0", y: "PlinthHeight + BodyHeight / 2", z: "0 - DoorThickness / 2" },
    { id: "door", name: "Door", shape: "box", w: "Width / Doors", d: "DoorThickness", h: "DoorZone",
      x: "0 - Width / 2 + (K - 0.5) * Width / Doors", y: "PlinthHeight + DoorZone / 2", z: "Depth / 2 - DoorThickness / 2", repeat: { count: "Doors" } },
    { id: "handle", name: "Handle", shape: "cylinder", r: "HandleRadius", h: "HandleLength",
      x: "0 - Width / 2 + K * Width / Doors - 0.05", y: "PlinthHeight + DoorZone / 2", z: "Depth / 2 - HandleRadius", repeat: { count: "Doors" } },
    { id: "drawer", name: "Drawer front", shape: "box", w: "Width", d: "DoorThickness", h: "DrawerHeight",
      x: "0", y: "PlinthHeight + DoorZone + (K - 0.5) * DrawerHeight", z: "Depth / 2 - DoorThickness / 2", repeat: { count: "Drawers" } },
    { id: "pull", name: "Drawer pull", shape: "box", w: "0.12", d: "0.015", h: "0.012",
      x: "0", y: "PlinthHeight + DoorZone + (K - 0.5) * DrawerHeight", z: "Depth / 2 - 0.0075", repeat: { count: "Drawers" } },
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


// A packaged pressure-boosting set (pumps on a common frame, two manifolds, a
// control panel on a rack). Written from catalogue data: overall Width, Depth
// and Height, manifold length, offset, panel size and connection size are the
// catalogue values. Motor, pump head, valve and frame-member sizes are NOT on a
// data sheet: they are simple proportions chosen here (basis "inferred") and
// are marked so in the parts list. Parts are plain boxes and cylinders; there
// is no impeller, motor fin, weld or bracket detail.
export const BOOSTER_TEMPLATE: PartTemplate = {
  id: "booster",
  label: "Packaged booster set (pumps, manifolds, panel)",
  category: "equipment",
  ifcEntity: "IfcBuildingElementProxy",
  params: [
    { name: "Pumps", label: "Pumps", default: 3, min: 1, max: 6, integer: true },
    { name: "FrameLength", label: "Frame length (sheet dimension B)", default: 1.4478, min: 0.3, max: 6 },
    { name: "ManifoldLength", label: "Manifold length", default: 1.6256, min: 0.3, max: 6 },
    { name: "InletDia", label: "Connection size (pipe diameter)", default: 0.1524, min: 0.025, max: 0.4 },
    { name: "PanelH", label: "Panel height", default: 0.762, min: 0.2, max: 1.5 },
    { name: "PanelW", label: "Panel width", default: 0.9906, min: 0.2, max: 2 },
    { name: "PanelD", label: "Panel depth", default: 0.3048, min: 0.1, max: 0.8 },
    { name: "SuctionAxisH", label: "Suction manifold axis height (sheet row D)", default: 0.2388, min: 0.05, max: 1 },
    { name: "DischargeRise", label: "Discharge axis above suction axis (sheet row E)", default: 0.4928, min: 0.1, max: 2 },
    { name: "PumpSetLength", label: "Pump and motor length (sheet row G)", default: 0.6198, min: 0.2, max: 2 },
    { name: "ManifoldSpacing", label: "Manifold spacing in depth (sheet row I)", default: 0.254, min: 0.1, max: 1 },
    { name: "FlangeBolts", label: "Bolts per flange (inferred, not on the sheet)", default: 8, min: 4, max: 16, integer: true },
    { name: "GaugeRise", label: "Gauge fitting top above the discharge axis (value: sheet table row F; that row F means this height is my reading of the drawing)", default: 0.2, min: 0.1, max: 0.6 },
    { name: "PostCount", label: "Panel rack posts (three in the sheet drawing)", default: 3, min: 1, max: 6, integer: true },
    { name: "SeamCount", label: "Panel door seams (three doors in the sheet drawing)", default: 2, min: 0, max: 6, integer: true },
    { name: "FinCount", label: "Motor cooling ribs per motor (inferred, not on the sheet)", default: 6, min: 2, max: 12, integer: true },
    { name: "RailHeight", label: "Frame rail height", default: 0.1, min: 0.04, max: 0.3 },
    { name: "RailSize", label: "Frame rail width", default: 0.08, min: 0.03, max: 0.2 },
    { name: "MotorRadius", label: "Motor radius", default: 0.11, min: 0.04, max: 0.3 },
    { name: "GaugeDialY", label: "Gauge dial centre height", default: 0, formula: "= DischargeY + max(GaugeRise, ManifoldR + 0.08) - 0.035" },
    { name: "GaugeStemH", label: "Gauge stem length", default: 0, formula: "= GaugeDialY - DischargeY - ManifoldR" },
    { name: "PanelFrontZ", label: "Panel front face depth position", default: 0, formula: "= 0 - Depth / 2 + PanelD" },
    { name: "SaddleCount", label: "Suction manifold saddles (one between each pair of pumps)", default: 0, integer: true, formula: "= Pumps - 1" },
    { name: "RibCount", label: "Total cooling ribs (pumps x ribs per motor)", default: 0, integer: true, formula: "= Pumps * FinCount" },
    { name: "FlangeT", label: "End flange thickness (fills the overall width)", default: 0, formula: "= (Width - ManifoldLength) / 2" },
    { name: "ManifoldR", label: "Manifold radius", default: 0, formula: "= InletDia / 2" },
    { name: "SuctionZ", label: "Suction manifold depth position", default: 0, formula: "= 0 - Depth / 2 + 0.04 + ManifoldR" },
    { name: "PumpEndZ", label: "Motor end depth position (at the overall depth)", default: 0, formula: "= Depth / 2 - 0.01" },
    { name: "PumpStartZ", label: "Pump inlet face depth position", default: 0, formula: "= max(SuctionZ + ManifoldR + 0.03, PumpEndZ - PumpSetLength)" },
    { name: "PumpLength", label: "Pump and motor length used", default: 0, formula: "= PumpEndZ - PumpStartZ" },
    { name: "HeadLength", label: "Pump head length (about 39 % of the pump length, estimated from the sheet drawing pixels)", default: 0, formula: "= PumpLength * 0.39" },
    { name: "MotorLength", label: "Motor length (about 61 %, estimated from pixels)", default: 0, formula: "= PumpLength * 0.61" },
    { name: "PumpAxisY", label: "Pump axis height (taken equal to the suction axis)", default: 0, formula: "= SuctionAxisH" },
    { name: "PanelBottomY", label: "Panel bottom height", default: 0, formula: "= Height - PanelH" },
    { name: "DischargeY", label: "Discharge manifold height", default: 0, formula: "= SuctionAxisH + DischargeRise" },
    { name: "DischargeZ", label: "Discharge manifold depth position (suction + row I)", default: 0, formula: "= SuctionZ + ManifoldSpacing" },
    { name: "HeadZ", label: "Pump head depth position", default: 0, formula: "= PumpStartZ + HeadLength / 2" },
    { name: "MotorZ", label: "Motor depth position", default: 0, formula: "= PumpStartZ + HeadLength + MotorLength / 2" },
    { name: "RiserLength", label: "Discharge riser length", default: 0, formula: "= DischargeY - PumpAxisY" },
  ],
  parts: [
    { id: "rail-front", name: "Frame rail front", shape: "box", w: "FrameLength", d: "RailSize", h: "RailHeight", x: "0", y: "RailHeight / 2", z: "Depth / 2 - RailSize / 2", basis: "inferred" },
    { id: "rail-back", name: "Frame rail back", shape: "box", w: "FrameLength", d: "RailSize", h: "RailHeight", x: "0", y: "RailHeight / 2", z: "0 - Depth / 2 + RailSize / 2", basis: "inferred" },
    { id: "cross", name: "Pump cross rail", shape: "box", w: "RailSize", d: "Depth - 2 * RailSize", h: "RailHeight", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "RailHeight / 2", z: "0", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "motor", name: "Motor", shape: "cylinder", axis: "z", r: "MotorRadius", h: "MotorLength", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "PumpAxisY", z: "MotorZ", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "head", name: "Pump head", shape: "cylinder", axis: "z", r: "MotorRadius * 0.9", h: "HeadLength", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "PumpAxisY", z: "HeadZ", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "base-plate", name: "Base plate", shape: "box", w: "FrameLength", d: "Depth - 2 * RailSize", h: "0.012", x: "0", y: "RailHeight + 0.006", z: "0", basis: "inferred" },
    { id: "volute", name: "Pump volute scroll", shape: "prism", points: [[0.0, 0.78], [-0.175, 0.768], [-0.345, 0.717], [-0.501, 0.628], [-0.634, 0.506], [-0.738, 0.355], [-0.806, 0.184], [-0.835, 0.0], [-0.822, -0.188], [-0.766, -0.369], [-0.671, -0.535], [-0.54, -0.677], [-0.379, -0.788], [-0.196, -0.86], [-0.0, -0.89], [0.2, -0.875], [0.393, -0.816], [0.57, -0.714], [0.72, -0.575], [0.837, -0.403], [0.914, -0.209], [0.945, -0.0], [0.929, 0.212], [0.866, 0.417], [0.757, 0.604], [0.609, 0.763], [0.427, 0.887], [0.221, 0.967], [0.0, 1.0]], r: "MotorRadius * 1.35", h: "HeadLength * 0.45", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "PumpAxisY", z: "PumpStartZ + HeadLength * 0.2", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "motor-fins", name: "Motor cooling-fin ring", shape: "cylinder", axis: "z", r: "MotorRadius * 1.12", h: "MotorLength * 0.7", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "PumpAxisY", z: "MotorZ + MotorLength * 0.05", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "motor-box", name: "Motor terminal box", shape: "box", w: "MotorRadius * 0.9", d: "MotorLength * 0.25", h: "MotorRadius * 0.7", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "PumpAxisY + MotorRadius * 1.12 + MotorRadius * 0.3", z: "MotorZ", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "suction-branch", name: "Suction branch", shape: "cylinder", axis: "z", r: "ManifoldR * 0.7", h: "HeadLength * 0.5", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "PumpAxisY", z: "SuctionZ + HeadLength * 0.25", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "riser", name: "Discharge riser", shape: "cylinder", axis: "y", r: "ManifoldR * 0.7", h: "RiserLength", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "PumpAxisY + RiserLength / 2", z: "DischargeZ", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "check-valve", name: "Check valve", shape: "cylinder", axis: "y", r: "ManifoldR * 0.95", h: "0.12", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "PumpAxisY + RiserLength * 0.45", z: "DischargeZ", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "isolation-valve", name: "Isolation valve", shape: "cylinder", axis: "y", r: "ManifoldR * 0.95", h: "0.08", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "PumpAxisY + RiserLength * 0.75", z: "DischargeZ", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "manifold-suction", name: "Suction manifold", shape: "cylinder", axis: "x", r: "ManifoldR", h: "ManifoldLength", x: "0", y: "PumpAxisY", z: "SuctionZ", basis: "catalogue" },
    { id: "manifold-discharge", name: "Discharge manifold", shape: "cylinder", axis: "x", r: "ManifoldR", h: "ManifoldLength", x: "0", y: "DischargeY", z: "DischargeZ", basis: "catalogue" },
    { id: "flange-s-l", name: "Suction flange left", shape: "cylinder", axis: "x", r: "ManifoldR * 1.35", h: "FlangeT", x: "0 - ManifoldLength / 2 - FlangeT / 2", y: "PumpAxisY", z: "SuctionZ", basis: "inferred" },
    { id: "flange-s-r", name: "Suction flange right", shape: "cylinder", axis: "x", r: "ManifoldR * 1.35", h: "FlangeT", x: "ManifoldLength / 2 + FlangeT / 2", y: "PumpAxisY", z: "SuctionZ", basis: "inferred" },
    { id: "flange-d-l", name: "Discharge flange left", shape: "cylinder", axis: "x", r: "ManifoldR * 1.35", h: "FlangeT", x: "0 - ManifoldLength / 2 - FlangeT / 2", y: "DischargeY", z: "DischargeZ", basis: "inferred" },
    { id: "flange-d-r", name: "Discharge flange right", shape: "cylinder", axis: "x", r: "ManifoldR * 1.35", h: "FlangeT", x: "ManifoldLength / 2 + FlangeT / 2", y: "DischargeY", z: "DischargeZ", basis: "inferred" },
    { id: "bolts-s-l", name: "Suction flange left bolt", shape: "cylinder", axis: "x", r: "0.008", h: "FlangeT * 1.5", x: "0 - ManifoldLength / 2 - FlangeT / 4", y: "SuctionAxisH + ManifoldR * 1.1 * sind(K * 360 / FlangeBolts)", z: "SuctionZ + ManifoldR * 1.1 * cosd(K * 360 / FlangeBolts)", repeat: { count: "FlangeBolts" }, basis: "inferred" },
    { id: "bolts-s-r", name: "Suction flange right bolt", shape: "cylinder", axis: "x", r: "0.008", h: "FlangeT * 1.5", x: "ManifoldLength / 2 + FlangeT / 4", y: "SuctionAxisH + ManifoldR * 1.1 * sind(K * 360 / FlangeBolts)", z: "SuctionZ + ManifoldR * 1.1 * cosd(K * 360 / FlangeBolts)", repeat: { count: "FlangeBolts" }, basis: "inferred" },
    { id: "bolts-d-l", name: "Discharge flange left bolt", shape: "cylinder", axis: "x", r: "0.008", h: "FlangeT * 1.5", x: "0 - ManifoldLength / 2 - FlangeT / 4", y: "DischargeY + ManifoldR * 1.1 * sind(K * 360 / FlangeBolts)", z: "DischargeZ + ManifoldR * 1.1 * cosd(K * 360 / FlangeBolts)", repeat: { count: "FlangeBolts" }, basis: "inferred" },
    { id: "bolts-d-r", name: "Discharge flange right bolt", shape: "cylinder", axis: "x", r: "0.008", h: "FlangeT * 1.5", x: "ManifoldLength / 2 + FlangeT / 4", y: "DischargeY + ManifoldR * 1.1 * sind(K * 360 / FlangeBolts)", z: "DischargeZ + ManifoldR * 1.1 * cosd(K * 360 / FlangeBolts)", repeat: { count: "FlangeBolts" }, basis: "inferred" },
    { id: "valve-handle", name: "Isolation valve handle", shape: "box", w: "0.015", d: "0.14", h: "0.015", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "PumpAxisY + RiserLength * 0.75 + 0.06", z: "DischargeZ + 0.07", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "gauge-stem", name: "Pressure gauge stem", shape: "cylinder", axis: "y", r: "0.008", h: "GaugeStemH", x: "0", y: "DischargeY + ManifoldR + GaugeStemH / 2", z: "DischargeZ", basis: "inferred" },
    { id: "gauge-dial", name: "Pressure gauge dial", shape: "cylinder", axis: "z", r: "0.035", h: "0.02", x: "0", y: "GaugeDialY", z: "DischargeZ - 0.02", basis: "inferred" },
    { id: "motor-rib", name: "Motor cooling rib", shape: "cylinder", axis: "z", r: "MotorRadius * 1.25", h: "MotorLength * 0.05", x: "0 - ManifoldLength / 2 + (floor((K - 1) / FinCount) + 0.5) * ManifoldLength / Pumps", y: "PumpAxisY", z: "MotorZ - MotorLength * 0.38 + (K - FinCount * floor((K - 1) / FinCount) - 0.5) * MotorLength * 0.76 / FinCount", repeat: { count: "RibCount" }, basis: "inferred" },
    { id: "volute-neck", name: "Pump discharge neck", shape: "cylinder", axis: "y", r: "MotorRadius * 0.5", h: "MotorRadius * 1.6", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "PumpAxisY + MotorRadius * 1.5", z: "HeadZ", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "neck-flange", name: "Pump discharge flange", shape: "cylinder", axis: "y", r: "MotorRadius * 0.8", h: "0.02", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "PumpAxisY + MotorRadius * 1.5 + MotorRadius * 0.8 + 0.01", z: "HeadZ", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "valve-gear", name: "Valve gear housing", shape: "box", w: "0.06", d: "0.06", h: "0.06", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "PumpAxisY + RiserLength * 0.75", z: "DischargeZ - ManifoldR * 0.95 - 0.03", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "valve-stem", name: "Valve operating stem", shape: "cylinder", axis: "z", r: "0.012", h: "0.1", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "PumpAxisY + RiserLength * 0.75", z: "DischargeZ - ManifoldR * 0.95 - 0.11", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "valve-wheel", name: "Valve handwheel", shape: "cylinder", axis: "z", r: "0.045", h: "0.01", x: "0 - ManifoldLength / 2 + (K - 0.5) * ManifoldLength / Pumps", y: "PumpAxisY + RiserLength * 0.75", z: "DischargeZ - ManifoldR * 0.95 - 0.165", repeat: { count: "Pumps" }, basis: "inferred" },
    { id: "saddle", name: "Suction manifold saddle", shape: "box", w: "0.05", d: "ManifoldR * 2.2", h: "PumpAxisY - RailHeight - 0.012", x: "0 - ManifoldLength / 2 + K * ManifoldLength / Pumps", y: "RailHeight + 0.012 + (PumpAxisY - RailHeight - 0.012) / 2", z: "SuctionZ", repeat: { count: "SaddleCount" }, basis: "inferred" },
    { id: "post", name: "Panel rack post", shape: "cylinder", axis: "y", r: "0.022", h: "PanelBottomY - RailHeight", x: "(K - 2) * PanelW * 0.33", y: "RailHeight + (PanelBottomY - RailHeight) / 2", z: "0 - Depth / 2 + 0.04", repeat: { count: "PostCount" }, basis: "inferred" },
    { id: "door-seam", name: "Panel door seam", shape: "box", w: "0.004", d: "0.004", h: "PanelH", x: "(K - 1.5) * PanelW * 0.34", y: "Height - PanelH / 2", z: "PanelFrontZ + 0.002", repeat: { count: "SeamCount" }, basis: "inferred" },
    { id: "hmi-window", name: "Panel display window", shape: "box", w: "PanelW * 0.13", d: "0.006", h: "PanelH * 0.19", x: "PanelW * 0.055", y: "Height - PanelH * 0.28", z: "PanelFrontZ + 0.003", basis: "inferred" },
    { id: "panel", name: "Control panel", shape: "box", w: "PanelW", d: "PanelD", h: "PanelH", x: "0", y: "Height - PanelH / 2", z: "0 - Depth / 2 + PanelD / 2", basis: "catalogue" },
  ],
};

export const TEMPLATES: Record<string, PartTemplate> = {
  box: BOX_TEMPLATE,
  cabinet: CABINET_TEMPLATE,
  table: TABLE_TEMPLATE,
  shelf: SHELF_TEMPLATE,
  booster: BOOSTER_TEMPLATE,
};

const SHELF_WORDS = /\b(shelf|shelves|shelving|bookcase|bookshelf|rack|racking)\b/i;
const TABLE_WORDS = /\b(table|desk|counter|bench|workbench)\b/i;

const CABINET_WORDS = /\b(cabinet|case|fridge|refrigerator|freezer|display|merchandiser|cooler|chiller|locker|cupboard|wardrobe|drawer|drawers|sideboard|dresser|credenza)\b/i;

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
