/**
 * scripts/seed-families.mjs
 *
 * Generates a seed family library: 50+ parametric FamilyDefinition JSON
 * files under public/families/<category>/<name>.json, plus an index.json
 * listing every family for the runtime library-loader to discover.
 *
 * Output schema matches `FamilyDefinition` from
 * `src/modules/families/types.ts` — generated files are valid input to
 * `familyStore.create()` and the parametric engine's `buildGeometry()`.
 *
 * Run:  node scripts/seed-families.mjs
 * Idempotent: overwrites existing files; safe to re-run after schema changes.
 */

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "public", "families");

// ─── helpers (mirrors builtin-families.ts patterns) ─────────────────────
const REF = (name) => ({ ref: name });
const CONST = (n) => ({ const: n });
const EXPR = (s) => ({ expr: s });

let seq = 0;
function uid(prefix) {
  seq += 1;
  return `seed-${prefix}-${String(seq).padStart(3, "0")}`;
}

/** Length-type parameter. */
function L(name, def, opts = {}) {
  return {
    name,
    type: "length",
    scope: opts.scope ?? "type",
    default: def,
    editable: opts.editable ?? true,
    step: opts.step ?? 0.05,
    unit: "m",
    group: opts.group ?? "Dimensions",
    ...(opts.label ? { label: opts.label } : {}),
  };
}

/** Computed parameter (formula-driven, non-editable). */
function C(name, formula, opts = {}) {
  return {
    name,
    type: opts.type ?? "number",
    scope: opts.scope ?? "instance",
    default: 0,
    editable: false,
    formula: `= ${formula}`,
    group: opts.group ?? "Computed",
    ...(opts.unit ? { unit: opts.unit } : {}),
  };
}

/** Type-scope integer. */
function I(name, def, opts = {}) {
  return {
    name,
    type: "integer",
    scope: opts.scope ?? "type",
    default: def,
    editable: opts.editable ?? true,
    step: 1,
    group: opts.group ?? "Dimensions",
  };
}

/** Text parameter. */
function T(name, def, opts = {}) {
  return {
    name,
    type: "text",
    scope: opts.scope ?? "type",
    default: def,
    editable: opts.editable ?? true,
    group: opts.group ?? "Identity Data",
  };
}

// ─── family templates ───────────────────────────────────────────────────

/** A typical interior / exterior door. Geometry: thin box (panel). */
function makeDoor(name, types, opts = {}) {
  return {
    id: uid("door"),
    name,
    category: "door",
    ifcEntity: "IfcDoor",
    schemaVersion: 1,
    sourceElementType: "door",
    builtIn: false,
    group: "Doors",
    parameters: [
      L("width", 0.9, { scope: "type" }),
      L("height", 2.1, { scope: "type" }),
      L("frameThickness", 0.06, { scope: "type", label: "Frame Thickness", group: "Construction", step: 0.005 }),
      L("sillHeight", 0.0, { scope: "instance", group: "Constraints" }),
      L("offsetAlongHost", 0.0, { scope: "instance", group: "Constraints" }),
      T("fireRating", "None", { group: "Identity Data" }),
      C("panelArea", "width * height", { type: "area", unit: "m2" }),
    ],
    geometry: {
      kind: "box",
      w: REF("width"),
      d: CONST(0.04),
      h: REF("height"),
      transform: { translate: [CONST(0), REF("sillHeight"), CONST(0)] },
    },
    types: types.map((t, i) => ({
      id: uid(`door-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i + 1}`),
      name: t.name,
      values: t.values,
    })),
    ...(opts.description ? { description: opts.description } : {}),
  };
}

/** Window: thin extruded panel with optional sill height. */
function makeWindow(name, types, opts = {}) {
  return {
    id: uid("window"),
    name,
    category: "window",
    ifcEntity: "IfcWindow",
    schemaVersion: 1,
    sourceElementType: "window",
    builtIn: false,
    group: "Windows",
    parameters: [
      L("width", 1.2, { scope: "type" }),
      L("height", 1.4, { scope: "type" }),
      L("frameThickness", 0.05, { scope: "type", label: "Frame Thickness", group: "Construction", step: 0.005 }),
      L("sillHeight", 0.9, { scope: "instance", group: "Constraints" }),
      L("offsetAlongHost", 0.0, { scope: "instance", group: "Constraints" }),
      C("glazingArea", "width * height", { type: "area", unit: "m2" }),
    ],
    geometry: {
      kind: "box",
      w: REF("width"),
      d: CONST(0.03),
      h: REF("height"),
      transform: { translate: [CONST(0), REF("sillHeight"), CONST(0)] },
    },
    types: types.map((t, i) => ({
      id: uid(`window-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i + 1}`),
      name: t.name,
      values: t.values,
    })),
  };
}

