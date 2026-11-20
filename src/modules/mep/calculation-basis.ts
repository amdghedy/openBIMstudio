/**
 * MEP calculation basis — one honest record per calculation area: method,
 * applicable standard, units, assumptions, limitations, and validation
 * status. This is the single place the UI, reports and docs quote from
 * when they describe what an MEP number is.
 *
 * Rule enforced by this file's existence: no MEP calculation in this
 * codebase claims engineering code compliance. Every entry states its
 * validation status plainly; "unit-tested-only" means the arithmetic is
 * pinned by tests against hand-computed values, NOT that the method was
 * validated against a reference implementation, a code, or measured data
 * for any jurisdiction. Where a method follows a code table (NEC 220,
 * IPC DFU tables), the entry says which table and that the local adopted
 * code still governs.
 *
 * Pure data module: no DOM, no three.js, no ctx. Safe to import anywhere.
 */

export type MepValidationStatus =
  | "unit-tested-only"
  | "checked-against-published-tables";

export interface MepCalculationBasis {
  /** Stable key, e.g. "duct-pressure". */
  area: string;
  /** What the code actually computes. */
  method: string;
  /** Applicable standard / reference, or "none — generic practice". */
  standard: string;
  /** Units the method uses (SI unless stated). */
  units: string;
  /** Assumptions baked into the numbers. */
  assumptions: string[];
  /** What the method does NOT do. */
  limitations: string[];
  validation: MepValidationStatus;
  validationNote: string;
  /** Source module implementing it. */
  source: string;
}

