/**
 * MEP pressure-loss engineering — duct and pipe hydraulics.
 *
 * Complements sizing.ts (which picks standard sizes from flow/velocity)
 * with the physics Revit's system inspector reports: friction pressure
 * drop, fitting losses, and the available-pressure budget along the
 * worst path of a distribution tree.
 *
 * Methods:
 *   - Darcy–Weisbach: Δp = f · (L/Dh) · (ρv²/2)
 *   - Colebrook–White implicit friction factor, solved by Newton
 *     iteration (seeded by the Swamee–Jain explicit formula).
 *   - Laminar fallback f = 64/Re below Re = 2300.
 *   - Fittings via loss coefficients: Δp = ΣC · (ρv²/2).
 *   - Water systems report both pressure (Pa) and head (m).
 *
 * Fluid properties at 20 °C, 1 atm: air ρ=1.204 kg/m³, μ=1.81e-5 Pa·s;
 * water ρ=998.2 kg/m³, μ=1.002e-3 Pa·s.
 *
 * Fitting loss coefficients are typical ASHRAE/IDHA values for stock
 * fittings — approximate by design, not a substitute for manufacturer
 * data.
 *
 * Pure module: no DOM, no three.js. Safe to unit-test in Node.
 */

/** Typical fitting loss coefficients (C), applied to the velocity head. */
export type FittingKind =
  | "elbow-90-radius"   // 90° smooth radius elbow, r/D ≈ 1
  | "elbow-90-miter"    // square-throat mitered 90°
  | "elbow-45"          // 45° elbow
  | "tee-run"           // tee, straight through
  | "tee-branch"        // tee, into the branch
  | "reducer"           // gradual transition/concentric reducer
  | "expansion"         // abrupt expansion
  | "entrance"          // duct/plenum entrance
  | "exit"              // discharge to room
  | "damper"            // wide-open balancing damper
  | "diffuser"          // supply diffuser boot
  | "check-valve"       // water check valve (swing)
  | "gate-valve-open"   // water gate valve, wide open
  | "butterfly-valve";  // water butterfly valve, open

export const FITTING_C: Record<FittingKind, number> = {
  "elbow-90-radius": 0.22,
  "elbow-90-miter": 1.2,
  "elbow-45": 0.12,
  "tee-run": 0.1,
  "tee-branch": 1.0,
  "reducer": 0.15,
  "expansion": 0.6,
  "entrance": 0.5,
  "exit": 1.0,
  "damper": 0.2,
  "diffuser": 0.8,
  "check-valve": 2.0,
  "gate-valve-open": 0.15,
  "butterfly-valve": 0.5,
};

/** Surface roughness ε (m) for common materials. */
export const ROUGHNESS = {
  "galvanized-steel": 0.00015,
  "spiral-duct": 0.00012,
  "flex-duct": 0.003,
  "fiberglass-board": 0.0009,
  "pvc": 0.0000015,
  "copper": 0.0000015,
  "steel-pipe": 0.000045,
  "pex": 0.000007,
  "concrete": 0.003,
} as const;
export type RoughnessMaterial = keyof typeof ROUGHNESS;

/** Fluid property sets. */
export const FLUID = {
  air: { rho: 1.204, mu: 1.81e-5 },
  water: { rho: 998.2, mu: 1.002e-3 },
} as const;

export interface SegmentFitting {
  kind: FittingKind;
  count?: number;
}

export interface DuctSegment {
  /** Segment length (m). */
  length: number;
  /** Volumetric flow (m³/s). */
  flow: number;
  /** Round duct inner diameter (m). Provide diameter or width+height. */
  diameter?: number;
  /** Rectangular duct width (m). */
  width?: number;
  /** Rectangular duct height (m). */
  height?: number;
  /** Wall material (default galvanized-steel). */
  material?: RoughnessMaterial;
  /** Explicit roughness (m) — overrides material. */
  roughness?: number;
  /** Air density override (kg/m³), e.g. for process air. */
  density?: number;
  /** Air viscosity override (Pa·s). */
  viscosity?: number;
  fittings?: SegmentFitting[];
}