/** Plumbing fixture: floor-mounted box (toilet, sink, urinal, etc.). */
function makePlumbingFixture(name, types, opts = {}) {
  return {
    id: uid("plumbing"),
    name,
    category: "equipment",
    ifcEntity: opts.ifcEntity ?? "IfcSanitaryTerminal",
    schemaVersion: 1,
    sourceElementType: "equipment",
    builtIn: false,
    group: "Plumbing Fixtures",
    parameters: [
      L("width", 0.4, { scope: "type", label: "Width" }),
      L("depth", 0.6, { scope: "type", label: "Depth" }),
      L("height", 0.4, { scope: "type", label: "Height" }),
      L("elevation", 0.0, { scope: "instance", group: "Constraints" }),
      T("connectionSize", "DN 15", { group: "Mechanical" }),
      C("footprint", "width * depth", { type: "area", unit: "m2" }),
    ],
    geometry: {
      kind: "box",
      w: REF("width"),
      d: REF("depth"),
      h: REF("height"),
      transform: { translate: [CONST(0), REF("elevation"), CONST(0)] },
    },
    types: types.map((t, i) => ({
      id: uid(`plumb-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i + 1}`),
      name: t.name,
      values: t.values,
    })),
  };
}

/** Lighting fixture: ceiling-mounted box/cylinder. */
function makeLightingFixture(name, types, opts = {}) {
  return {
    id: uid("lighting"),
    name,
    category: "equipment",
    ifcEntity: "IfcLightFixture",
    schemaVersion: 1,
    sourceElementType: "equipment",
    builtIn: false,
    group: "Lighting Fixtures",
    parameters: [
      L("width", 0.6, { scope: "type" }),
      L("depth", 0.6, { scope: "type" }),
      L("height", 0.1, { scope: "type" }),
      L("elevation", 2.7, { scope: "instance", group: "Constraints" }),
      I("lumens", 800, { group: "Electrical" }),
      T("colorTemp", "4000K", { group: "Electrical" }),
      C("footprint", "width * depth", { type: "area", unit: "m2" }),
    ],
    geometry: {
      kind: "box",
      w: REF("width"),
      d: REF("depth"),
      h: REF("height"),
      transform: { translate: [CONST(0), REF("elevation"), CONST(0)] },
    },
    types: types.map((t, i) => ({
      id: uid(`light-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i + 1}`),
      name: t.name,
      values: t.values,
    })),
  };
}

/** Electrical fixture / device: wall-mounted small box. */
function makeElectricalFixture(name, types, opts = {}) {
  return {
    id: uid("elec"),
    name,
    category: "equipment",
    ifcEntity: opts.ifcEntity ?? "IfcElectricAppliance",
    schemaVersion: 1,
    sourceElementType: "equipment",
    builtIn: false,
    group: "Electrical Fixtures",
    parameters: [
      L("width", 0.1, { scope: "type" }),
      L("depth", 0.05, { scope: "type" }),
      L("height", 0.1, { scope: "type" }),
      L("elevation", 1.3, { scope: "instance", group: "Constraints" }),
      I("voltage", 230, { group: "Electrical" }),
      T("circuitType", "Lighting", { group: "Electrical" }),
    ],
    geometry: {
      kind: "box",
      w: REF("width"),
      d: REF("depth"),
      h: REF("height"),
      transform: { translate: [CONST(0), REF("elevation"), CONST(0)] },
    },
    types: types.map((t, i) => ({
      id: uid(`elec-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i + 1}`),
      name: t.name,
      values: t.values,
    })),
  };
}