export const MEP_CALCULATION_BASIS: MepCalculationBasis[] = [
  {
    area: "duct-pressure",
    method: "Darcy–Weisbach Δp = f·(L/Dh)·(ρv²/2); Colebrook–White friction factor by Newton iteration seeded with Swamee–Jain; laminar fallback f = 64/Re below Re 2300; fitting losses ΣC·(ρv²/2) with tabulated C values; hydraulic diameter for rectangular ducts.",
    standard: "ASHRAE Fundamentals (duct design practice); fitting C values are typical ASHRAE/IDHA values for stock fittings.",
    units: "Pa, Pa/m, m, m³/s, m/s; air density 1.204 kg/m³, viscosity 1.81e-5 Pa·s (20 °C, 1 atm).",
    assumptions: ["Air at 20 °C and 1 atm unless density/viscosity overrides are supplied.", "Fitting coefficients are for stock fittings at nominal conditions."],
    limitations: ["Fitting coefficients are approximate by design — not a substitute for manufacturer data.", "No leakage, no altitude/density correction unless overridden.", "Not a code-compliance calculation for any jurisdiction."],
    validation: "unit-tested-only",
    validationNote: "Arithmetic pinned by mep-pressure tests against hand-computed values; friction factors not validated against a reference solver.",
    source: "src/modules/mep/pressure.ts",
  },
  {
    area: "pipe-pressure",
    method: "Same Darcy–Weisbach / Colebrook–White physics as duct-pressure; results also reported as head (m).",
    standard: "Generic fluid-mechanics practice; no code table.",
    units: "Pa and m head; m³/s internally (L/s at the API boundary); water density 998.2 kg/m³, viscosity 1.002e-3 Pa·s (20 °C).",
    assumptions: ["Water at 20 °C unless density/viscosity overrides are supplied.", "Roughness from the material table (galvanized steel, copper, PVC, PEX, …)."],
    limitations: ["No water-hammer transient analysis (see plumbing area for the surge estimate).", "Not a code-compliance calculation for any jurisdiction."],
    validation: "unit-tested-only",
    validationNote: "Arithmetic pinned by mep-pressure tests against hand-computed values.",
    source: "src/modules/mep/pressure.ts",
  },
  {
    area: "duct-pipe-sizing",
    method: "Velocity method: pick the smallest standard size (DUCT_WIDTHS/DUCT_HEIGHTS, PIPE_DN tables) whose velocity at the design flow is at or below the per-system cap; friction method: smallest size whose specific friction rate is at or below the target; static-regain method for duct mains (size the first section by friction, then hold static pressure by velocity-head recovery).",
    standard: "ASHRAE practice friction-rate targets (low-velocity supply 0.8–1.0 Pa/m; quiet 0.4–0.6 Pa/m; chilled/hot water 100–400 Pa/m).",
    units: "m, m³/s (air), L/s (water), m/s, Pa/m.",
    assumptions: ["Standard size tables are the only sizes offered; non-standard sizes are not produced.", "Velocity caps are per-system generic limits, not noise criteria for a specific room."],
    limitations: ["No acoustic (NC) analysis; a velocity cap is not a noise guarantee.", "Static regain is the classic method, not a balanced-damper design.", "Not a code-compliance calculation for any jurisdiction."],
    validation: "unit-tested-only",
    validationNote: "Pinned by mep-sizing-methods / mep-router tests; size tables not cross-checked against a manufacturer catalogue.",
    source: "src/modules/mep/sizing.ts, src/modules/mep/sizing-methods.ts",
  },
  {
    area: "network-audit",
    method: "Flow accumulation from terminal demands upstream to the source over the distribution tree; per-section sizing/pressure check; critical (worst) path; fan duty from worst-path Δp + flow with a 1.1 safety factor default; pump duty from worst-path head + static lift + terminal residual head.",
    standard: "Generic distribution-tree practice; no code.",
    units: "m³/s (air) / L/s (water) native per system; Pa; m head.",
    assumptions: ["The network is a tree — cycles are diagnosed and excluded from accumulation, not solved.", "Terminal demands come from equipment properties (flowRate/designFlow) or caller-supplied values."],
    limitations: ["No looped-network (Hardy-Cross) solving; no balancing-damper or valve authority analysis.", "Fan/pump selection is a duty point, not an equipment schedule against a catalogue."],
    validation: "unit-tested-only",
    validationNote: "Pinned by mep-network / mep-flow-assignment tests on hand-built trees; not validated against a reference network solver.",
    source: "src/modules/mep/network.ts, src/modules/mep/flow-assignment.ts",
  },
  {
    area: "hvac-loads",
    method: "Simplified heat balance (ASHRAE Fundamentals): conduction Q = U·A·ΔT with sol-air temperature for walls/roof; glazing solar SHGC·A·E_peak; internal gains (people 75 W sensible + 55 W latent, lighting/equipment W/m²); ventilation outdoor air at 10 L/s per person (ASHRAE 62.1 office rate). Peak clear-sky irradiance per orientation for ~40°N in July.",
    standard: "ASHRAE Fundamentals (simplified method) and ASHRAE 62.1 ventilation rate.",
    units: "W, W/m², L/s, m³/s, °C.",
    assumptions: ["Design-day irradiance table is for ~40°N latitude, July, clear sky.", "Office occupancy gains; internal-gain densities are defaults, not surveyed loads."],
    limitations: ["Not a code-compliant load calculation for any jurisdiction (no RTS/CLTD full procedure, no hourly simulation).", "Single design-day snapshot; no part-load or diversity analysis."],
    validation: "unit-tested-only",
    validationNote: "Pinned by mep-hvac-loads tests; results not compared against a reference load program.",
    source: "src/modules/mep/hvac-loads.ts",
  },
  {
    area: "plumbing-demand",
    method: "Hunter's curve (NBS BMS 65, reproduced in IPC Appendix E / UPC Appendix B Table B.5.4) converting total water-supply fixture units (WSFU) to probable peak demand; water-hammer surge estimate.",
    standard: "Hunter's curve per NBS BMS 65 / IPC App. E / UPC App. B.",
    units: "WSFU, L/s, m.",
    assumptions: ["Fixture-unit values are the standard table values for the listed fixture types.", "Probable peak is a statistical estimate, not a measured peak."],
    limitations: ["The governing plumbing code (IPC/UPC/local) still decides fixture-unit values and pipe sizing.", "Surge estimate is a screening value, not a transient simulation."],
    validation: "unit-tested-only",
    validationNote: "Pinned by mep-plumbing tests; curve values not cross-checked against a code publication in-test.",
    source: "src/modules/mep/plumbing.ts",
  },
  {
    area: "drainage",
    method: "Sanitary drainage sizing by drainage fixture units (DFU) per IPC Tables 709.1, 710.1(1) and 710.1(2), including slope checks.",
    standard: "IPC Tables 709.1, 710.1(1), 710.1(2).",
    units: "DFU, mm/m slope, L/s.",
    assumptions: ["IPC DFU values for the listed fixtures.", "Gravity flow; slope within the tabulated range."],
    limitations: ["IPC only — UPC/EN 12056 jurisdictions need their own tables.", "Foundations, not a verified drainage design workflow."],
    validation: "unit-tested-only",
    validationNote: "Pinned by mep-drainage tests; tables not cross-checked against a code publication in-test.",
    source: "src/modules/mep/drainage.ts, src/modules/mep/slope.ts",
  },
  {
    area: "fire-sprinkler",
    method: "Head discharge by the K-factor law Q = K·√P (Q in L/min, P in bar for metric K); density/area design and checks.",
    standard: "Generic sprinkler-hydraulics practice (K-factor law).",
    units: "L/min, bar, L/min/m² density.",
    assumptions: ["Metric K-factors (K80 ≈ imperial K5.6).", "Design density/area are caller inputs."],
    limitations: ["Pipe-network connectivity and flow/pressure foundations only — sprinkler coordination and code configuration are not a proven workflow.", "No NFPA 13 (or local equivalent) compliance claim."],
    validation: "unit-tested-only",
    validationNote: "Pinned by mep-fire tests on hand-computed heads.",
    source: "src/modules/mep/fire.ts",
  },
  {
    area: "electrical-voltage-drop",
    method: "ΔV = I·k·(R'·cosφ + X'·sinφ), k = 2 (single-phase loop) or √3 (three-phase); conductor DC resistance per IEC 60228 at 20 °C corrected to operating temperature (Cu α 0.00393/K, Al 0.00403/K); ampacity reference IEC 60364-5-52 Table B.52.4 method C, PVC, two loaded conductors, 30 °C ambient; coordination check Ib ≤ In ≤ Iz (IEC 60364-4-43 style).",
    standard: "IEC 60228, IEC 60364-5-52 Table B.52.4, IEC 60364-4-43.",
    units: "V, %, A, m, mm², Ω/km.",
    assumptions: ["Reference ampacity is for one installation method (clipped direct, method C) at 30 °C — derating for grouping, ambient, or other methods is the engineer's job.", "Default reactance 0.08 Ω/km for multicore cables; default operating temperature 70 °C."],
    limitations: ["Ampacity table is a typical reference — re-check against the actual installation method and any derating.", "No short-circuit temperature-rise (I²t) check.", "Not a code-compliance calculation for any jurisdiction."],
    validation: "unit-tested-only",
    validationNote: "Pinned by mep-electrical-calc tests; resistance/ampacity tables transcribed from IEC tables, not machine-checked against a publication.",
    source: "src/modules/mep/electrical-calc.ts",
  },
  {
    area: "electrical-demand-factors",
    method: "NEC-style load roll-ups: 220.42 general-lighting demand by occupancy, 220.44 receptacle (first 10 kVA @100%, remainder @50%), 430.24 motors (largest +25%), 210.19 continuous ×1.25, 220.82 dwelling optional method, 220.84 multi-family table; explicit per-load demandFactor overrides always win.",
    standard: "NEC 220/210/430 (US National Electrical Code) — tables as implemented, simplified where noted.",
    units: "VA, kVA, A.",
    assumptions: ["US NEC tables; metric inputs (m², 3 VA/m² general lighting).", "NEC 220.55 cooking is simplified to 100%."],
    limitations: ["NEC only — IEC/BS 7671 jurisdictions need their own method.", "Simplified where noted; the adopted code governs."],
    validation: "unit-tested-only",
    validationNote: "Pinned by mep-demand-factors tests; table values not machine-checked against the NEC text.",
    source: "src/modules/mep/demand-factors.ts",
  },
  {
    area: "protection-coordination",
    method: "Pairwise breaker selectivity screening (upstream/downstream rating ratio ≥ 1.6× = 'likely' for same-family thermal-magnetic MCCBs); breaking-capacity check Icu (and Ics) vs caller-supplied prospective fault current; chain audit source → load; panel-link audit against downstream main / largest branch breaker.",
    standard: "IEC 60947-2 selectivity tables (reference only — curves govern); IEC 60364-4-43 overcurrent coordination.",
    units: "A, kA.",
    assumptions: ["The 1.6× ratio is a screening rule of thumb for same-family thermal-magnetic MCCBs; it does not apply across device families, fuse/MCCB mixes, or electronic-trip units.", "Fault currents are caller-supplied (fault study / utility data)."],
    limitations: ["Can only say 'likely' or 'not demonstrated' — never guaranteed discrimination.", "No arc-flash, zone-selective, or earth-fault selectivity analysis.", "No source-impedance model: fault currents are never computed here."],
    validation: "unit-tested-only",
    validationNote: "Pinned by mep-protection-coordination tests; ratio rule is a documented heuristic, not a validated selectivity proof.",
    source: "src/modules/mep/protection-coordination.ts",
  },
  {
    area: "lighting",
    method: "Lumen method (average maintained illuminance from lamp lumens, utilisation and maintenance factors), point-by-point illuminance, spacing-to-mounting-height verification, lighting power density reporting.",
    standard: "Generic lumen-method practice; no code.",
    units: "lm, lx, W/m², m.",
    assumptions: ["Utilisation/maintenance factors are caller inputs or defaults.", "Room geometry is the idealised rectangular room of the lumen method."],
    limitations: ["Not a validated lighting design for any code (no IES/EN 12464 compliance claim).", "No glare (UGR) or daylight integration."],
    validation: "unit-tested-only",
    validationNote: "Pinned by mep-lighting tests on hand-computed rooms.",
    source: "src/modules/mep/lighting.ts",
  },
  {
    area: "insulation",
    method: "Radial steady-state conduction through the insulation cylinder (pipes) and flat-wall conduction (ducts); heat loss, surface temperature, condensation screening, procurement takeoff.",
    standard: "Generic steady-state conduction; no code.",
    units: "W/m, W/m², °C, mm.",
    assumptions: ["Steady state; constant material conductivity; ambient conditions are caller inputs."],
    limitations: ["No transient or thermal-bridging analysis.", "Condensation screening is a dew-point comparison, not a hygrothermal simulation."],
    validation: "unit-tested-only",
    validationNote: "Pinned by mep-insulation tests.",
    source: "src/modules/mep/insulation.ts",
  },
  {
    area: "mep-connectivity",
    method: "Geometry-derived connectivity: linear runs connect at their ends (within 0.12 m plan / 0.25 m vertical tolerance), fittings through centre + arm reach, equipment as a terminal that does not propagate; pairs found by a 2 m plan-grid index (exactly the old O(n²) scan, pruned). IFC imports reconstruct from IfcRelConnectsPorts / IfcRelNests port graphs where the file carries them.",
    standard: "None — geometric heuristic, not a standard.",
    units: "m.",
    assumptions: ["A run end landing on another run's body counts as connected even without a junction fitting.", "Authored elements carry no stored port-to-port edges for plain linear runs; family/equipment connectors are tracked by the MEP lifecycle and persist in the project snapshot."],
    limitations: ["No stored connector semantics for plain duct/pipe runs — connectivity is re-derived from geometry on every recompute.", "Tolerance-based: near-misses within 0.12 m connect, and a run 0.13 m short does not.", "Imported fragments without ports cannot be reconstructed (see ifc-reconstruction diagnostics)."],
    validation: "unit-tested-only",
    validationNote: "Pinned by mep-connectivity / mep-connectivity-index (property test vs brute force) / mep-ifc-reconstruction tests.",
    source: "src/modules/mep/connectivity.ts, src/modules/mep/ifc-reconstruction.ts",
  },
];

/** Look up the basis record for a calculation area, if one exists. */
export function calculationBasisFor(area: string): MepCalculationBasis | undefined {
  return MEP_CALCULATION_BASIS.find((b) => b.area === area);
}

/** Areas whose validation status is anything stronger than unit tests. */
export function validatedAreas(): MepCalculationBasis[] {
  return MEP_CALCULATION_BASIS.filter((b) => b.validation !== "unit-tested-only");
}