export interface PipeSegment {
  /** Segment length (m). */
  length: number;
  /** Volumetric flow (m³/s). */
  flow: number;
  /** Pipe inner diameter (m). */
  diameter: number;
  material?: RoughnessMaterial;
  roughness?: number;
  /** Fluid density (kg/m³), default water. */
  density?: number;
  /** Fluid viscosity (Pa·s), default water. */
  viscosity?: number;
  fittings?: SegmentFitting[];
}

export interface PressureResult {
  /** Velocity (m/s). */
  velocity: number;
  /** Hydraulic diameter (m). */
  hydraulicDiameter: number;
  /** Reynolds number. */
  reynolds: number;
  /** Darcy friction factor. */
  frictionFactor: number;
  /** Straight-pipe friction drop (Pa). */
  dpFriction: number;
  /** Fitting losses (Pa). */
  dpFittings: number;
  /** Total drop (Pa). */
  dpTotal: number;
  /** Specific friction rate (Pa/m) — what friction charts print. */
  frictionRate: number;
  /** Head loss (m of fluid), for water systems. */
  headLoss: number;
}

/** Hydraulic diameter of a duct cross-section (m). */
export function hydraulicDiameter(d: Pick<DuctSegment, "diameter" | "width" | "height">): number {
  if (d.diameter && d.diameter > 0) return d.diameter;
  if (d.width && d.height && d.width > 0 && d.height > 0) {
    return (2 * d.width * d.height) / (d.width + d.height);
  }
  throw new Error("duct segment needs diameter or width+height");
}

/** Colebrook–White friction factor via Newton on x = 1/√f. */
export function colebrook(reynolds: number, relRough: number): number {
  if (reynolds < 2300) return 64 / Math.max(reynolds, 1e-6); // laminar
  // Swamee–Jain seed.
  const f0 = 0.25 / Math.pow(
    Math.log10(relRough / 3.7 + 5.74 / Math.pow(reynolds, 0.9)), 2);
  let x = 1 / Math.sqrt(Math.max(f0, 1e-6));
  for (let i = 0; i < 30; i++) {
    const g = x + 2 * Math.log10(relRough / 3.7 + 2.51 * x / reynolds);
    const dg = 1 + (2 * 2.51 / reynolds) / (Math.LN10 * (relRough / 3.7 + 2.51 * x / reynolds));
    const step = g / dg;
    x -= step;
    if (Math.abs(step) < 1e-12) break;
  }
  const f = 1 / (x * x);
  return Math.min(Math.max(f, 64 / reynolds), 0.2);
}

/** Compute the pressure drop of a duct segment (air). */
export function ductPressureDrop(seg: DuctSegment): PressureResult {
  const Dh = hydraulicDiameter(seg);
  const rho = seg.density ?? FLUID.air.rho;
  const mu = seg.viscosity ?? FLUID.air.mu;
  const area = areaOf(seg);
  const velocity = seg.flow / area;
  const reynolds = (rho * velocity * Dh) / mu;
  const eps = seg.roughness ?? ROUGHNESS[seg.material ?? "galvanized-steel"];
  const f = colebrook(reynolds, eps / Dh);
  const vHead = (rho * velocity * velocity) / 2;
  const dpFriction = f * (seg.length / Dh) * vHead;
  let cSum = 0;
  for (const fit of seg.fittings ?? []) cSum += FITTING_C[fit.kind] * (fit.count ?? 1);
  const dpFittings = cSum * vHead;
  return {
    velocity,
    hydraulicDiameter: Dh,
    reynolds,
    frictionFactor: f,
    dpFriction,
    dpFittings,
    dpTotal: dpFriction + dpFittings,
    frictionRate: seg.length > 0 ? dpFriction / seg.length : 0,
    headLoss: dpTotal0(dpFriction + dpFittings, rho),
  };
}