/** Furniture: floor-mounted box. */
function makeFurniture(name, types, opts = {}) {
  return {
    id: uid("furn"),
    name,
    category: "generic",
    ifcEntity: opts.ifcEntity ?? "IfcFurnishingElement",
    schemaVersion: 1,
    sourceElementType: "equipment",
    builtIn: false,
    group: "Furniture",
    parameters: [
      L("width", 0.8, { scope: "type" }),
      L("depth", 0.6, { scope: "type" }),
      L("height", 0.45, { scope: "type" }),
      L("elevation", 0.0, { scope: "instance", group: "Constraints" }),
      C("footprint", "width * depth", { type: "area", unit: "m2" }),
      C("volume", "width * depth * height", { type: "volume", unit: "m3" }),
    ],
    geometry: {
      kind: "box",
      w: REF("width"),
      d: REF("depth"),
      h: REF("height"),
      transform: { translate: [CONST(0), REF("elevation"), CONST(0)] },
    },
    types: types.map((t, i) => ({
      id: uid(`furn-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i + 1}`),
      name: t.name,
      values: t.values,
    })),
  };
}

/** Mechanical equipment: AHU, pump, fan — box with electrical + mechanical metadata. */
function makeMechanicalEquipment(name, types, opts = {}) {
  return {
    id: uid("mech"),
    name,
    category: "equipment",
    ifcEntity: "IfcMechanicalAppliance",
    schemaVersion: 1,
    sourceElementType: "equipment",
    builtIn: false,
    group: "Mechanical Equipment",
    parameters: [
      L("width", 1.0, { scope: "type" }),
      L("depth", 0.8, { scope: "type" }),
      L("height", 0.9, { scope: "type" }),
      L("elevation", 0.0, { scope: "instance", group: "Constraints" }),
      I("powerWatts", 1500, { group: "Electrical" }),
      I("voltage", 230, { group: "Electrical" }),
      T("connectionSize", "DN 50", { group: "Mechanical" }),
      C("footprint", "width * depth", { type: "area", unit: "m2" }),
      C("volume", "width * depth * height", { type: "volume", unit: "m3" }),
    ],
    geometry: {
      kind: "box",
      w: REF("width"),
      d: REF("depth"),
      h: REF("height"),
      transform: { translate: [CONST(0), REF("elevation"), CONST(0)] },
    },
    types: types.map((t, i) => ({
      id: uid(`mech-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${i + 1}`),
      name: t.name,
      values: t.values,
    })),
  };
}

// ─── the family catalog (50+ families across 7 categories) ──────────────

const families = [];

// === Doors (8 families, ~24 types) =====================================
families.push(makeDoor("Single Flush Door", [
  { name: "800 x 2100", values: { width: 0.8, height: 2.1 } },
  { name: "900 x 2100", values: { width: 0.9, height: 2.1 } },
  { name: "1000 x 2100", values: { width: 1.0, height: 2.1 } },
]));
families.push(makeDoor("Double Door", [
  { name: "1600 x 2100", values: { width: 1.6, height: 2.1 } },
  { name: "1800 x 2100", values: { width: 1.8, height: 2.1 } },
  { name: "2000 x 2100", values: { width: 2.0, height: 2.1 } },
]));
families.push(makeDoor("Interior Door 2100mm", [
  { name: "750 x 2100", values: { width: 0.75, height: 2.1 } },
  { name: "850 x 2100", values: { width: 0.85, height: 2.1 } },
]));
families.push(makeDoor("Tall Door 2400mm", [
  { name: "900 x 2400", values: { width: 0.9, height: 2.4 } },
  { name: "1000 x 2400", values: { width: 1.0, height: 2.4 } },
]));
families.push(makeDoor("Fire Door EI30", [
  { name: "900 x 2100 EI30", values: { width: 0.9, height: 2.1, fireRating: "EI30" } },
  { name: "1000 x 2100 EI30", values: { width: 1.0, height: 2.1, fireRating: "EI30" } },
]));
families.push(makeDoor("Fire Door EI60", [
  { name: "900 x 2100 EI60", values: { width: 0.9, height: 2.1, fireRating: "EI60" } },
  { name: "1000 x 2100 EI60", values: { width: 1.0, height: 2.1, fireRating: "EI60" } },
]));
families.push(makeDoor("Sliding Glass Door", [
  { name: "1800 x 2100 Sliding", values: { width: 1.8, height: 2.1, frameThickness: 0.08 } },
  { name: "2400 x 2100 Sliding", values: { width: 2.4, height: 2.1, frameThickness: 0.08 } },
]));
families.push(makeDoor("Pocket Door", [
  { name: "800 x 2100 Pocket", values: { width: 0.8, height: 2.1 } },
  { name: "900 x 2100 Pocket", values: { width: 0.9, height: 2.1 } },
]));

