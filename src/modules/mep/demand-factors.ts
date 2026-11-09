/**
 * Electrical demand factors — NEC 220-style code roll-ups for panel
 * schedules and distribution summaries.
 *
 * Compatibility target: RVT panel schedules' demand-factor handling and the
 * NEC load-calculation worksheets behind "Electrical - Loads" (220.42
 * general lighting, 220.44 receptacles, 220.82 dwelling optional method,
 * 220.84 multi-family, 210.19/215.2 continuous-load 125%).
 *
 * Precedence (documented): an explicit per-load `demandFactor` (already
 * supported by electrical.ts) always wins over the code table here — the
 * engineer's override governs. This module covers the default path when
 * no override is present and produces the transparent per-category
 * breakdown auditors ask for.
 *
 * Pure module: no DOM, no three.js, no ctx. Safe to unit-test in Node.
 * Design aid only — the governing installation code wins.
 */

// ─── Load classification ──────────────────────────────────────────────────

export type LoadType =
  | "general-lighting"
  | "receptacle"
  | "kitchen-appliance"
  | "laundry-bath"
  | "hvac-heating"
  | "hvac-cooling"
  | "motor-largest"
  | "motor-other"
  | "evse"
  | "water-heater"
  | "cooking-appliance"
  | "dryer"
  | "continuous"
  | "other";

export interface LoadTypeHint {
  loadId: string;
  type: LoadType;
}

/** Classify a load from its id/name when no explicit hint exists. */
export function classifyLoad(loadId: string, name: string, apparentPowerVA: number): LoadType {
  const text = `${loadId} ${name}`.toLowerCase();
  if (/ev ?charg|evse|ev-/.test(text)) return "evse";
  if (/water ?heat|boiler(?! feed)/.test(text)) return "water-heater";
  if (/range|oven|cooktop|cooking|hob/.test(text)) return "cooking-appliance";
  if (/dryer/.test(text)) return "dryer";
  if (/dishwash|washing|kitchen|fridge|freezer|refrigerat/.test(text)) return "kitchen-appliance";
  if (/laundry|bath ?room/.test(text)) return "laundry-bath";
  if (/heater|heating|heat trace|anti-?ice/.test(text)) return "hvac-heating";
  if (/chiller|cooling|ac |air ?cond|vrf|dx unit|fancoil|fan coil/.test(text)) return "hvac-cooling";
  if (/motor|pump|fan(?! ?coil)|compressor|lift|elevator|conveyor/.test(text)) return "motor-other";
  if (/light/.test(text)) return "general-lighting";
  if (/socket|outlet|recept|plug|generic power/.test(text)) return "receptacle";
  if (apparentPowerVA > 15_000) return "other";
  return "receptacle";
}

// ─── NEC 220.42 general lighting demand factors (by occupancy) ───────────

export type Occupancy =
  | "dwelling"
  | "hotel"
  | "hospital"
  | "warehouse"
  | "school"
  | "office"
  | "retail"
  | "industrial";

/**
 * NEC 220.42 table — demand factor for the *general lighting* portion of a
 * dwelling/service calculation. The first `limit` VA at 100%, remainder at
 * the table factor. Office/retail/industrial style occupancies stay at 100%
 * unless the authority permits diversity.
 */