/** Compute the pressure/head loss of a pipe segment (water by default). */
export function pipePressureDrop(seg: PipeSegment): PressureResult {
  const Dh = seg.diameter;
  const rho = seg.density ?? FLUID.water.rho;
  const mu = seg.viscosity ?? FLUID.water.mu;
  const area = (Math.PI * Dh * Dh) / 4;
  const velocity = seg.flow / area;
  const reynolds = (rho * velocity * Dh) / mu;
  const eps = seg.roughness ?? ROUGHNESS[seg.material ?? "steel-pipe"];
  const f = colebrook(reynolds, eps / Dh);
  const vHead = (rho * velocity * velocity) / 2;
  const dpFriction = f * (seg.length / Dh) * vHead;
  let cSum = 0;
  for (const fit of seg.fittings ?? []) cSum += FITTING_C[fit.kind] * (fit.count ?? 1);
  const dpFittings = cSum * vHead;
  return {
    velocity,
    hydraulicDiameter: Dh,
    reynolds,
    frictionFactor: f,
    dpFriction,
    dpFittings,
    dpTotal: dpFriction + dpFittings,
    frictionRate: seg.length > 0 ? dpFriction / seg.length : 0,
    headLoss: (dpFriction + dpFittings) / (rho * 9.80665),
  };
}

function areaOf(seg: DuctSegment): number {
  if (seg.diameter && seg.diameter > 0) return (Math.PI * seg.diameter * seg.diameter) / 4;
  if (seg.width && seg.height) return seg.width * seg.height;
  throw new Error("duct segment needs diameter or width+height");
}

function dpTotal0(dp: number, rho: number): number {
  return dp / (rho * 9.80665);
}

// ── Network worst-path analysis ─────────────────────────────────────────────

export interface PressureEdge {
  id: string;
  from: string;
  to: string;
  /** Total pressure drop along this edge (Pa). */
  dp: number;
  /** Human label for reports. */
  label?: string;
}

export interface PressureNetwork {
  edges: PressureEdge[];
  /** Node id where the fan/pump pressurises the system. */
  source: string;
  /** Terminal nodes (defaults: any node with no outgoing edge). */
  sinks?: string[];
}

export interface WorstPathResult {
  /** Edge ids along the critical path, source → sink. */
  edgeIds: string[];
  /** Node ids along the path. */
  nodes: string[];
  /** Total pressure drop (Pa) the fan/pump must overcome. */
  totalDp: number;
}

/**
 * Find the critical (highest total drop) path from source to any sink.
 * Distribution trees are acyclic in practice; DFS guards against cycles
 * with a visited set.
 */
export function worstPath(net: PressureNetwork): WorstPathResult {
  const out = new Map<string, PressureEdge[]>();
  for (const e of net.edges) {
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e);
  }
  const sinks = new Set(
    net.sinks ?? net.edges
      .filter((e) => !net.edges.some((o) => o.from === e.to))
      .map((e) => e.to),
  );

  let best: WorstPathResult = { edgeIds: [], nodes: [net.source], totalDp: 0 };
  const visited = new Set<string>([net.source]);

  const dfs = (node: string, edgeIds: string[], nodes: string[], dp: number) => {
    if (sinks.has(node) && dp > best.totalDp) {
      best = { edgeIds: [...edgeIds], nodes: [...nodes], totalDp: dp };
    }
    for (const e of out.get(node) ?? []) {
      if (visited.has(e.to)) continue; // cycle guard
      visited.add(e.to);
      edgeIds.push(e.id);
      nodes.push(e.to);
      dfs(e.to, edgeIds, nodes, dp + e.dp);
      edgeIds.pop();
      nodes.pop();
      visited.delete(e.to);
    }
  };
  dfs(net.source, [], [net.source], 0);
  return best;
}

/**
 * Classify a duct sizing against a friction budget — the quick health
 * metric designers read off the ASHRAE friction chart.
 */
export function classifyFrictionRate(rate: number): "low" | "recommended" | "high" {
  if (rate < 0.4) return "low";
  if (rate <= 1.0) return "recommended"; // ASHRAE low-velocity design band
  return "high";
}