// === Windows (8 families, ~22 types) ===================================
families.push(makeWindow("Casement Window", [
  { name: "600 x 1200", values: { width: 0.6, height: 1.2 } },
  { name: "900 x 1200", values: { width: 0.9, height: 1.2 } },
  { name: "1200 x 1400", values: { width: 1.2, height: 1.4 } },
]));
families.push(makeWindow("Sliding Window", [
  { name: "1200 x 1200", values: { width: 1.2, height: 1.2 } },
  { name: "1800 x 1200", values: { width: 1.8, height: 1.2 } },
  { name: "2400 x 1400", values: { width: 2.4, height: 1.4 } },
]));
families.push(makeWindow("Fixed Glazing", [
  { name: "1000 x 1000", values: { width: 1.0, height: 1.0 } },
  { name: "1500 x 1000", values: { width: 1.5, height: 1.0 } },
  { name: "2000 x 1500", values: { width: 2.0, height: 1.5 } },
]));
families.push(makeWindow("Awning Window", [
  { name: "600 x 600 Awning", values: { width: 0.6, height: 0.6 } },
  { name: "900 x 600 Awning", values: { width: 0.9, height: 0.6 } },
]));
families.push(makeWindow("Curtain Wall Window", [
  { name: "1500 x 2700", values: { width: 1.5, height: 2.7 } },
  { name: "3000 x 2700", values: { width: 3.0, height: 2.7 } },
]));
families.push(makeWindow("Pivot Window", [
  { name: "1000 x 1500 Pivot", values: { width: 1.0, height: 1.5 } },
  { name: "1200 x 1800 Pivot", values: { width: 1.2, height: 1.8 } },
]));
families.push(makeWindow("Skylight", [
  { name: "600 x 600 Skylight", values: { width: 0.6, height: 0.6 } },
  { name: "900 x 900 Skylight", values: { width: 0.9, height: 0.9 } },
]));
families.push(makeWindow("Bay Window", [
  { name: "1800 x 1400 Bay", values: { width: 1.8, height: 1.4 } },
  { name: "2400 x 1400 Bay", values: { width: 2.4, height: 1.4 } },
]));

// === Plumbing Fixtures (8 families, ~18 types) ==========================
families.push(makePlumbingFixture("Wall-Hung Toilet", [
  { name: "Standard 360 x 540", values: { width: 0.36, depth: 0.54, height: 0.4 } },
]));
families.push(makePlumbingFixture("Floor-Mounted Toilet", [
  { name: "Standard 400 x 700", values: { width: 0.4, depth: 0.7, height: 0.75 } },
]));
families.push(makePlumbingFixture("Wall Urinal", [
  { name: "Standard 350 x 400", values: { width: 0.35, depth: 0.4, height: 0.6, elevation: 0.6 } },
]));
families.push(makePlumbingFixture("Pedestal Sink", [
  { name: "500 x 600", values: { width: 0.5, depth: 0.6, height: 0.85 } },
  { name: "600 x 500", values: { width: 0.6, depth: 0.5, height: 0.85 } },
]));
families.push(makePlumbingFixture("Countertop Sink", [
  { name: "Oval 500 x 350", values: { width: 0.5, depth: 0.35, height: 0.15, elevation: 0.85 } },
  { name: "Rectangular 600 x 400", values: { width: 0.6, depth: 0.4, height: 0.15, elevation: 0.85 } },
]));
families.push(makePlumbingFixture("Shower Tray", [
  { name: "800 x 800", values: { width: 0.8, depth: 0.8, height: 0.05 } },
  { name: "900 x 1200", values: { width: 0.9, depth: 1.2, height: 0.05 } },
  { name: "1000 x 1000", values: { width: 1.0, depth: 1.0, height: 0.05 } },
]));
families.push(makePlumbingFixture("Bathtub", [
  { name: "1700 x 750 Standard", values: { width: 1.7, depth: 0.75, height: 0.55 } },
  { name: "1800 x 800 Large", values: { width: 1.8, depth: 0.8, height: 0.55 } },
]));
families.push(makePlumbingFixture("Janitor Sink", [
  { name: "500 x 500", values: { width: 0.5, depth: 0.5, height: 0.85 } },
]));

