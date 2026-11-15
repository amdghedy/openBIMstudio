/**
 * IFC unit intelligence — parse IfcUnitAssignment members and expose
 * unit-aware conversion to SI base units.
 *
 * Handled members:
 *   - IfcSIUnit: (Dimensions, .LENGTHUNIT., .MILLI., .METRE.)
 *   - IfcConversionBasedUnit: ('name', .LENGTHUNIT., IfcMeasureWithUnit, $)
 *     whose IfcMeasureWithUnit(IfcLengthMeasure(value), IfcSIUnit-ref)
 *     chains onto an SI unit (e.g. FOOT = 0.3048 × METRE).
 *
 * Pure module: no three.js, no DOM, no project imports.
 */

import { readStep, parseRef, unenum, unquote, type StepFile, type StepEntity } from "./step-reader";

export interface IfcUnit {
  /** Measure role: LENGTHUNIT, AREAUNIT, VOLUMEUNIT, PLANEANGLEUNIT, … */
  role: string;
  /** SI base name for si units; conversion display name for conversion units. */
  name: string;
  /** SI prefix (MILLI, KILO, …) or null. */
  prefix: string | null;
  /** Multiply a value expressed in this unit by this factor to get the SI base. */
  factor: number;
  kind: "si" | "conversion";
  /** Express id of the unit entity. */
  id: number;
}

export interface UnitsAssignment {
  /** Present: at least one length/area/volume/angle unit was found. */
  present: boolean;
  length: IfcUnit | null;
  area: IfcUnit | null;
  volume: IfcUnit | null;
  angle: IfcUnit | null;
  all: IfcUnit[];
  warnings: string[];
}

export const EMPTY_UNITS: UnitsAssignment = {
  present: false, length: null, area: null, volume: null, angle: null, all: [], warnings: [],
};

const SI_PREFIX_FACTORS: Record<string, number> = {
  EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6,
  KILO: 1e3, HECTO: 1e2, DECA: 1e1,
  DECI: 1e-1, CENTI: 1e-2, MILLI: 1e-3, MICRO: 1e-6,
  NANO: 1e-9, PICO: 1e-12, FEMTO: 1e-15, ATTO: 1e-18,
};

/** Factor that brings an SI measure name to its base (METRE/SQUARE_METRE/…). */
const SI_BASE_FACTORS: Record<string, number> = {
  METRE: 1,
  SQUARE_METRE: 1,
  CUBIC_METRE: 1,
  RADIAN: 1,
  GRAM: 1e-3, // base kg expressed in g — only relevant when parsing weights
  SECOND: 1,
};

function siUnitFactor(name: string, prefix: string | null): number | null {
  const base = SI_BASE_FACTORS[name];
  if (base === undefined) return null;
  const pf = prefix ? SI_PREFIX_FACTORS[prefix] : 1;
  if (pf === undefined) return null;
  return base * pf;
}

/** Convert a value expressed in `unit` into its SI base unit. */
export function toBase(value: number, unit: IfcUnit | null | undefined): number {
  if (!unit) return value;
  return value * unit.factor;
}

interface UnitParseAcc {
  units: IfcUnit[];
  warnings: string[];
}

function parseSiUnitArgs(id: number, args: string[], acc: UnitParseAcc): void {
  const role = unenum(args[1]);
  const prefixRaw = args[2];
  const prefix = prefixRaw && prefixRaw !== "$" ? unenum(prefixRaw) : null;
  const name = unenum(args[3]);
  if (!role || !name) {
    acc.warnings.push(`#${id} IFCSIUNIT: unrecognised arguments`);
    return;
  }
  const factor = siUnitFactor(name, prefix);
  if (factor === null) {
    // Unknown SI name (e.g. LUMINOUS intensity units) — keep with factor 1 but flag.
    acc.warnings.push(`#${id} IFCSIUNIT: no base factor for ${name} (${role}) — treated as factor 1`);
    acc.units.push({ role, name, prefix, factor: 1, kind: "si", id });
    return;
  }
  acc.units.push({ role, name, prefix, factor, kind: "si", id });
}

