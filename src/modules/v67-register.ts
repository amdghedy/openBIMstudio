/**
 * v67 module globals — the "Revit killer" engine package.
 *
 * Exposes the four new engineering engines on window.__obs* for the
 * console, ribbon, automation and AI tools:
 *
 *   __obsConstraints — numeric geometric constraint solver (walls/sketches)
 *   __obsStructural  — 2D frame FEM + steel/RC code checks
 *   __obsMepPressure — duct/pipe pressure-loss + worst-path hydraulics
 *   __obsAdaptive    — adaptive components: families, sweeps, patterns
 *
 * Pure engines: no DOM is touched here beyond global registration, so a
 * failure in any engine cannot break boot (the boot wrapper catches).
 */

import { ctx } from "../core/context";
import { solve, type Constraint, type SolverPoint, type SolveResult } from "./constraints/solver";
import {
  solveAndApply, type WallLike,
} from "./constraints";

import {
  solveFrame, memberDeflectionProfile,
  type FemModel, type FemResult,
} from "./analytical-model/fem";
import {
  checkSteel, checkRcBeam,
  type SteelCheckResult, type RcCheckResult,
} from "./analytical-model/checks";
import {
  STEEL_SECTIONS, findSection,
} from "./analytical-model/sections";

import {
  ductPressureDrop, pipePressureDrop, worstPath, classifyFrictionRate,
  type DuctSegment, type PipeSegment, type PressureNetwork, type PressureResult,
} from "./mep/pressure";

import {
  registerFamily, getFamily, listFamilies, instantiate, sweepProfile,
  meshVolume, profileArea, divideLine, divideArc, repeatAlongPath, pathLength,
  type AdaptiveFamily, type AdaptiveInstance, type IndexedMesh, type Pt3,
} from "./adaptive";

type Any = Record<string, any>;
const w = window as unknown as Any;

function features(): Any {
  const c = ctx as Any;
  if (!c.features) c.features = {};
  return c.features;
}

function wallsFromAuthoring(): WallLike[] {
  const c = ctx as Any;
  const auth = c.features?.authoring ?? w.__obsAuthoring ?? null;
  if (!auth) return [];
  try {
    if (typeof auth.getElements === "function") {
      return (auth.getElements() ?? []).filter((el: Any) => el?.type === "wall" && el?.params?.start && el?.params?.end);
    }
    if (Array.isArray(auth.elements)) {
      return auth.elements.filter((el: Any) => el?.type === "wall" && el?.params?.start && el?.params?.end);
    }
  } catch { /* ignore */ }
  return [];
}

function commitWalls(): void {
  const c = ctx as Any;
  const auth = c.features?.authoring ?? w.__obsAuthoring ?? null;
  try {
    if (typeof auth?.rebuildAuthored === "function") auth.rebuildAuthored();
    else if (typeof auth?.rebuild === "function") auth.rebuild();
    if (typeof auth?.markAuthoringDirty === "function") auth.markAuthoringDirty();
  } catch { /* ignore */ }
  try {
    window.dispatchEvent(new CustomEvent("obs:authoring-changed", { detail: { reason: "v67-constraints" } }));
  } catch { /* ignore */ }
}

export function setupV67Engines(): void {
  // ── 1. Constraint solver ────────────────────────────────────────────────
  // NOTE: parametric-constraints registers `__obsConstraints` first
  // (lock/equality/align manager). v67 must MERGE the numeric solver into
  // that object — overwriting it broke the ribbon Lock Dim / Equality
  // buttons, which call `.lock()` / `.equality()` at runtime.
  const existingConstraints = (w.__obsConstraints ?? {}) as Any;
  const constraintsApi = {
    ...existingConstraints,
    /** Solve an ad-hoc point/constraint system (returns solved points). */
    solve: (points: SolverPoint[], cons: Constraint[]): { result: SolveResult; points: SolverPoint[] } => {
      const pts = points.map((p) => ({ ...p }));
      const result = solve(pts, cons);
      return { result, points: pts };
    },
    /** Solve the current model's walls so coincident ends heal and lengths hold. */
    solveWalls: (pinnedIds: string[] = []): { changed: number; result: SolveResult } => {
      const walls = wallsFromAuthoring();
      if (!walls.length) return { changed: 0, result: { status: "converged", iterations: 0, maxResidual: 0, dof: 0, ms: 0 } };
      const out = solveAndApply(walls, pinnedIds);
      if (out.changed) commitWalls();
      return { changed: out.changed, result: out.result };
    },
  };
  w.__obsConstraints = constraintsApi;
  features().constraintSolverV67 = constraintsApi;

  // ── 2. Structural engine ────────────────────────────────────────────────
  const structuralApi = {
    solve: (model: FemModel): FemResult => solveFrame(model),
    deflectionProfile: memberDeflectionProfile,
    checkSteel,
    checkRcBeam,
    sections: STEEL_SECTIONS,
    findSection,
  };
  w.__obsStructural = structuralApi;
  features().structuralEngine = structuralApi;

  // ── 3. MEP pressure engine ──────────────────────────────────────────────
  const mepPressureApi = {
    duct: ductPressureDrop,
    pipe: pipePressureDrop,
    worstPath,
    classify: classifyFrictionRate,
  };
  w.__obsMepPressure = mepPressureApi;
  const existingMep = (w.__obsMep ?? {}) as Any;
  w.__obsMep = { ...existingMep, pressure: mepPressureApi };

  // ── 4. Adaptive components ──────────────────────────────────────────────
  const adaptiveApi = {
    registerFamily,
    getFamily,
    listFamilies,
    instantiate,
    sweep: sweepProfile,
    volume: meshVolume,
    profileArea,
    divideLine,
    divideArc,
    repeatAlongPath,
    pathLength,
  };
  w.__obsAdaptive = adaptiveApi;
  features().adaptiveComponents = adaptiveApi;

  console.log(
    "[obs] v67 engines registered: __obsConstraints (numeric solver), __obsStructural (FEM + code checks), __obsMepPressure (hydraulics), __obsAdaptive (adaptive components)",
  );
}