// === Lighting Fixtures (8 families, ~16 types) =========================
families.push(makeLightingFixture("Recessed Downlight", [
  { name: "100mm Round", values: { width: 0.1, depth: 0.1, height: 0.08, lumens: 600 } },
  { name: "150mm Round", values: { width: 0.15, depth: 0.15, height: 0.08, lumens: 900 } },
  { name: "200mm Round", values: { width: 0.2, depth: 0.2, height: 0.08, lumens: 1200 } },
]));
families.push(makeLightingFixture("Surface Mounted LED Panel", [
  { name: "600 x 600", values: { width: 0.6, depth: 0.6, height: 0.04, lumens: 3000 } },
  { name: "1200 x 300", values: { width: 1.2, depth: 0.3, height: 0.04, lumens: 2800 } },
]));
families.push(makeLightingFixture("Pendant Lamp", [
  { name: "Small 200 x 250", values: { width: 0.2, depth: 0.2, height: 0.25, elevation: 2.4, lumens: 600 } },
  { name: "Large 300 x 350", values: { width: 0.3, depth: 0.3, height: 0.35, elevation: 2.4, lumens: 900 } },
]));
families.push(makeLightingFixture("Wall Sconce", [
  { name: "200 x 80", values: { width: 0.2, depth: 0.08, height: 0.15, elevation: 1.7, lumens: 400 } },
]));
families.push(makeLightingFixture("Track Spotlight", [
  { name: "Single 80 x 100", values: { width: 0.08, depth: 0.1, height: 0.15, elevation: 2.7, lumens: 500 } },
  { name: "Triple 80 x 300", values: { width: 0.08, depth: 0.3, height: 0.15, elevation: 2.7, lumens: 1500 } },
]));
families.push(makeLightingFixture("Emergency Exit Sign", [
  { name: "300 x 100", values: { width: 0.3, depth: 0.05, height: 0.1, elevation: 2.2, lumens: 60, colorTemp: "Green LED" } },
]));
families.push(makeLightingFixture("High Bay Light", [
  { name: "300 x 300 Industrial", values: { width: 0.3, depth: 0.3, height: 0.25, elevation: 6.0, lumens: 15000 } },
  { name: "400 x 400 Industrial", values: { width: 0.4, depth: 0.4, height: 0.3, elevation: 8.0, lumens: 25000 } },
]));
families.push(makeLightingFixture("Street Light", [
  { name: "Pole-Mount 600 x 200", values: { width: 0.6, depth: 0.2, height: 0.15, elevation: 5.0, lumens: 9000 } },
]));

// === Electrical Fixtures (6 families, ~14 types) =======================
families.push(makeElectricalFixture("Single Socket", [
  { name: "1-Gang", values: { width: 0.086, depth: 0.086, height: 0.086, elevation: 0.3 } },
  { name: "2-Gang", values: { width: 0.146, depth: 0.086, height: 0.086, elevation: 0.3 } },
]));
families.push(makeElectricalFixture("Double Socket", [
  { name: "2-Gang Double", values: { width: 0.146, depth: 0.086, height: 0.146, elevation: 0.3 } },
]));
families.push(makeElectricalFixture("Light Switch", [
  { name: "1-Way", values: { width: 0.086, depth: 0.086, height: 0.086, elevation: 1.3, circuitType: "Switch" } },
  { name: "2-Way", values: { width: 0.146, depth: 0.086, height: 0.086, elevation: 1.3, circuitType: "Switch" } },
]));
families.push(makeElectricalFixture("Data Outlet", [
  { name: "RJ45 Single", values: { width: 0.086, depth: 0.086, height: 0.086, elevation: 0.3, circuitType: "Data" } },
  { name: "RJ45 Double", values: { width: 0.146, depth: 0.086, height: 0.086, elevation: 0.3, circuitType: "Data" } },
]));
families.push(makeElectricalFixture("Distribution Board", [
  { name: "12-Way DB", values: { width: 0.4, depth: 0.12, height: 0.5, elevation: 1.6, circuitType: "Distribution" } },
  { name: "24-Way DB", values: { width: 0.6, depth: 0.12, height: 0.7, elevation: 1.6, circuitType: "Distribution" } },
]));
families.push(makeElectricalFixture("Ceiling Sensor", [
  { name: "PIR 100 x 100", values: { width: 0.1, depth: 0.1, height: 0.04, elevation: 2.7, circuitType: "Sensor" } },
]));