function parseConversionUnitArgs(id: number, args: string[], file: StepFile, acc: UnitParseAcc, depth: number): void {
  const role = unenum(args[1]);
  if (!role) {
    acc.warnings.push(`#${id} IFCCONVERSIONBASEDUNIT: missing measure role`);
    return;
  }
  // args[2] is the measure-with-unit ref.
  const mwRef = parseRef(args[2]);
  if (mwRef == null) {
    acc.warnings.push(`#${id} IFCCONVERSIONBASEDUNIT: no IfcMeasureWithUnit reference`);
    return;
  }
  const mw = file.entities.get(mwRef);
  if (!mw || mw.name !== "IFCMEASUREWITHUNIT") {
    acc.warnings.push(`#${id} IFCCONVERSIONBASEDUNIT: measure-with-unit #${mwRef} missing or wrong class`);
    return;
  }
  // IfcMeasureWithUnit(ValueComponent, UnitComponent)
  const value = Number(mw.args[0]);
  const unitCompRef = parseRef(mw.args[1]);
  if (!Number.isFinite(value) || unitCompRef == null) {
    acc.warnings.push(`#${id} IFCCONVERSIONBASEDUNIT: bad measure-with-unit payload`);
    return;
  }
  const comp = file.entities.get(unitCompRef);
  if (!comp) {
    acc.warnings.push(`#${id} IFCCONVERSIONBASEDUNIT: component unit #${unitCompRef} missing (dangling)`);
    return;
  }
  let compFactor = 1;
  let baseName = "UNKNOWN";
  let kind: IfcUnit["kind"] = "si";
  if (comp.name === "IFCSIUNIT" && depth < 3) {
    const before = acc.units.length;
    parseSiUnitArgs(comp.id, comp.args, acc);
    const parsed = acc.units.slice(before);
    if (parsed.length) { compFactor = parsed[0].factor; baseName = parsed[0].name; kind = "si"; }
  } else if (comp.name === "IFCCONVERSIONBASEDUNIT" && depth < 3) {
    const before = acc.units.length;
    parseConversionUnitArgs(comp.id, comp.args, file, acc, depth + 1);
    const parsed = acc.units.slice(before);
    if (parsed.length) { compFactor = parsed[0].factor; baseName = parsed[0].name; kind = "conversion"; }
  } else {
    acc.warnings.push(`#${id} IFCCONVERSIONBASEDUNIT: unsupported component ${comp.name}`);
    return;
  }
  const name = unquote(args[0]) ?? baseName;
  acc.units.push({
    role, name, prefix: null,
    factor: value * compFactor,
    kind: kind === "si" ? "conversion" : "conversion",
    id,
  });
}

/**
 * Collect the unit assignment of a parsed STEP file. Missing roles are left
 * null with no fabricated factors — consumers decide how to treat absent
 * units (the validation layer flags them explicitly).
 */
export function collectUnits(file: StepFile): UnitsAssignment {
  const acc: UnitParseAcc = { units: [], warnings: [] };
  for (const e of file.entities.values()) {
    if (e.name === "IFCSIUNIT") parseSiUnitArgs(e.id, e.args, acc);
    else if (e.name === "IFCCONVERSIONBASEDUNIT") parseConversionUnitArgs(e.id, e.args, file, acc, 0);
  }
  const pick = (role: string): IfcUnit | null => {
    const matches = acc.units.filter((u) => u.role === role);
    // A conversion-based unit explicitly redefines the measure for the file,
    // so it wins over a bare SI unit when both are present.
    return matches.find((u) => u.kind === "conversion") ?? matches[0] ?? null;
  };
  const length = pick("LENGTHUNIT");
  const area = pick("AREAUNIT");
  const volume = pick("VOLUMEUNIT");
  const angle = pick("PLANEANGLEUNIT");
  return {
    present: !!(length || area || volume || angle),
    length, area, volume, angle,
    all: acc.units,
    warnings: acc.warnings,
  };
}

/** Convenience: read + collect units from raw SPF text. */
export function readUnits(text: string): UnitsAssignment {
  return collectUnits(readStep(text));
}
