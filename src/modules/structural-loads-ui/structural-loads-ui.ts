/**
 * Structural Loads UI — load case / load combination manager.
 *
 * BIM-equivalent of Revit's "Structural Loads" tool. Manages load cases
 * (dead, live, wind, seismic, snow, etc.) and load combinations per
 * ASCE 7 / Eurocode 0 / IBC.
 *
 * This module stores load cases centrally and produces factored combinations
 * for export to FEM solvers.
 */

export type LoadCaseCategory =
  | "dead" | "live" | "roof-live" | "snow" | "wind" | "seismic"
  | "soil" | "fluid" | "settlement" | "temperature" | "prestress"
  | "impact" | "construction";

export type LoadType = "point" | "line" | "area" | "moment" | "body";

export interface LoadCase {
  id: string;
  name: string;
  category: LoadCaseCategory;
  /** For LRFD — load factor in basic combinations (e.g. 1.2 for DL). */
  baseFactor: number;
  /** Self-weight multiplier (e.g. -1 for downward gravity). */
  selfWeightMultiplier: number;
  /** Load type. */
  type: LoadType;
  /** Load magnitude (in units consistent with the model). */
  magnitude: number;
  /** Optional direction vector (unit). */
  direction?: { x: number; y: number; z: number };
  /** Optional application target (analytical node/member ID). */
  targetId?: string;
}

export interface LoadCombination {
  id: string;
  name: string;
  /** Service (ASD) or factored (LRFD). */
  designMethod: "ASD" | "LRFD";
  /** List of (caseId, factor) tuples. */
  cases: Array<{ caseId: string; factor: number }>;
}

const loadCases = new Map<string, LoadCase>();
const loadCombinations = new Map<string, LoadCombination>();
let counter = 0;

/** Create a load case. */
export function createLoadCase(input: Partial<LoadCase> = {}): LoadCase {
  const id = input.id ?? `lc-${++counter}`;
  const lc: LoadCase = {
    id,
    name: input.name ?? `Load Case ${counter}`,
    category: input.category ?? "dead",
    baseFactor: input.baseFactor ?? 1.0,
    selfWeightMultiplier: input.selfWeightMultiplier ?? 0,
    type: input.type ?? "point",
    magnitude: input.magnitude ?? 0,
    direction: input.direction ?? { x: 0, y: -1, z: 0 },
    targetId: input.targetId,
  };
  loadCases.set(id, lc);
  return lc;
}

/** List all load cases. */
export function listLoadCases(): LoadCase[] {
  return Array.from(loadCases.values());
}

/** Delete a load case. */
export function deleteLoadCase(id: string): boolean {
  loadCombinations.forEach((lc) => {
    lc.cases = lc.cases.filter((c) => c.caseId !== id);
  });
  return loadCases.delete(id);
}

/** Create a load combination. */
export function createLoadCombination(input: Partial<LoadCombination> = {}): LoadCombination {
  const id = input.id ?? `lcomb-${++counter}`;
  const lc: LoadCombination = {
    id,
    name: input.name ?? `Combination ${counter}`,
    designMethod: input.designMethod ?? "LRFD",
    cases: input.cases ?? [],
  };
  loadCombinations.set(id, lc);
  return lc;
}

/** List all load combinations. */
export function listLoadCombinations(): LoadCombination[] {
  return Array.from(loadCombinations.values());
}

/** Resolve a load combination to a list of factored load cases. */
export function resolveCombination(combId: string): LoadCase[] {
  const comb = loadCombinations.get(combId);
  if (!comb) return [];
  const result: LoadCase[] = [];
  for (const entry of comb.cases) {
    const lc = loadCases.get(entry.caseId);
    if (!lc) continue;
    result.push({ ...lc, magnitude: lc.magnitude * entry.factor });
  }
  return result;
}

/** Generate ASCE 7-22 default LRFD combinations from existing load cases. */
export function generateDefaultLRFDCombinations(): LoadCombination[] {
  const cases = listLoadCases();
  const dead = cases.find((c) => c.category === "dead");
  const live = cases.find((c) => c.category === "live");
  const snow = cases.find((c) => c.category === "snow");
  const wind = cases.find((c) => c.category === "wind");
  const seismic = cases.find((c) => c.category === "seismic");

  const combos: LoadCombination[] = [];
  if (dead) {
    combos.push(createLoadCombination({
      name: "1.4D",
      designMethod: "LRFD",
      cases: [{ caseId: dead.id, factor: 1.4 }],
    }));
    if (live) combos.push(createLoadCombination({
      name: "1.2D + 1.6L",
      designMethod: "LRFD",
      cases: [
        { caseId: dead.id, factor: 1.2 },
        { caseId: live.id, factor: 1.6 },
      ],
    }));
    if (snow && live) combos.push(createLoadCombination({
      name: "1.2D + 0.5L + 1.6S",
      designMethod: "LRFD",
      cases: [
        { caseId: dead.id, factor: 1.2 },
        { caseId: live.id, factor: 0.5 },
        { caseId: snow.id, factor: 1.6 },
      ],
    }));
    if (wind && live && snow) combos.push(createLoadCombination({
      name: "1.2D + 1.0L + 0.5S + 1.0W",
      designMethod: "LRFD",
      cases: [
        { caseId: dead.id, factor: 1.2 },
        { caseId: live.id, factor: 1.0 },
        { caseId: snow.id, factor: 0.5 },
        { caseId: wind.id, factor: 1.0 },
      ],
    }));
    if (seismic && live) combos.push(createLoadCombination({
      name: "1.2D + 1.0E + 0.5L",
      designMethod: "LRFD",
      cases: [
        { caseId: dead.id, factor: 1.2 },
        { caseId: seismic.id, factor: 1.0 },
        { caseId: live.id, factor: 0.5 },
      ],
    }));
  }
  return combos;
}

/** Generate ASD combinations. */
export function generateDefaultASDCombinations(): LoadCombination[] {
  const cases = listLoadCases();
  const dead = cases.find((c) => c.category === "dead");
  const live = cases.find((c) => c.category === "live");
  const wind = cases.find((c) => c.category === "wind");
  const snow = cases.find((c) => c.category === "snow");
  const combos: LoadCombination[] = [];
  if (dead) {
    combos.push(createLoadCombination({
      name: "D",
      designMethod: "ASD",
      cases: [{ caseId: dead.id, factor: 1.0 }],
    }));
    if (live) combos.push(createLoadCombination({
      name: "D + L",
      designMethod: "ASD",
      cases: [
        { caseId: dead.id, factor: 1.0 },
        { caseId: live.id, factor: 1.0 },
      ],
    }));
    if (snow && live) combos.push(createLoadCombination({
      name: "D + 0.75L + 0.75S",
      designMethod: "ASD",
      cases: [
        { caseId: dead.id, factor: 1.0 },
        { caseId: live.id, factor: 0.75 },
        { caseId: snow.id, factor: 0.75 },
      ],
    }));
    if (wind) combos.push(createLoadCombination({
      name: "D + 0.6W",
      designMethod: "ASD",
      cases: [
        { caseId: dead.id, factor: 1.0 },
        { caseId: wind.id, factor: 0.6 },
      ],
    }));
  }
  return combos;
}

/** Reset registries (tests). */
export function resetLoadCases(): void {
  loadCases.clear();
  loadCombinations.clear();
  counter = 0;
}