// === Furniture (8 families, ~18 types) =================================
families.push(makeFurniture("Office Desk", [
  { name: "1200 x 600", values: { width: 1.2, depth: 0.6, height: 0.74 } },
  { name: "1600 x 800", values: { width: 1.6, depth: 0.8, height: 0.74 } },
  { name: "1800 x 800", values: { width: 1.8, depth: 0.8, height: 0.74 } },
]));
families.push(makeFurniture("Office Chair", [
  { name: "Task Chair", values: { width: 0.65, depth: 0.65, height: 1.0 } },
  { name: "Executive Chair", values: { width: 0.7, depth: 0.7, height: 1.15 } },
]));
families.push(makeFurniture("Dining Table", [
  { name: "4-Seater 1200 x 800", values: { width: 1.2, depth: 0.8, height: 0.75 } },
  { name: "6-Seater 1800 x 900", values: { width: 1.8, depth: 0.9, height: 0.75 } },
  { name: "8-Seater 2400 x 1000", values: { width: 2.4, depth: 1.0, height: 0.75 } },
]));
families.push(makeFurniture("Side Chair", [
  { name: "Dining Chair", values: { width: 0.45, depth: 0.5, height: 0.85 } },
  { name: "Stacking Chair", values: { width: 0.45, depth: 0.5, height: 0.8 } },
]));
families.push(makeFurniture("Bookshelf", [
  { name: "800 x 350 x 1800", values: { width: 0.8, depth: 0.35, height: 1.8 } },
  { name: "1200 x 350 x 2000", values: { width: 1.2, depth: 0.35, height: 2.0 } },
]));
families.push(makeFurniture("Wardrobe", [
  { name: "600 x 600 x 2000", values: { width: 0.6, depth: 0.6, height: 2.0 } },
  { name: "1000 x 600 x 2000", values: { width: 1.0, depth: 0.6, height: 2.0 } },
  { name: "1800 x 600 x 2000", values: { width: 1.8, depth: 0.6, height: 2.0 } },
]));
families.push(makeFurniture("Bed", [
  { name: "Single 900 x 1900", values: { width: 0.9, depth: 1.9, height: 0.45 } },
  { name: "Double 1400 x 1900", values: { width: 1.4, depth: 1.9, height: 0.45 } },
  { name: "Queen 1520 x 2030", values: { width: 1.52, depth: 2.03, height: 0.5 } },
  { name: "King 1800 x 2030", values: { width: 1.8, depth: 2.03, height: 0.5 } },
]));
families.push(makeFurniture("Sofa", [
  { name: "2-Seater 1500", values: { width: 1.5, depth: 0.9, height: 0.85 } },
  { name: "3-Seater 2000", values: { width: 2.0, depth: 0.9, height: 0.85 } },
  { name: "L-Shape 2600 x 1800", values: { width: 2.6, depth: 1.8, height: 0.85 } },
]));