export function generalLightingDemandFactor(occupancy: Occupancy, connectedVA: number): { factor: number; portionAt100: number } {
  const va = Math.max(0, connectedVA);
  switch (occupancy) {
    case "dwelling":
      // First 3,000 VA at 100%; 3,001–120,000 at 35%; remainder at 25%.
      if (va <= 3_000) return { factor: 1, portionAt100: va };
      if (va <= 120_000) return { factor: (3_000 + (va - 3_000) * 0.35) / va, portionAt100: 3_000 };
      return { factor: (3_000 + 117_000 * 0.35 + (va - 120_000) * 0.25) / va, portionAt100: 3_000 };
    case "hotel":
      // First 20,000 at 50%; remainder at 40% (abridged 220.42 hotel row).
      if (va <= 20_000) return { factor: 0.5, portionAt100: 0 };
      return { factor: (20_000 + (va - 20_000) * 0.4) / va, portionAt100: 0 };
    case "hospital":
      // First 50,000 at 40%; remainder at 30%.
      if (va <= 50_000) return { factor: 0.4, portionAt100: 0 };
      return { factor: (50_000 + (va - 50_000) * 0.3) / va, portionAt100: 0 };
    case "warehouse":
      return { factor: 0.5, portionAt100: 0 };
    case "school":
      // First 20 VA/…: abridged — 45% on everything above zero VA.
      return { factor: 0.45, portionAt100: 0 };
    case "office":
    case "retail":
    case "industrial":
    default:
      return { factor: 1, portionAt100: va };
  }
}

// ─── NEC 220.44 receptacle demand (non-dwelling) ─────────────────────────

/** Non-dwelling receptacle demand: first 10 kVA at 100%, remainder at 50%. */
export function receptacleDemandVA(connectedVA: number): number {
  const va = Math.max(0, connectedVA);
  if (va <= 10_000) return va;
  return 10_000 + (va - 10_000) * 0.5;
}

// ─── Continuous load and motor rules ─────────────────────────────────────

/** NEC 210.19/215.2 — continuous loads are sized at 125%. */
export function continuousLoadFactorVA(connectedVA: number): number {
  return Math.max(0, connectedVA) * 1.25;
}

/**
 * NEC 430.24 — add 25% of the largest motor to the group demand.
 * `motorsVA` are the connected motor loads; the largest gets the +25%.
 */
export function motorDemandVA(motorsVA: number[]): { connectedVA: number; demandVA: number; largestVA: number } {
  const list = motorsVA.filter(v => Number.isFinite(v) && v > 0);
  const connectedVA = list.reduce((a, b) => a + b, 0);
  const largestVA = list.length ? Math.max(...list) : 0;
  return { connectedVA, demandVA: connectedVA + largestVA * 0.25, largestVA };
}

// ─── Panel-level roll-up ─────────────────────────────────────────────────

export interface DemandItem {
  loadId: string;
  name: string;
  connectedVA: number;
  /** Explicit override from electrical.ts — wins over every table here. */
  demandFactor?: number;
  /** Optional motor flag so the 430.24 largest-motor rule can apply. */
  isMotor?: boolean;
  /** Continuous flag → 125%. */
  isContinuous?: boolean;
}

export interface DemandCategory {
  type: LoadType;
  connectedVA: number;
  demandVA: number;
  /** Code rule applied (human readable). */
  rule: string;
}

export interface PanelDemandResult {
  categories: DemandCategory[];
  connectedTotalVA: number;
  demandTotalVA: number;
  /** Overall demand factor = demand / connected (0 when nothing connected). */
  overallFactor: number;
  /** Warnings raised while applying the rules. */
  notes: string[];
}

/**
 * Roll a panel's loads into code-style demand categories.
 *
 * Two passes, matching how the NEC tables are actually applied:
 *   Pass 1 — every item is classified; engineer overrides (explicit
 *            demandFactor) resolve immediately at item level and are
 *            excluded from the code-table pool.
 *   Pass 2 — the remaining non-override VA is pooled per load type and the
 *            code rule applies to the pool, exactly as the tables intend:
 *   1. continuous flag → ×1.25 (210.19);
 *   2. receptacle pool → 220.44 first-10k/50%;
 *   3. general-lighting pool → 220.42 occupancy table;
 *   4. motors → 430.24 largest-motor +25% across the group;
 *   5. everything else → 100% (kitchen, EVSE, water heater, cooking…).
 */
