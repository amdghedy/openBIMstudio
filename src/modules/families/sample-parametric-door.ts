/**
 * Sample parametric door family - demonstrates formulas, constraints,
 * conditional geometry, and arrays. Seed this via familyStore.create()
 * or merge into createBuiltInFamilies().
 */

import type { FamilyDefinition } from "./types";
import type { ExtendedGeometrySpec } from "./types-extended";
import type { Constraint } from "./constraint-graph";

const REF = (name: string) => ({ ref: name });
const CONST = (n: number) => ({ const: n });

export const PARAMETRIC_DOOR_CONSTRAINTS: Constraint[] = [
  // Panel height tracks overall height minus frame
  { kind: "offset", a: "PanelHeight", b: "Height", delta: -0.08, priority: 10 },
  // Panel width tracks leaf count
  // (formula also handles this; constraint is a safety net)
  { kind: "ratio", a: "MullionSpacing", b: "Width", k: 0.5, priority: 5 },
];

export function createParametricDoorFamily(): FamilyDefinition {
  const geometry: any = {
    kind: "composed",
    parts: [
      // Outer frame (extruded rectangle with hole for leaf)
      {
        kind: "extrusion",
        profile: { kind: "rect", w: REF("Width"), h: REF("Height") },
        depth: REF("FrameDepth"),
        holes: [
          {
            kind: "rect",
            w: REF("OpeningWidth"),
            h: REF("OpeningHeight"),
          },
        ],
      },
      // Single leaf
      {
        kind: "conditional",
        when: "IsSingle",
        then: {
          kind: "box",
          w: REF("PanelWidth"),
          d: REF("PanelThickness"),
          h: REF("PanelHeight"),
          transform: {
            translate: [CONST(0), CONST(0), REF("PanelOffset")],
          },
        },
      },
      // Double leaf - left
      {
        kind: "conditional",
        when: "IsDouble",
        then: {
          kind: "box",
          w: REF("HalfPanelWidth"),
          d: REF("PanelThickness"),
          h: REF("PanelHeight"),
          transform: {
            translate: [REF("LeftPanelX"), CONST(0), REF("PanelOffset")],
          },
        },
      },
      // Double leaf - right
      {
        kind: "conditional",
        when: "IsDouble",
        then: {
          kind: "box",
          w: REF("HalfPanelWidth"),
          d: REF("PanelThickness"),
          h: REF("PanelHeight"),
          transform: {
            translate: [REF("RightPanelX"), CONST(0), REF("PanelOffset")],
          },
        },
      },
      // Optional vision panel (glazed rectangle on leaf)
      {
        kind: "conditional",
        when: "HasVision",
        then: {
          kind: "box",
          w: REF("VisionWidth"),
          d: CONST(0.02),
          h: REF("VisionHeight"),
          transform: {
            translate: [CONST(0), CONST(0), REF("VisionZ")],
          },
        },
      },
      // Handle cylinder
      {
        kind: "cylinder",
        r: CONST(0.015),
        h: CONST(0.08),
        transform: {
          translate: [REF("HandleX"), CONST(0), REF("HandleZ")],
          rotate: [CONST(Math.PI / 2), CONST(0), CONST(0)],
        },
      },
    ],
  };

  return {
    id: "parametric-door-v1",
    name: "Parametric Door",
    category: "door",
    ifcEntity: "IfcDoor",
    schemaVersion: 2,
    sourceElementType: "door",
    builtIn: true,
    group: "Architecture",
    parameters: [
      // -- Dimensions ----------------------------------------------
      {
        name: "Width",
        type: "length",
        scope: "type",
        default: 0.9,
        editable: true,
        min: 0.5,
        max: 3.0,
        unit: "m",
        group: "Dimensions",
        description: "Overall door width",
      },
      {
        name: "Height",
        type: "length",
        scope: "type",
        default: 2.1,
        editable: true,
        min: 1.8,
        max: 3.5,
        unit: "m",
        group: "Dimensions",
      },
      {
        name: "FrameDepth",
        type: "length",
        scope: "type",
        default: 0.1,
        editable: true,
        min: 0.05,
        max: 0.3,
        unit: "m",
        group: "Dimensions",
      },
      {
        name: "PanelThickness",
        type: "length",
        scope: "type",
        default: 0.04,
        editable: true,
        min: 0.02,
        max: 0.08,
        unit: "m",
        group: "Dimensions",
      },
      {
        name: "SillHeight",
        type: "length",
        scope: "instance",
        default: 0,
        editable: true,
        min: 0,
        max: 0.3,
        unit: "m",
        group: "Placement",
      },

      // -- Configuration -------------------------------------------
      {
        name: "LeafCount",
        type: "integer",
        scope: "type",
        default: 1,
        editable: true,
        min: 1,
        max: 2,
        group: "Configuration",
        description: "1 = single, 2 = double",
      },
      {
        name: "IsSingle",
        type: "boolean",
        scope: "type",
        default: true,
        editable: false,
        formula: "= eq(LeafCount, 1)",
        group: "Configuration",
      },
      {
        name: "IsDouble",
        type: "boolean",
        scope: "type",
        default: false,
        editable: false,
        formula: "= eq(LeafCount, 2)",
        group: "Configuration",
      },
      {
        name: "HasVision",
        type: "boolean",
        scope: "type",
        default: false,
        editable: true,
        group: "Configuration",
      },

      // -- Derived (formulas) --------------------------------------
      {
        name: "OpeningWidth",
        type: "length",
        scope: "type",
        default: 0.82,
        editable: false,
        formula: "= Width - 0.08",
        group: "Derived",
      },
      {
        name: "OpeningHeight",
        type: "length",
        scope: "type",
        default: 2.02,
        editable: false,
        formula: "= Height - 0.08",
        group: "Derived",
      },
      {
        name: "PanelWidth",
        type: "length",
        scope: "type",
        default: 0.82,
        editable: false,
        formula: "= OpeningWidth",
        group: "Derived",
      },
      {
        name: "PanelHeight",
        type: "length",
        scope: "type",
        default: 2.02,
        editable: false,
        formula: "= OpeningHeight",
        group: "Derived",
      },
      {
        name: "HalfPanelWidth",
        type: "length",
        scope: "type",
        default: 0.41,
        editable: false,
        formula: "= OpeningWidth / 2 - 0.01",
        group: "Derived",
      },
      {
        name: "LeftPanelX",
        type: "length",
        scope: "type",
        default: -0.21,
        editable: false,
        formula: "= -HalfPanelWidth / 2 - 0.01",
        group: "Derived",
      },
      {
        name: "RightPanelX",
        type: "length",
        scope: "type",
        default: 0.21,
        editable: false,
        formula: "= HalfPanelWidth / 2 + 0.01",
        group: "Derived",
      },
      {
        name: "PanelOffset",
        type: "length",
        scope: "type",
        default: 0,
        editable: false,
        formula: "= 0",
        group: "Derived",
      },
      {
        name: "VisionWidth",
        type: "length",
        scope: "type",
        default: 0.4,
        editable: false,
        formula: "= min(PanelWidth * 0.5, 0.5)",
        group: "Derived",
      },
      {
        name: "VisionHeight",
        type: "length",
        scope: "type",
        default: 0.6,
        editable: false,
        formula: "= min(PanelHeight * 0.35, 0.8)",
        group: "Derived",
      },
      {
        name: "VisionZ",
        type: "length",
        scope: "type",
        default: 0.4,
        editable: false,
        formula: "= PanelHeight * 0.55",
        group: "Derived",
      },
      {
        name: "HandleX",
        type: "length",
        scope: "type",
        default: 0.35,
        editable: false,
        formula: "= if(IsDouble, RightPanelX + HalfPanelWidth * 0.35, PanelWidth * 0.4)",
        group: "Derived",
      },
      {
        name: "HandleZ",
        type: "length",
        scope: "type",
        default: 1.0,
        editable: false,
        formula: "= 1.0",
        group: "Derived",
      },

      // -- Reporting (schedules) ------------------------------------
      {
        name: "Report_Area",
        type: "area",
        scope: "type",
        default: 0,
        editable: false,
        formula: "= Width * Height",
        group: "Reporting",
        unit: "m-",
      },
      {
        name: "Report_LeafArea",
        type: "area",
        scope: "type",
        default: 0,
        editable: false,
        formula: "= if(IsDouble, OpeningWidth * OpeningHeight, PanelWidth * PanelHeight)",
        group: "Reporting",
        unit: "m-",
      },
    ],
    geometry,
    types: [
      {
        id: "door-900x2100",
        name: "900 - 2100 Single",
        values: { Width: 0.9, Height: 2.1, LeafCount: 1 },
      },
      {
        id: "door-1000x2100",
        name: "1000 - 2100 Single",
        values: { Width: 1.0, Height: 2.1, LeafCount: 1 },
      },
      {
        id: "door-1800x2100-dbl",
        name: "1800 - 2100 Double",
        values: { Width: 1.8, Height: 2.1, LeafCount: 2 },
      },
      {
        id: "door-900x2100-vision",
        name: "900 - 2100 with Vision",
        values: { Width: 0.9, Height: 2.1, LeafCount: 1, HasVision: true },
      },
    ],
  };
}