// === Mechanical Equipment (8 families, ~16 types) =====================
families.push(makeMechanicalEquipment("Air Handling Unit (AHU)", [
  { name: "Small 1000 x 800 x 900", values: { width: 1.0, depth: 0.8, height: 0.9, powerWatts: 750 } },
  { name: "Medium 2000 x 1000 x 1500", values: { width: 2.0, depth: 1.0, height: 1.5, powerWatts: 2200 } },
  { name: "Large 3000 x 1200 x 2000", values: { width: 3.0, depth: 1.2, height: 2.0, powerWatts: 5500 } },
]));
families.push(makeMechanicalEquipment("Fan Coil Unit (FCU)", [
  { name: "600 x 600 Ceiling", values: { width: 0.6, depth: 0.6, height: 0.25, elevation: 2.7, powerWatts: 80 } },
  { name: "1200 x 600 Ceiling", values: { width: 1.2, depth: 0.6, height: 0.25, elevation: 2.7, powerWatts: 150 } },
]));
families.push(makeMechanicalEquipment("Circulation Pump", [
  { name: "Small 200 x 300", values: { width: 0.2, depth: 0.3, height: 0.3, powerWatts: 90 } },
  { name: "Medium 300 x 400", values: { width: 0.3, depth: 0.4, height: 0.4, powerWatts: 350 } },
]));
families.push(makeMechanicalEquipment("Boiler", [
  { name: "Residential 600 x 500", values: { width: 0.6, depth: 0.5, height: 0.9, powerWatts: 24000 } },
  { name: "Commercial 800 x 700", values: { width: 0.8, depth: 0.7, height: 1.5, powerWatts: 80000 } },
]));
families.push(makeMechanicalEquipment("Chiller", [
  { name: "Air-Cooled 1500 x 1000", values: { width: 1.5, depth: 1.0, height: 1.6, powerWatts: 4500 } },
  { name: "Water-Cooled 2000 x 1200", values: { width: 2.0, depth: 1.2, height: 2.0, powerWatts: 12000 } },
]));
families.push(makeMechanicalEquipment("Heat Exchanger", [
  { name: "Plate 400 x 600", values: { width: 0.4, depth: 0.6, height: 0.6, powerWatts: 0, connectionSize: "DN 50" } },
]));
families.push(makeMechanicalEquipment("Expansion Vessel", [
  { name: "25L Vertical", values: { width: 0.3, depth: 0.3, height: 0.6, powerWatts: 0 } },
  { name: "100L Vertical", values: { width: 0.5, depth: 0.5, height: 1.0, powerWatts: 0 } },
]));
families.push(makeMechanicalEquipment("Water Heater", [
  { name: "150L Floor", values: { width: 0.5, depth: 0.5, height: 1.4, powerWatts: 3000 } },
  { name: "300L Floor", values: { width: 0.65, depth: 0.65, height: 1.7, powerWatts: 4500 } },
]));

// ─── write all families to disk + build index.json ─────────────────────

console.log(`Generating ${families.length} family files…`);

// Clean the output directory (preserve index.json until we rewrite it)
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Remove old family JSON files (Wall.json stub + any prior generated files)
for (const entry of fs.readdirSync(outDir)) {
  const full = path.join(outDir, entry);
  if (entry === "index.json") continue;
  if (entry.endsWith(".json")) fs.rmSync(full);
}

const indexEntries = [];

for (const fam of families) {
  const category = fam.group ?? fam.category;
  const slug = fam.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const relPath = `${category}/${slug}.json`;
  const fullDir = path.join(outDir, category);
  const fullPath = path.join(fullDir, `${slug}.json`);

  fs.mkdirSync(fullDir, { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(fam, null, 2) + "\n", "utf8");

  indexEntries.push({
    id: fam.id,
    name: fam.name,
    group: fam.group,
    category: fam.category,
    ifcEntity: fam.ifcEntity,
    typeCount: fam.types.length,
    path: relPath,
  });

  console.log(`  ✓ ${relPath}  (${fam.types.length} types)`);
}

// Write the index.json consumed by src/modules/families/library-loader.ts
fs.writeFileSync(
  path.join(outDir, "index.json"),
  JSON.stringify(indexEntries, null, 2) + "\n",
  "utf8",
);

console.log("");
console.log(`Wrote ${families.length} families + index.json to public/families/`);

// Summary by category
const byCategory = new Map();
for (const f of families) {
  const cat = f.group ?? f.category;
  if (!byCategory.has(cat)) byCategory.set(cat, { families: 0, types: 0 });
  const s = byCategory.get(cat);
  s.families += 1;
  s.types += f.types.length;
}
console.log("");
console.log("Catalog summary:");
for (const [cat, s] of byCategory) {
  console.log(`  ${cat.padEnd(22)} ${String(s.families).padStart(2)} families, ${String(s.types).padStart(2)} types`);
}
const totalTypes = families.reduce((n, f) => n + f.types.length, 0);
console.log(`  ${"".padEnd(22)} ${String(families.length).padStart(2)} families, ${String(totalTypes).padStart(2)} types TOTAL`);