export function panelDemandRollup(items: DemandItem[], occupancy: Occupancy = "office"): PanelDemandResult {
  const notes: string[] = [];

  // Pass 1 — classify, resolve overrides, pool the rest.
  const pool = new Map<LoadType, number>();
  const cat = new Map<LoadType, { connectedVA: number; demandVA: number }>();
  const motorIds = new Set<string>();
  for (const item of items) {
    const va = Math.max(0, Number.isFinite(item.connectedVA) ? item.connectedVA : 0);
    const type = classifyLoad(item.loadId, item.name, va);
    if (item.isMotor || type === "motor-other") motorIds.add(item.loadId);
  }
  const motorSized = motorDemandVA(items.filter(i => motorIds.has(i.loadId)).map(i => i.connectedVA));
  const motorBoost = motorSized.demandVA - motorSized.connectedVA; // +25% of the largest

  for (const item of items) {
    const va = Math.max(0, Number.isFinite(item.connectedVA) ? item.connectedVA : 0);
    const type = classifyLoad(item.loadId, item.name, va);
    const cur = cat.get(type) ?? { connectedVA: 0, demandVA: 0 };
    cur.connectedVA += va;
    cat.set(type, cur);

    if (item.demandFactor != null) {
      if (!Number.isFinite(item.demandFactor) || item.demandFactor < 0 || item.demandFactor > 1) {
        throw new Error(`Load '${item.loadId}' demandFactor must be between 0 and 1`);
      }
      const cur2 = cat.get(type)!;
      cur2.demandVA += va * item.demandFactor;
      cat.set(type, cur2);
      notes.push(`'${item.name}' uses the explicit demand factor (wins over the code table).`);
      continue;
    }
    pool.set(type, (pool.get(type) ?? 0) + va);
  }

  // Pass 2 — code rules on the pooled VA per type.
  const rules = new Map<LoadType, string>();
  for (const [type, pooledVA] of pool) {
    const cur = cat.get(type)!;
    if (type === "receptacle") {
      cur.demandVA += receptacleDemandVA(pooledVA);
      rules.set(type, "NEC 220.44 — pool: first 10 kVA @100%, remainder @50%");
    } else if (type === "general-lighting") {
      const gf = generalLightingDemandFactor(occupancy, pooledVA);
      cur.demandVA += pooledVA * gf.factor;
      rules.set(type, `NEC 220.42 ${occupancy} ×${gf.factor.toFixed(2)} on the lighting pool`);
    } else if (type === "motor-other") {
      cur.demandVA += pooledVA + motorBoost;
      rules.set(type, "NEC 430.24 — motors 100% + largest motor ×1.25");
    } else {
      cur.demandVA += pooledVA;
      rules.set(type, RULE_TEXT[type] ?? "100%");
    }
    cat.set(type, cur);
  }

  const categories: DemandCategory[] = [...cat.entries()].map(([type, v]) => ({
    type,
    connectedVA: v.connectedVA,
    demandVA: v.demandVA,
    rule: rules.get(type) ?? RULE_TEXT[type] ?? "engineer override / 100%",
  }));
  const connectedTotalVA = categories.reduce((a, c) => a + c.connectedVA, 0);
  const demandTotalVA = categories.reduce((a, c) => a + c.demandVA, 0);
  return {
    categories,
    connectedTotalVA,
    demandTotalVA,
    overallFactor: connectedTotalVA > 0 ? demandTotalVA / connectedTotalVA : 0,
    notes,
  };
}

const RULE_TEXT: Partial<Record<LoadType, string>> = {
  "general-lighting": "NEC 220.42 occupancy table",
  receptacle: "NEC 220.44 first 10 kVA @100%, remainder @50%",
  "motor-other": "NEC 430.24 largest motor +25%",
  continuous: "NEC 210.19 continuous ×1.25",
  evse: "NEC 625 100% (EVSE continuous)",
  "water-heater": "NEC 422 100% (resistive appliance)",
  "cooking-appliance": "NEC 220.55 (simplified: 100%)",
};

// ─── Dwelling optional methods ────────────────────────────────────────────

export interface DwellingUnitInput {
  /** Dwelling floor area in m² (NEC uses ft²; 3 VA/m² general lighting). */
  areaM2: number;
  /** Number of 1,500 VA small-appliance circuits (min 2, NEC 220.82(B)(2)). */
  smallApplianceCircuits: number;
  /** Number of 1,500 VA laundry circuits (min 1). */
  laundryCircuits: number;
  /** Fastened-in-place appliance VA list (range, water heater, dishwasher…). */
  appliancesVA: number[];
  /** HVAC cooling VA (competing load — see note). */
  coolingVA: number;
  /** Space-heating VA (competing load — the larger of heat/cool counts). */
  heatingVA: number;
}

export interface DwellingResult {
  generalLightingVA: number;
  applianceCircuitsVA: number;
  appliancesConnectedVA: number;
  hvacVA: number;
  hvacRule: string;
  /** Demand load after 220.82 (A+B). */
  demandLoadVA: number;
  /** Overall factor vs the raw connected total. */
  overallFactor: number;
  notes: string[];
}

/**
 * NEC 220.82 optional method — single dwelling unit.
 *   Part A: 100% of the first 10 kVA + 40% of the remainder of
 *           (3 VA/m² general + 1,500 VA per small-appliance + laundry).
 *   Part B: 100% of the larger of heating or cooling + all other
 *           fastened-in-place appliances at nameplate (values ≥ 1,500 VA
 *           may alternatively use 220.55/422.31 tables — out of scope here).
 */
export function dwellingOptionalMethod(u: DwellingUnitInput): DwellingResult {
  const area = Math.max(0, u.areaM2);
  const sac = Math.max(2, Math.floor(u.smallApplianceCircuits));
  const lc = Math.max(1, Math.floor(u.laundryCircuits));
  const notes: string[] = [];
  if (u.smallApplianceCircuits < 2) notes.push("Small-appliance circuits raised to the NEC minimum of 2.");
  if (u.laundryCircuits < 1) notes.push("Laundry circuits raised to the NEC minimum of 1.");

  const generalLightingVA = area * 3;
  const applianceCircuitsVA = (sac + lc) * 1_500;
  const appliances = u.appliancesVA.filter(v => Number.isFinite(v) && v > 0);
  const appliancesConnectedVA = appliances.reduce((a, b) => a + b, 0);
  const hvacVA = Math.max(u.coolingVA, u.heatingVA);
  const hvacRule = u.heatingVA > u.coolingVA ? "heating (larger of heat/cool)" : "cooling (larger of heat/cool)";

  const partAconnected = generalLightingVA + applianceCircuitsVA;
  const partA = partAconnected <= 10_000 ? partAconnected : 10_000 + (partAconnected - 10_000) * 0.4;
  const partB = appliancesConnectedVA + hvacVA;
  const demandLoadVA = partA + partB;
  const connectedTotalVA = partAconnected + appliancesConnectedVA + hvacVA;

  return {
    generalLightingVA,
    applianceCircuitsVA,
    appliancesConnectedVA,
    hvacVA,
    hvacRule,
    demandLoadVA,
    overallFactor: connectedTotalVA > 0 ? demandLoadVA / connectedTotalVA : 0,
    notes,
  };
}

/**
 * NEC 220.84 multi-family abridged table — demand factor applied to the
 * summed dwelling-unit loads by unit count.
 */
export function multiFamilyDemandFactor(units: number): number {
  const n = Math.max(1, Math.floor(units));
  if (n <= 2) return 1;
  if (n <= 3) return 0.45;
  if (n <= 5) return 0.44;
  if (n <= 9) return 0.43;
  if (n <= 12) return 0.42;
  if (n <= 24) return 0.41;
  if (n <= 39) return 0.4;
  if (n <= 62) return 0.39;
  return 0.23 + 0.0 * n; // 63+ units
}
